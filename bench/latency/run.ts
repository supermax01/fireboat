// bench:latency -- --campaign <c> --dataset <d> --arm FB[,W,...] --slot <s> [--reps 30] [--warmups 5] [--score-only]
// Latency protocol. Per arm: ONE server session behind the slot's recording proxy; cold start (spawn to the
// initialize result), then rounds of the dataset's 10 probes (latency/probes.ts), each round in rank-hash order:
// 5 warm-up rounds (discarded), then 30 timed rounds. The session's very first call is reported on its own: it carries
// once-per-session work (fireboat fetches and processes the backend's CapabilityStatement on its first call).
// Writes RESULTS/latency/<c>/: probes-<dataset>.json, calls/<arm>__<dataset>.jsonl, sessions.jsonl, summary.json,
// report.md, proxy-s<slot>.jsonl; and manifests/latency-<c>-<dataset>-<arms>-s<slot>.json. Descriptive only.
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { COMMON_OPTIONS, datasetArg } from '../lib/cli.js';
import { DEV_SEED_HEX } from '../lib/hash.js';
import { appendJsonl, readJsonl } from '../lib/jsonl.js';
import { proxyBase, results, tmpDir, type DatasetId } from '../lib/paths.js';
import type { ArmId, CallRecord, ToolCall } from '../lib/types.js';
import { assertActiveDataset } from '../infra/active.js';
import { startRecordingProxy, startTokenShim } from '../infra/proxy.js';
import { makeAdapter, pageSizeFor } from '../servers/adapters.js';
import { ARMS, DEFAULT_ARMS, SCRIPTED_ARMS, armVersions, availableArms, type Refusal } from '../servers/arms.js';
import { benchGit } from '../servers/install.js';
import { launch } from '../servers/launch.js';
import { isMedplumArm } from '../servers/medplum.js';
import { isHealthLakeArm } from '../servers/healthlake.js';
import { parserFor } from '../servers/parsers.js';
import { verifyServedCounts } from '../run/verify.js';
import { buildProbes, roundOrder, type LatencyProbe, type ProbeSet } from './probes.js';
import { latencyReport } from './report.js';
import { bootstrap3, stat3, type Interval, type Stat3 } from './stats.js';

const SANDBOX = true;
const CALL_TIMEOUT_MS = 120_000;
const isRefusal = (x: unknown): x is Refusal => typeof x === 'object' && x !== null && 'refused' in x;

export interface LatencyCall {
  schema: 'fbbench.latency-call/1';
  arm: ArmId; dataset: string; round: number; position: number; seq: number; probe_id: string;
  phase: 'first' | 'warmup' | 'timed';
  tool: string; latency_ms: number; bytes: CallRecord['bytes']; is_error: boolean | null; error: CallRecord['error'];
  items: number; refused: string | null;
}

export interface LatencySession {
  schema: 'fbbench.latency-session/1';
  campaign: string; arm: ArmId; dataset: string; slot: number; patient_id: string; started_at: string; wall_ms: number;
  cold_start_ms: number | null; tools_list_bytes: number; instructions_bytes: number; protocol_version: string | null;
  exit: { code: number | null; signal: string | null } | null; warmups: number; reps: number; probes: number;
  refused_probes: { probe_id: string; reason: string }[]; start_error: string | null; versions: Record<string, unknown>;
}

const callsPath = (campaign: string, arm: ArmId, dataset: DatasetId) => join(results.latency(campaign), 'calls', `${arm}__${dataset}.jsonl`);

