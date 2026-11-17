// bench:fuzz -- --campaign <c> --dataset <d> --arm FB[,W,...] --slot <s> [--only F001,...] [--limit n] [--score-only] [--skip-verify]
// Robustness fuzz corpus (fuzz/corpus.json, 100 cases) through each arm's adapter. One fresh server per case,
// behind the slot's recording proxy, whose upstream is the fuzz mock backend (adversarial numbers; everything else goes
// to HAPI unchanged); the slot's canary listener records any connection. Writes RESULTS/fuzz/<c>/:
//   records/<arm>__<dataset>.jsonl   raw FuzzRunRecords (resumable by run_id)
//   proxy-s<slot>.jsonl, canary-s<slot>.jsonl, runs/<run_id>/stderr.txt
//   scores.jsonl, summary.json, report.md, rating-sheet.jsonl (blinded), rating-key.json
// and manifests/fuzz-<c>-<dataset>-<arms>-s<slot>.json.
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { open, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { COMMON_OPTIONS, datasetArg } from '../lib/cli.js';
import { DEV_SEED_HEX, rankHash } from '../lib/hash.js';
import { appendJsonl, readJsonl } from '../lib/jsonl.js';
import { knownPatient, proxyBase, results, slotPorts, tmpDir, type DatasetId } from '../lib/paths.js';
import type { ArmId } from '../lib/types.js';
import { assertActiveDataset } from '../infra/active.js';
import { startRecordingProxy, startTokenShim, type ProxyHandle } from '../infra/proxy.js';
import { makeAdapter, pageSizeFor } from '../servers/adapters.js';
import { ARMS, DEFAULT_ARMS, SCRIPTED_ARMS, armVersions, availableArms } from '../servers/arms.js';
import { benchGit } from '../servers/install.js';
import { launch } from '../servers/launch.js';
import { isMedplumArm } from '../servers/medplum.js';
import { isHealthLakeArm } from '../servers/healthlake.js';
import { parserFor } from '../servers/parsers.js';
import { verifyServedCounts } from '../run/verify.js';
import { canaryUrl, fill, loadCorpus, type Corpus, type FuzzCase } from './corpus.js';
import { executeCase, type Caller } from './execute.js';
import { startCanary, startMockBackend, type CanaryHandle } from './mock.js';
import { fuzzReport } from './report.js';
import { classify, summarise, type FuzzRunRecord, type FuzzScore, type UpstreamRequest } from './score.js';

const SANDBOX = true;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export const fuzzShard = (campaign: string, arm: ArmId, dataset: DatasetId) => join(results.fuzz(campaign), 'records', `${arm}__${dataset}.jsonl`);
export const fuzzRunId = (arm: ArmId, dataset: DatasetId, caseId: string) => `${arm}__fuzz__${dataset}__${caseId}`;

/** Another patient of the dataset, chosen by the rank hash (never the run patient). */
async function otherPatient(dataset: DatasetId, patient: string): Promise<string> {
  const list = JSON.parse(await readFile(join(results.converted(dataset), 'patients.json'), 'utf8')) as { patient_id: string }[]; // our own file
  const ranked = list.map(p => p.patient_id).filter(p => p !== patient)
    .map(p => ({ p, h: rankHash('scripted', DEV_SEED_HEX, 'fuzz-other-patient', p) })).sort((a, b) => (a.h < b.h ? -1 : 1));
  if (!ranked.length) throw new Error(`${dataset}: no second patient`);
  return ranked[0]!.p;
}

async function doneIds(path: string): Promise<Set<string>> {
  const done = new Set<string>();
  if (!existsSync(path)) return done;
  for await (const r of readJsonl(path)) {
    const rec = r as unknown as { run_id: string; server: { start_error: string | null } };
    if (rec.server.start_error) done.delete(rec.run_id); else done.add(rec.run_id);
  }
  return done;
}

interface ProxyRec { run_id: string; seq: number; method: string; path: string; status: number; blocked: boolean }

async function proxyRecords(path: string, offset: number, runId: string): Promise<ProxyRec[]> {
  if (!existsSync(path)) return [];
  const size = statSync(path).size;
  if (size <= offset) return [];
  const fh = await open(path, 'r');
  const buf = Buffer.alloc(size - offset);
  await fh.read(buf, 0, buf.length, offset);
  await fh.close();
  return buf.toString('utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as ProxyRec).filter(r => r.run_id === runId); // our own log
}

interface RunCtx {
  campaign: string; dataset: DatasetId; arm: ArmId; slot: number; patient: string; other: string; corpus: Corpus;
  proxy: ProxyHandle; proxyLog: string; canary: CanaryHandle; tmpRoot: string; git: ReturnType<typeof benchGit>; pageSize: number;
}

async function runCase(c: RunCtx, raw: FuzzCase): Promise<FuzzRunRecord> {
  const runId = fuzzRunId(c.arm, c.dataset, raw.id);
  const vars = { patient: c.patient, other_patient: c.other, canary_port: slotPorts(c.slot).canary, proxy: proxyBase(c.slot), case: raw.id };
  const k = fill(raw, vars);
  const runDir = join(results.fuzz(c.campaign), 'runs', runId);
  rmSync(runDir, { recursive: true, force: true });
  const runTmp = join(c.tmpRoot, 't');
  rmSync(runTmp, { recursive: true, force: true });
  const ctx = { arm: c.arm, dataset: c.dataset, patientId: c.patient, slot: c.slot, cell: 'default' as const, fhirBaseUrl: proxyBase(c.slot), runDir, runTmp };
  const stderrPath = join(runDir, 'stderr.txt');
  const logOffset = existsSync(c.proxyLog) ? statSync(c.proxyLog).size : 0;
  c.proxy.setRunId(runId);
  const startedAt = new Date();
  const t0 = performance.now();
  const record: FuzzRunRecord = {
    schema: 'fbbench.fuzz-run/1', campaign: c.campaign, run_id: runId, arm: c.arm, dataset: c.dataset, case_id: k.id, category: k.category,
    kind: k.kind, expect: k.expect, malformed_mcp: k.kind === 'mutate' && k.malformed_mcp, lexeme: k.kind === 'number' ? k.lexeme : null,
    number_id: k.kind === 'number' ? k.number_id : null, slot: c.slot, patient_id: c.patient, other_patient_id: c.other,
    started_at: startedAt.toISOString(), wall_ms: 0,
    server: { pid: null, cold_start_ms: null, protocol_version: null, exit: null, stderr_path: stderrPath, egress_sandbox: SANDBOX ? 'sandbox-exec' : 'none', start_error: null },
    not_expressible: null, tool_call: null, setup_calls: [], call: null, responsive_after: null, upstream: [], canary_hits: [],
    versions: { ...c.git, ...armVersions(c.arm), corpus_sha256: c.corpus.sha256 },
  };
  let fuzzSeq: number | null = null;
  let endSeq: number | null = null;
  try {
    const s = await launch(ctx, { stderrPath, sandbox: SANDBOX });
    record.server.pid = s.pid;
    record.server.cold_start_ms = s.coldStartMs;
    record.server.protocol_version = s.protocolVersion;
    try {
      const adapter = makeAdapter(c.arm, s.tools, { cell: 'default', patientId: c.patient });
      const seqs: number[] = [];
      const caller: Caller = { call: async (tc, t) => { seqs.push(c.proxy.nextSeq()); return s.call(tc, t); } };
      const ex = await executeCase(caller, {
        adapter, parser: parserFor(c.arm), tools: s.tools, pageSize: c.pageSize, patientId: c.patient,
        canary: canaryUrl(vars), proxyPort: slotPorts(c.slot).recordingProxy, setupSearch: fill(c.corpus.setup_search, vars),
      }, k);
      record.not_expressible = ex.not_expressible;
      record.tool_call = ex.tool_call;
      record.setup_calls = ex.setup_calls;
      record.call = ex.call;
      if (ex.call) { fuzzSeq = seqs.at(-1) ?? null; endSeq = c.proxy.nextSeq(); }
      try { await s.client.ping({ timeout: 10_000 }); record.responsive_after = true; } catch { record.responsive_after = false; }
    } finally {
      record.server.exit = await s.close();
    }
  } catch (e) {
    record.server.start_error = String((e as Error).message).slice(0, 2000);
  }
  await sleep(30); // let the proxy write its last log line
  c.proxy.setRunId('idle');
  const t1 = performance.now();
  record.wall_ms = Math.round(t1 - t0);
  const recs = await proxyRecords(c.proxyLog, logOffset, runId);
  record.upstream = recs.filter(r => fuzzSeq !== null && r.seq >= fuzzSeq && (endSeq === null || r.seq < endSeq))
    .map((r): UpstreamRequest => ({ seq: r.seq, method: r.method, path: r.path, status: r.status, blocked: r.blocked }));
  const from = startedAt.getTime();
  record.canary_hits = c.canary.hits.filter(h => h.at_ms >= from || h.case_id === k.id).filter(h => h.case_id === null || h.case_id === k.id);
  c.canary.hits.splice(0); // attributed; the canary log keeps them all
  rmSync(runTmp, { recursive: true, force: true });
  return record;
}

/** Recomputes scores, summary, report and the blinded rating sheet from every record of the campaign. */
export async function scoreCampaign(campaign: string): Promise<{ summaryPath: string; reportPath: string }> {
  const dir = results.fuzz(campaign);
  const recDir = join(dir, 'records');
  const scores: FuzzScore[] = [];
  const datasets = new Set<string>();
  for (const f of readdirSync(recDir).filter(n => n.endsWith('.jsonl')).sort()) {
    const last = new Map<string, FuzzRunRecord>();
    for await (const r of readJsonl(join(recDir, f))) {
      const rec = r as unknown as FuzzRunRecord;
      last.set(rec.run_id, rec);
    }
    for (const rec of last.values()) { scores.push(classify(rec)); datasets.add(rec.dataset); }
  }
  scores.sort((a, b) => (a.run_id < b.run_id ? -1 : 1));
  await writeFile(join(dir, 'scores.jsonl'), scores.map(s => JSON.stringify(s)).join('\n') + '\n');
  const byDataset = [...datasets].sort().flatMap(d => summarise(scores.filter(s => s.run_id.includes(`__fuzz__${d}__`)), d));
  const corpus = loadCorpus();
  const git = benchGit();
  const summary = { schema: 'fbbench.fuzz-summary/1', campaign, generated_at: new Date().toISOString(), corpus: { version: corpus.version, sha256: corpus.sha256, label: corpus.label }, ...git, arms: byDataset };
  const summaryPath = join(dir, 'summary.json');
  await writeFile(summaryPath, JSON.stringify(summary, null, 2) + '\n');
  // Blinded sheet for rating error clarity by hand: one row per expressible non-success answer, in rank-hash order.
  const rows = scores.filter(s => s.expressible && s.outcome !== 'success')
    .map(s => ({ s, blind: rankHash('order', DEV_SEED_HEX, `fuzz-clarity-${campaign}`, s.run_id).slice(0, 12) }))
    .sort((a, b) => (a.blind < b.blind ? -1 : 1));
  await writeFile(join(dir, 'rating-sheet.jsonl'), rows.map(({ s, blind }) => JSON.stringify({ schema: 'fbbench.fuzz-rating/1', blind_id: blind, case_id: s.case_id, case_note: corpus.cases.find(c => c.id === s.case_id)?.note ?? '', error_text: s.error_text, rater_1: null, rater_2: null })).join('\n') + (rows.length ? '\n' : ''));
  await writeFile(join(dir, 'rating-key.json'), JSON.stringify(Object.fromEntries(rows.map(({ s, blind }) => [blind, s.run_id])), null, 2) + '\n');
  const reportPath = join(dir, 'report.md');
  await writeFile(reportPath, fuzzReport(summary.arms, { campaign, corpus, raw: dir }).join('\n') + '\n');
  return { summaryPath, reportPath };
}

async function main() {
  const { values } = parseArgs({ options: { ...COMMON_OPTIONS, only: { type: 'string' }, 'score-only': { type: 'boolean' }, 'skip-verify': { type: 'boolean' } }, strict: true });
  const campaign = values.campaign ?? '';
  if (!/^[a-z0-9][a-z0-9._-]{0,60}$/.test(campaign)) throw new Error('--campaign must match ^[a-z0-9][a-z0-9._-]{0,60}$');
  if (values['score-only']) {
    const r = await scoreCampaign(campaign);
    process.stdout.write(`${r.summaryPath}\n${r.reportPath}\n`);
    return;
  }
  const dataset = datasetArg(values.dataset);
  const requested = (values.arm ?? DEFAULT_ARMS.join(',')).split(',') as ArmId[];
  for (const a of requested) if (!SCRIPTED_ARMS.includes(a)) throw new Error(`arm ${a} is not a scripted arm`);
  const arms = availableArms(requested);
  if (arms.length === 0) { process.stdout.write('no available arm to run\n'); return; }
  for (const a of arms) if (isMedplumArm(a) || isHealthLakeArm(a)) throw new Error(`arm ${a} runs against ${isMedplumArm(a) ? 'Medplum' : 'HealthLake'}; this runner drives the HAPI backend only`);
  const slot = Number(values.slot ?? '0');
  const only = values.only ? new Set(values.only.split(',')) : null;
  const limit = values.limit ? Number(values.limit) : Infinity;
  const corpus = loadCorpus();
  const cases = corpus.cases.filter(k => !only || only.has(k.id)).slice(0, limit);

  await assertActiveDataset(dataset);
  const verify = values['skip-verify'] ? null : await verifyServedCounts(dataset);
  if (verify && !verify.ok) throw new Error(`HAPI counts do not match converted/${dataset}`);
  const patient = knownPatient(dataset);
  const other = await otherPatient(dataset, patient);
  const dir = results.fuzz(campaign);
  mkdirSync(join(dir, 'records'), { recursive: true });
  const startedAt = new Date().toISOString();
  const proxyLog = join(dir, `proxy-s${slot}.jsonl`);
  const fixtures = corpus.cases.flatMap(k => (k.kind === 'number' ? [{ id: k.number_id, lexeme: k.lexeme }] : []))
    .filter((f, i, all) => all.findIndex(g => g.id === f.id) === i);
  const canary = await startCanary({ slot, logPath: join(dir, `canary-s${slot}.jsonl`) });
  const mock = await startMockBackend({ slot, patientId: patient, fixtures });
  const proxy = await startRecordingProxy({ slot, runId: 'idle', logPath: proxyLog, upstreamPort: mock.port });
  const shim = await startTokenShim({ slot });
  const git = benchGit();
  const tmpRoot = tmpDir(`fuzz-s${slot}`);
  const counts: Record<string, number> = {};
  try {
    for (const arm of arms) {
      const shard = fuzzShard(campaign, arm, dataset);
      const done = await doneIds(shard);
      let n = 0;
      for (const k of cases) {
        const runId = fuzzRunId(arm, dataset, k.id);
        if (done.has(runId)) continue;
        const rec = await runCase({ campaign, dataset, arm, slot, patient, other, corpus, proxy, proxyLog, canary, tmpRoot, git, pageSize: pageSizeFor(arm) }, k);
        await appendJsonl(shard, [rec]);
        n++;
        if (n % 10 === 0) process.stdout.write(`${arm} fuzz: ${n} new\n`);
      }
      counts[arm] = n;
      process.stdout.write(`${arm} fuzz: done, ${n} new\n`);
    }
  } finally {
    await shim.close();
    await proxy.close();
    await mock.close();
    await canary.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  }
  mkdirSync(results.manifests, { recursive: true });
  const manifestPath = join(results.manifests, `fuzz-${campaign}-${dataset}-${arms.join('+')}-s${slot}.json`);
  await writeFile(manifestPath, JSON.stringify({
    schema: 'fbbench.manifest.fuzz/1', campaign, dataset, arms, slot, argv: process.argv.slice(2), started_at: startedAt, finished_at: new Date().toISOString(),
    node: process.version, ...git, corpus: { path: 'bench/fuzz/corpus.json', sha256: corpus.sha256, version: corpus.version, cases: cases.length },
    arm_pins: Object.fromEntries(arms.map(a => [a, ARMS[a].pin])), page_sizes: Object.fromEntries(arms.map(a => [a, pageSizeFor(a)])),
    chain: { proxy: proxyBase(slot), mock_port: mock.port, canary_port: canary.port, mock_served: mock.served() }, served_counts: verify, new_runs: counts,
  }, null, 2) + '\n');
  const r = await scoreCampaign(campaign);
  process.stdout.write(`${manifestPath}\n${r.summaryPath}\n${r.reportPath}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