async function runSession(o: { campaign: string; dataset: DatasetId; arm: ArmId; slot: number; set: ProbeSet; warmups: number; reps: number; git: ReturnType<typeof benchGit>; tmpRoot: string; proxy: Awaited<ReturnType<typeof startRecordingProxy>> }): Promise<{ session: LatencySession; calls: LatencyCall[] }> {
  const runId = `${o.arm}__latency__${o.dataset}`;
  const runDir = join(results.latency(o.campaign), 'runs', runId);
  rmSync(runDir, { recursive: true, force: true });
  const runTmp = join(o.tmpRoot, 't');
  rmSync(runTmp, { recursive: true, force: true });
  o.proxy.setRunId(runId);
  const started = new Date();
  const t0 = performance.now();
  const session: LatencySession = {
    schema: 'fbbench.latency-session/1', campaign: o.campaign, arm: o.arm, dataset: o.dataset, slot: o.slot, patient_id: o.set.patient_id,
    started_at: started.toISOString(), wall_ms: 0, cold_start_ms: null, tools_list_bytes: 0, instructions_bytes: 0, protocol_version: null, exit: null,
    warmups: o.warmups, reps: o.reps, probes: o.set.probes.length, refused_probes: [], start_error: null,
    versions: { ...o.git, ...armVersions(o.arm) },
  };
  const calls: LatencyCall[] = [];
  try {
    const s = await launch({ arm: o.arm, dataset: o.dataset, patientId: o.set.patient_id, slot: o.slot, cell: 'default', fhirBaseUrl: proxyBase(o.slot), runDir, runTmp }, { sandbox: SANDBOX });
    session.cold_start_ms = s.coldStartMs;
    session.tools_list_bytes = s.toolsListBytes;
    session.instructions_bytes = s.instructionsBytes;
    session.protocol_version = s.protocolVersion;
    try {
      const adapter = makeAdapter(o.arm, s.tools, { cell: 'default', patientId: o.set.patient_id });
      const parser = parserFor(o.arm);
      const pageSize = pageSizeFor(o.arm);
      const callFor = new Map<string, ToolCall>();
      for (const p of o.set.probes) {
        const tc = p.op.op === 'read' ? adapter.read(p.op.type, p.op.id) : (() => { const r = adapter.search(p.op.type, p.op.params, pageSize); return isRefusal(r) ? r : r.call; })();
        if (isRefusal(tc)) session.refused_probes.push({ probe_id: p.id, reason: tc.refused });
        else callFor.set(p.id, tc);
      }
      let seq = 0;
      for (let round = 0; round < o.warmups + o.reps; round++) {
        const order = roundOrder(o.set.probes, DEV_SEED_HEX, o.dataset, round);
        for (const [position, p] of order.entries()) {
          const tc = callFor.get(p.id);
          if (!tc) continue;
          const out = await s.call(tc, CALL_TIMEOUT_MS);
          const parsed = parser.parse({ seq, op_index: 0, op: p.op.op, ...out });
          calls.push({
            schema: 'fbbench.latency-call/1', arm: o.arm, dataset: o.dataset, round, position, seq, probe_id: p.id,
            phase: seq === 0 ? 'first' : round < o.warmups ? 'warmup' : 'timed', tool: out.tool, latency_ms: out.latency_ms, bytes: out.bytes,
            is_error: out.is_error, error: out.error, items: parsed.items.length, refused: parsed.refused ? `${parsed.refused.code}: ${parsed.refused.message}`.slice(0, 200) : null,
          });
          seq++;
        }
      }
    } finally {
      session.exit = await s.close();
    }
  } catch (e) {
    session.start_error = String((e as Error).message).slice(0, 2000);
  }
  o.proxy.setRunId('idle');
  session.wall_ms = Math.round(performance.now() - t0);
  rmSync(runTmp, { recursive: true, force: true });
  return { session, calls };
}

export interface ArmLatency {
  arm: string; dataset: string; patient_id: string; warmups: number; reps: number;
  cold_start_ms: number | null; tools_list_bytes: number;
  first_call: { probe_id: string; label: string; latency_ms: number; probe_warm_median_ms: number | null; excess_ms: number | null } | null;
  warm: Stat3 & { n: number; ci95: Record<keyof Stat3, Interval> };
  per_probe: { probe_id: string; label: string; n: number; median: number | null; p95: number | null; max: number | null; errors: number; items_first_timed: number | null; result_bytes_median: number | null }[];
  /** Timed calls in total, and those that errored (tool error, refusal or transport); warm statistics use the others. */
  timed_calls: number; timed_errors: number;
  errors: number; first_error: { seq: number; round: number; probe_id: string; reason: string } | null;
  refused_probes: { probe_id: string; reason: string }[]; start_error: string | null;
}

const failed = (c: LatencyCall) => Boolean(c.error || c.is_error || c.refused);

export function summariseArm(session: LatencySession, calls: readonly LatencyCall[], set: ProbeSet, seedHex = DEV_SEED_HEX): ArmLatency {
  const timedAll = calls.filter(c => c.phase === 'timed');
  const timed = timedAll.filter(c => !failed(c));
  const groups = set.probes.map(p => timed.filter(c => c.probe_id === p.id).map(c => c.latency_ms));
  const pooled = groups.flat();
  const first = calls.find(c => c.phase === 'first') ?? null;
  const per_probe = set.probes.map((p, i) => {
    const cs = timed.filter(c => c.probe_id === p.id);
    const s = stat3(groups[i]!);
    const rb = cs.map(c => c.bytes?.result ?? 0);
    return { probe_id: p.id, label: p.label, n: cs.length, ...s, errors: timedAll.filter(c => c.probe_id === p.id && failed(c)).length, items_first_timed: cs[0]?.items ?? null, result_bytes_median: stat3(rb).median };
  });
  const firstMedian = first ? per_probe.find(p => p.probe_id === first.probe_id)?.median ?? null : null;
  return {
    arm: session.arm, dataset: session.dataset, patient_id: session.patient_id, warmups: session.warmups, reps: session.reps, cold_start_ms: session.cold_start_ms, tools_list_bytes: session.tools_list_bytes,
    first_call: first ? { probe_id: first.probe_id, label: set.probes.find(p => p.id === first.probe_id)?.label ?? '', latency_ms: first.latency_ms, probe_warm_median_ms: firstMedian, excess_ms: firstMedian === null ? null : Math.round((first.latency_ms - firstMedian) * 1000) / 1000 } : null,
    warm: { n: pooled.length, ...stat3(pooled), ci95: bootstrap3(groups, { seedHex, label: `latency-${session.dataset}-${session.arm}` }) },
    per_probe, timed_calls: timedAll.length, timed_errors: timedAll.length - timed.length, errors: calls.filter(failed).length,
    first_error: (() => { const e = calls.find(failed); return e ? { seq: e.seq, round: e.round, probe_id: e.probe_id, reason: e.refused ?? e.error?.message ?? 'isError' } : null; })(),
    refused_probes: session.refused_probes, start_error: session.start_error,
  };
}

/** Recomputes summary.json and report.md from the stored sessions and calls. */
export async function scoreLatency(campaign: string): Promise<{ summaryPath: string; reportPath: string }> {
  const dir = results.latency(campaign);
  const sessions = new Map<string, LatencySession>();
  for await (const r of readJsonl(join(dir, 'sessions.jsonl'))) { const s = r as unknown as LatencySession; sessions.set(`${s.arm}__${s.dataset}`, s); }
  const arms: ArmLatency[] = [];
  const probeSets: Record<string, ProbeSet> = {};
  for (const f of readdirSync(dir).filter(n => /^probes-.+\.json$/.test(n))) {
    const set = JSON.parse(await readFile(join(dir, f), 'utf8')) as ProbeSet; // our own file
    probeSets[set.dataset] = set;
  }
  for (const [key, s] of sessions) {
    const set = probeSets[s.dataset];
    if (!set) continue;
    const calls: LatencyCall[] = [];
    const p = join(dir, 'calls', `${key}.jsonl`);
    if (existsSync(p)) for await (const r of readJsonl(p)) calls.push(JSON.parse(JSON.stringify(r)) as LatencyCall);
    arms.push(summariseArm(s, calls, set));
  }
  const summary = { schema: 'fbbench.latency-summary/1', campaign, generated_at: new Date().toISOString(), ...benchGit(), seed: { kind: 'dev', hex: DEV_SEED_HEX }, probe_sets: probeSets, arms };
  const summaryPath = join(dir, 'summary.json');
  await writeFile(summaryPath, JSON.stringify(summary, null, 2) + '\n');
  const reportPath = join(dir, 'report.md');
  await writeFile(reportPath, latencyReport(arms, probeSets, { campaign, raw: dir }).join('\n') + '\n');
  return { summaryPath, reportPath };
}

async function main() {
  const { values } = parseArgs({ options: { ...COMMON_OPTIONS, reps: { type: 'string' }, warmups: { type: 'string' }, 'score-only': { type: 'boolean' }, 'skip-verify': { type: 'boolean' } }, strict: true });
  const campaign = values.campaign ?? '';
  if (!/^[a-z0-9][a-z0-9._-]{0,60}$/.test(campaign)) throw new Error('--campaign must match ^[a-z0-9][a-z0-9._-]{0,60}$');
  if (values['score-only']) { const r = await scoreLatency(campaign); process.stdout.write(`${r.summaryPath}\n${r.reportPath}\n`); return; }
  const dataset = datasetArg(values.dataset);
  const requested = (values.arm ?? DEFAULT_ARMS.join(',')).split(',') as ArmId[];
  for (const a of requested) if (!SCRIPTED_ARMS.includes(a)) throw new Error(`arm ${a} is not a scripted arm`);
  const arms = availableArms(requested);
  if (arms.length === 0) { process.stdout.write('no available arm to run\n'); return; }
  for (const a of arms) if (isMedplumArm(a) || isHealthLakeArm(a)) throw new Error(`arm ${a} runs against ${isMedplumArm(a) ? 'Medplum' : 'HealthLake'}; this runner drives the HAPI backend only`);
  const slot = Number(values.slot ?? '0');
  const reps = Number(values.reps ?? '30');
  const warmups = Number(values.warmups ?? '5');
  if (!(Number.isInteger(reps) && reps >= 1 && Number.isInteger(warmups) && warmups >= 0)) throw new Error('bad --reps or --warmups');
  const dir = results.latency(campaign);
  for (const a of arms) if (existsSync(callsPath(campaign, a, dataset))) throw new Error(`${callsPath(campaign, a, dataset)} exists: use a new campaign (results are never overwritten)`);

  await assertActiveDataset(dataset);
  const verify = values['skip-verify'] ? null : await verifyServedCounts(dataset);
  if (verify && !verify.ok) throw new Error(`HAPI counts do not match converted/${dataset}`);
  mkdirSync(join(dir, 'calls'), { recursive: true });
  const probesFile = join(dir, `probes-${dataset}.json`);
  const set = existsSync(probesFile) ? JSON.parse(await readFile(probesFile, 'utf8')) as ProbeSet : await buildProbes(dataset, DEV_SEED_HEX);
  if (!existsSync(probesFile)) await writeFile(probesFile, JSON.stringify(set, null, 2) + '\n');
  const startedAt = new Date().toISOString();
  const git = benchGit();
  const tmpRoot = tmpDir(`latency-s${slot}`);
  const proxy = await startRecordingProxy({ slot, runId: 'idle', logPath: join(dir, `proxy-s${slot}.jsonl`) });
  const shim = await startTokenShim({ slot });
  try {
    for (const arm of arms) {
      const { session, calls } = await runSession({ campaign, dataset, arm, slot, set, warmups, reps, git, tmpRoot, proxy });
      await appendJsonl(callsPath(campaign, arm, dataset), calls);
      await appendJsonl(join(dir, 'sessions.jsonl'), [session]);
      process.stdout.write(`${arm}: cold start ${session.cold_start_ms} ms, ${calls.length} calls${session.start_error ? `, start failed: ${session.start_error}` : ''}\n`);
    }
  } finally {
    await shim.close();
    await proxy.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  }
  mkdirSync(results.manifests, { recursive: true });
  const manifestPath = join(results.manifests, `latency-${campaign}-${dataset}-${arms.join('+')}-s${slot}.json`);
  await writeFile(manifestPath, JSON.stringify({
    schema: 'fbbench.manifest.latency/1', campaign, dataset, arms, slot, reps, warmups, argv: process.argv.slice(2), started_at: startedAt,
    finished_at: new Date().toISOString(), node: process.version, ...git, probes: set, arm_pins: Object.fromEntries(arms.map(a => [a, ARMS[a].pin])),
    page_sizes: Object.fromEntries(arms.map(a => [a, pageSizeFor(a)])), fhir_base_url: proxyBase(slot), served_counts: verify,
  }, null, 2) + '\n');
  const r = await scoreLatency(campaign);
  process.stdout.write(`${manifestPath}\n${r.summaryPath}\n${r.reportPath}\n`);
}

export type { LatencyProbe };
if (import.meta.url === `file://${process.argv[1]}`) await main();
