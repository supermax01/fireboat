// bench:scripted -- --campaign <c> --dataset <d> --arm FB[,W,...] [--cell default|best_effort] --pass 1|2 [--slot 0]
//                   [--set questions|probes|all] [--only id,id] [--limit n] [--skip-verify] [--strata <dir>] [--backend hapi|medplum|healthlake]
// --backend is implied by the arms (Ws, Wm: medplum; FBh, FBdh, AH: healthlake; others: hapi); when given it must match.
// healthlake: synthea-holdout only, against the data store bench:healthlake recorded; fireboat arms reach it through
// recording proxy 1825s -> loopback signing proxy 1827s; AH connects to AWS itself (no sandbox, not in the proxy log).
// --strata <dir>: the questions set is the stratum questions in <dir>/<dataset>/questions.jsonl
// instead of the main set; their digests are recorded in the manifest (inputs.strata) and checked by bench:score.
// For each (arm, question or probe): fresh server process behind the slot's recording proxy, run the operations
// through the arm's adapter (drain cap 20 per op, 40 per run), close, append one RunRecord. Resumable by run_id.
// Shards: scripted/<c>/records/<arm>__<cell>__p<pass>.<set>.jsonl (one writer per shard); proxy log proxy-s<slot>.jsonl.
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { open, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { COMMON_OPTIONS, datasetArg } from '../lib/cli.js';
import { parseLossless } from '../lib/json.js';
import { appendJsonl, repairPartialTail } from '../lib/jsonl.js';
import { proxyBase, results, tmpDir, type DatasetId } from '../lib/paths.js';
import type { AbstractOp, ArmId, Cell, QuestionRecord, RunRecord, ServerCommand } from '../lib/types.js';
import type { ProbeRecord } from '../gold/probes.js';
import { startRecordingProxy, startTokenShim, type ProxyHandle } from '../infra/proxy.js';
import { makeAdapter, pageSizeFor } from '../servers/adapters.js';
import { ARMS, DEFAULT_ARMS, SCRIPTED_ARMS, armVersions, availableArms } from '../servers/arms.js';
import { benchGit } from '../servers/install.js';
import { launch } from '../servers/launch.js';
import { parserFor } from '../servers/parsers.js';
import { MEDPLUM_DATASETS, MEDPLUM_PORT } from '../infra/medplum.js';
import { SECRET_ENV_KEYS, isMedplumArm, medplumProxyBase, medplumProxyPort, prepareMedplumToken } from '../servers/medplum.js';
import { sha256Text } from '../infra/manifest.js';
import { verifyMedplumServed } from './verify-medplum.js';
import { verifyHealthLakeServed } from './verify-healthlake.js';
import { cliCredentialProvider, parseDatastoreEndpoint } from '../healthlake/aws.js';
import { startSigningProxy, type SigningProxyHandle } from '../healthlake/proxy.js';
import { makeSigner } from '../healthlake/sign.js';
import { activeDatastore, readManifest as readHealthLakeManifest, resourcesPath } from '../healthlake/state.js';
import { healthlakeProxyBase, healthlakeProxyPort, isAwsDirectArm, isHealthLakeArm, isHealthLakeDataset, signingProxyPort } from '../servers/healthlake.js';
import { executeOps, type AnyOp, type ExecResult } from './execute.js';
import { armInputs, datasetInputs, infraImages, strataFiles, strataInputs } from './inputs.js';
import { verifyServedCounts } from './verify.js';

export type RunSet = 'questions' | 'probes';

export interface RunUnit { id: string; patient_id: string; operations: AnyOp[] }

export const runIdOf = (arm: ArmId, cell: Cell, pass: number, unitId: string) => `${arm}__${cell}__p${pass}__${unitId}`;
export const shardPath = (campaign: string, arm: ArmId, cell: Cell, pass: number, set: RunSet) =>
  join(results.scripted(campaign), 'records', `${arm}__${cell}__p${pass}.${set}.jsonl`);
export const proxyLogPath = (campaign: string, slot: number, backend: Backend = 'hapi') =>
  join(results.scripted(campaign), backend === 'hapi' ? `proxy-s${slot}.jsonl` : `proxy-${backend}-s${slot}.jsonl`);
export const signingProxyLogPath = (campaign: string, slot: number) => join(results.scripted(campaign), `signing-proxy-s${slot}.jsonl`);

/**
 * Backend of an invocation: HAPI for every arm except Ws and Wm, which run against Medplum (servers/medplum.ts), and
 * FBh, FBdh and AH, which run against HealthLake (servers/healthlake.ts). One invocation never mixes backends (each has
 * its own proxies, verification and run tmp directory).
 */
export type Backend = 'hapi' | 'medplum' | 'healthlake';
export const BACKENDS: readonly Backend[] = ['hapi', 'medplum', 'healthlake'];
const armBackend = (a: ArmId): Backend => (isMedplumArm(a) ? 'medplum' : isHealthLakeArm(a) ? 'healthlake' : 'hapi');
export function backendOf(arms: readonly ArmId[], declared?: string): Backend {
  const kinds = [...new Set(arms.map(armBackend))];
  if (kinds.length > 1) {
    const by = (b: Backend) => arms.filter(a => armBackend(a) === b).join(',');
    throw new Error(`one invocation runs one backend; got ${kinds.map(k => `${k}: ${by(k)}`).join('; ')}; run them in a separate invocation`);
  }
  const b = kinds[0] ?? 'hapi';
  if (declared !== undefined && declared !== b) throw new Error(`--backend ${declared} does not match arms ${arms.join(',')} (${b})`);
  return b;
}

/** The command as recorded: credential values (SECRET_ENV_KEYS) replaced by a digest prefix, never written to records. */
export function redactCommand(cmd: ServerCommand): ServerCommand {
  const env = { ...cmd.env };
  for (const k of SECRET_ENV_KEYS) if (env[k] !== undefined) env[k] = `<redacted sha256:${sha256Text(env[k]!).slice(0, 12)}>`;
  return { ...cmd, env };
}
export const probesPath = (dataset: DatasetId) => join(results.questions(dataset), '..', 'probes.jsonl');

export async function loadUnits(dataset: DatasetId, set: RunSet, strataDir?: string): Promise<RunUnit[]> {
  if (set === 'questions') {
    const text = await readFile(strataDir ? strataFiles(strataDir, dataset).questions : results.questions(dataset), 'utf8');
    // Question files carry strings only (no numbers); plain JSON.parse is safe here.
    return text.split('\n').filter(Boolean).map(l => JSON.parse(l) as QuestionRecord)
      .map(q => ({ id: q.id, patient_id: q.patient_id, operations: q.operations.map(normaliseOp) }));
  }
  if (!existsSync(probesPath(dataset))) return [];
  const text = await readFile(probesPath(dataset), 'utf8');
  // Write probes carry FHIR bodies with numbers: keep their lexemes.
  return text.split('\n').filter(Boolean).map(l => parseLossless(l) as unknown as ProbeRecord)
    .map(r => ({ id: r.id, patient_id: r.patient_id, operations: r.operations.map(o => normaliseOp(o as AnyOp)) }));
}

function normaliseOp(op: AnyOp): AnyOp {
  if (op.op === 'drain') return { ...op, call_cap: Number(op.call_cap) } as AbstractOp;
  if ((op.op === 'next' || op.op === 'next_tampered') && typeof op.of !== 'number') return { ...op, of: Number(op.of) } as AnyOp;
  return op;
}

/**
 * run_ids already present in a shard. A partial last line (crash mid-append) is moved aside first; a run counts as done
 * only if its line parses. Runs flagged server_start_failed (an infrastructure failure) are not done unless
 * keepFailed: resume retries them, and bench:score keeps the last record per run_id.
 */
export async function doneRunIds(path: string, opts: { keepFailed?: boolean } = {}): Promise<Set<string>> {
  const done = new Set<string>();
  if (!existsSync(path)) return done;
  repairPartialTail(path);
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8', highWaterMark: 1 << 20 }), crlfDelay: Infinity });
  for await (const line of rl) {
    let rec: { run_id?: unknown; flags?: unknown };
    try { rec = JSON.parse(line) as typeof rec; } catch { continue; }
    if (typeof rec.run_id !== 'string') continue;
    const failed = Array.isArray(rec.flags) && rec.flags.includes('server_start_failed');
    if (failed && !opts.keepFailed) done.delete(rec.run_id); // a later success re-adds it
    else done.add(rec.run_id);
  }
  return done;
}

interface ProxyRec { run_id: string; seq: number; blocked: boolean; method: string; path: string }

/** Proxy records appended since `offset` for one run id (our own log; plain JSON). */
async function proxyRecords(path: string, offset: number, runId: string): Promise<ProxyRec[]> {
  if (!existsSync(path)) return [];
  const size = statSync(path).size;
  if (size <= offset) return [];
  const fh = await open(path, 'r');
  const buf = Buffer.alloc(size - offset);
  await fh.read(buf, 0, buf.length, offset);
  await fh.close();
  return buf.toString('utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as ProxyRec).filter(r => r.run_id === runId);
}

/** Static write check: a tool that can change the backend, by name or by an HTTP-method argument. */
export function mutatingReason(t: { name: string; inputSchema: unknown }): string | null {
  if (/^(create|update|delete|patch)$|(^|_)(create|update|delete|patch|write)(_|$)/i.test(t.name)) return 'name';
  const schema = JSON.stringify(t.inputSchema ?? {});
  const m = /"enum":\[([^\]]*)\]/g;
  for (const e of schema.matchAll(m)) if (/"(POST|PUT|PATCH|DELETE)"/.test(e[1]!)) return 'method argument';
  return null;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Every scripted server runs inside the loopback-only egress sandbox; recorded as such in every RunRecord. */
const SANDBOX = true;

async function main() {
  const { values } = parseArgs({
    options: { ...COMMON_OPTIONS, set: { type: 'string' }, only: { type: 'string' }, 'skip-verify': { type: 'boolean' }, strata: { type: 'string' }, backend: { type: 'string' } }, strict: true,
  });
  const campaign = values.campaign ?? '';
  if (!/^[a-z0-9][a-z0-9._-]{0,60}$/.test(campaign)) throw new Error('--campaign must match ^[a-z0-9][a-z0-9._-]{0,60}$');
  const dataset = datasetArg(values.dataset);
  const requested = (values.arm ?? DEFAULT_ARMS.join(',')).split(',') as ArmId[];
  for (const a of requested) if (!SCRIPTED_ARMS.includes(a)) throw new Error(`arm ${a} is not a scripted arm`);
  const arms = availableArms(requested);
  if (arms.length === 0) { process.stdout.write('no available arm to run\n'); return; }
  const cell = (values.cell ?? 'default') as Cell;
  if (cell !== 'default' && cell !== 'best_effort') throw new Error('--cell must be default or best_effort');
  const pass = Number(values.pass ?? '1');
  if (pass !== 1 && pass !== 2) throw new Error('--pass must be 1 or 2');
  const slot = Number(values.slot ?? '0');
  const sets: RunSet[] = values.set === 'probes' ? ['probes'] : values.set === 'all' ? ['questions', 'probes'] : ['questions'];
  const only = values.only ? new Set(values.only.split(',')) : null;
  const limit = values.limit ? Number(values.limit) : Infinity;
  const strataDir = values.strata ? resolve(values.strata) : undefined;
  if (strataDir && !existsSync(strataFiles(strataDir, dataset).questions)) throw new Error(`no stratum questions at ${strataFiles(strataDir, dataset).questions}`);

  if (values.backend !== undefined && !(BACKENDS as readonly string[]).includes(values.backend)) throw new Error(`--backend must be one of ${BACKENDS.join(', ')}`);
  const backend = backendOf(arms, values.backend);
  if (backend === 'medplum' && !(MEDPLUM_DATASETS as readonly string[]).includes(dataset)) throw new Error(`arms ${arms.join(',')} run against Medplum, which holds only ${MEDPLUM_DATASETS.join(', ')}`);
  if (backend === 'healthlake' && !isHealthLakeDataset(dataset)) throw new Error(`arms ${arms.join(',')} run against HealthLake, which holds only synthea-holdout`);
  const startedAt = new Date().toISOString();

  // HealthLake: the recorded data store, and the loopback signing proxy every fireboat request goes through.
  let signing: SigningProxyHandle | null = null;
  let datastoreId: string | undefined;
  if (backend === 'healthlake') {
    const ds = activeDatastore(readHealthLakeManifest(dataset));
    datastoreId = ds.id;
    signing = await startSigningProxy({ port: signingProxyPort(slot), endpoint: parseDatastoreEndpoint(ds.endpoint), signer: makeSigner(cliCredentialProvider()), logPath: signingProxyLogPath(campaign, slot), slot });
  }
  try {
    const verify = values['skip-verify'] ? null
      : backend === 'medplum' ? await verifyMedplumServed(dataset)
      : backend === 'healthlake' ? await verifyHealthLakeServed(dataset, datastoreId!, `http://127.0.0.1:${signingProxyPort(slot)}/fhir`)
      : await verifyServedCounts(dataset);
    if (verify && !verify.ok) throw new Error(`${backend} counts do not match the expected counts for ${dataset}: ${JSON.stringify(verify.types)}`);

    mkdirSync(results.scripted(campaign), { recursive: true });
    const logPath = proxyLogPath(campaign, slot, backend);
    const proxy = backend === 'medplum'
      ? await startRecordingProxy({ slot, runId: 'idle', logPath, port: medplumProxyPort(slot), upstreamPort: MEDPLUM_PORT })
      : backend === 'healthlake'
        ? await startRecordingProxy({ slot, runId: 'idle', logPath, port: healthlakeProxyPort(slot), upstreamPort: signingProxyPort(slot) })
        : await startRecordingProxy({ slot, runId: 'idle', logPath });
    const shim = backend === 'hapi' ? await startTokenShim({ slot }) : null;
    const fhirBaseUrl = backend === 'medplum' ? medplumProxyBase(slot) : backend === 'healthlake' ? healthlakeProxyBase(slot) : proxyBase(slot);
    const git = benchGit();
    const inputs = { dataset: await datasetInputs(dataset), arms: await armInputs(arms), infra_images: infraImages(),
      ...(backend === 'medplum' ? { medplum: medplumInputs(dataset) } : {}), ...(backend === 'healthlake' ? { healthlake: healthlakeInputs(dataset) } : {}),
      ...(strataDir ? { strata: await strataInputs(strataDir, dataset) } : {}) };
    const tmpRoot = tmpDir(backend === 'hapi' ? `scripted-s${slot}` : `scripted-${backend}-s${slot}`);
    const counts: Record<string, number> = {};
    const toolsSeen = new Map<ArmId, { name: string; mutating: string | null }[]>();
    try {
      for (const arm of arms) {
        const pageSize = pageSizeFor(arm);
        for (const set of sets) {
          const units = (await loadUnits(dataset, set, strataDir)).filter(u => !only || only.has(u.id)).slice(0, limit);
          const shard = shardPath(campaign, arm, cell, pass, set);
          const done = await doneRunIds(shard);
          const already = units.filter(u => done.has(runIdOf(arm, cell, pass, u.id))).length; // shards hold both datasets
          let n = 0;
          for (const u of units) {
            const runId = runIdOf(arm, cell, pass, u.id);
            if (done.has(runId)) continue;
            const credBefore = signing?.stats().credential_errors ?? 0;
            const rec = await runOne({ campaign, dataset, arm, cell, pass: pass as 1 | 2, slot, unit: u, runId, pageSize, proxy, logPath, tmpRoot, git, toolsSeen, fhirBaseUrl, datastoreId });
            // HealthLake: a run during which the AWS session lapsed measured nothing; stop without writing it, so resume reruns it.
            if (backend === 'healthlake' && ((signing?.stats().credential_errors ?? 0) > credBefore || sessionLapsed(rec))) {
              throw new Error(`the AWS session lapsed during ${runId}; its record was not written. Sign in again (aws login --profile fireboat) and rerun the same command: it resumes from this run.`);
            }
            await appendJsonl(shard, [rec]);
            n++;
            counts[`${arm}.${set}`] = (counts[`${arm}.${set}`] ?? 0) + 1;
            if (n % 10 === 0) process.stdout.write(`${arm} ${cell} p${pass} ${set}: ${already + n}/${units.length}\n`);
          }
          process.stdout.write(`${arm} ${cell} p${pass} ${set}: done, ${n} new, ${already + n}/${units.length} present\n`);
        }
      }
    } finally {
      await shim?.close();
      await proxy.close();
      rmSync(tmpRoot, { recursive: true, force: true });
    }
    const manifest = {
      schema: 'fbbench.manifest.scripted/1', campaign, dataset, arms, cell, pass, slot, sets, argv: process.argv.slice(2),
      started_at: startedAt, finished_at: new Date().toISOString(), node: process.version, ...git,
      arm_pins: Object.fromEntries(arms.map(a => [a, ARMS[a].pin])), page_sizes: Object.fromEntries(arms.map(a => [a, pageSizeFor(a)])),
      backend, fhir_base_url: fhirBaseUrl, served_counts: verify, new_runs: counts, tools_listed: Object.fromEntries(toolsSeen), inputs,
      ...(backend === 'healthlake' ? { healthlake: {
        chain: 'fireboat arms: recording proxy (this log) -> loopback SigV4 signing proxy (Bundle.link and entry.fullUrl rewritten to the proxy base) -> HealthLake us-east-2',
        signing_proxy_log: signingProxyLogPath(campaign, slot), signing_proxy_stats: signing?.stats() ?? null,
        aws_direct_arms: arms.filter(isAwsDirectArm), aws_direct_note: 'AH connects to HealthLake itself: no egress sandbox, no recording proxy, upstream requests not logged',
      } } : {}),
    };
    mkdirSync(results.manifests, { recursive: true });
    await writeFile(join(results.manifests, `scripted-${campaign}-${dataset}-${arms.join('+')}-${cell}-p${pass}-s${slot}.json`), JSON.stringify(manifest, null, 2) + '\n');
  } finally {
    await signing?.close();
  }
}

interface RunArgs {
  campaign: string; dataset: DatasetId; arm: ArmId; cell: Cell; pass: 1 | 2; slot: number; unit: RunUnit; runId: string;
  pageSize: number; proxy: ProxyHandle; logPath: string; tmpRoot: string; git: ReturnType<typeof benchGit>;
  toolsSeen: Map<ArmId, { name: string; mutating: string | null }[]>;
  fhirBaseUrl: string;
  /** HealthLake backend: the data store id (AH's datastore_id). */
  datastoreId?: string;
}

async function runOne(a: RunArgs): Promise<RunRecord> {
  const runDir = join(results.scripted(a.campaign), 'runs', a.runId);
  rmSync(runDir, { recursive: true, force: true });
  const runTmp = join(a.tmpRoot, 't');
  rmSync(runTmp, { recursive: true, force: true });
  const ctx = { arm: a.arm, dataset: a.dataset, patientId: a.unit.patient_id, slot: a.slot, cell: a.cell, fhirBaseUrl: a.fhirBaseUrl, runDir, runTmp };
  const logOffset = existsSync(a.logPath) ? statSync(a.logPath).size : 0;
  const firstSeq = a.proxy.nextSeq();
  a.proxy.setRunId(a.runId);
  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  const stderrPath = join(runDir, 'stderr.txt');
  const base = {
    schema: 'fbbench.run/1' as const, campaign: a.campaign, run_id: a.runId, pass: a.pass, arm: a.arm, cell: a.cell, dataset: a.dataset,
    question_id: a.unit.id, patient_id: a.unit.patient_id, slot: a.slot, started_at: startedAt,
    versions: { ...a.git, ...armVersions(a.arm) },
  };
  let record: Omit<RunRecord, 'upstream' | 'wall_ms'>;
  try {
    if (isMedplumArm(a.arm)) await prepareMedplumToken(a.arm, a.dataset, a.unit.patient_id); // the token in FHIR_SERVER_ACCESS_TOKEN
    // AH connects to AWS itself, so it cannot run inside the loopback-only egress sandbox (recorded per run).
    const s = await launch(ctx, { stderrPath, sandbox: SANDBOX && !isAwsDirectArm(a.arm) });
    if (!a.toolsSeen.has(a.arm)) a.toolsSeen.set(a.arm, s.tools.map(t => ({ name: t.name, mutating: mutatingReason(t) })));
    const adapter = makeAdapter(a.arm, s.tools, { cell: a.cell, patientId: a.unit.patient_id, ...(a.datastoreId ? { datastoreId: a.datastoreId } : {}) });
    let exec: ExecResult;
    let exit: { code: number | null; signal: string | null };
    try {
      exec = await executeOps(s, { arm: a.arm, tools: s.tools, adapter, parser: parserFor(a.arm), pageSize: a.pageSize, ...(a.datastoreId ? { datastoreId: a.datastoreId } : {}) }, a.unit.operations);
    } finally {
      exit = await s.close();
    }
    const flags = [...exec.flags];
    if (isAwsDirectArm(a.arm)) flags.push('aws_direct:no_sandbox_no_proxy_log');
    if (s.stdoutNoise.length) flags.push(`stdout_noise:${s.stdoutNoise.length}`);
    for (const v of s.validationIssues) flags.push(`output_schema_invalid:${v.tool ?? 'unknown'}`);
    record = {
      ...base,
      server: {
        command: redactCommand(s.command), pid: s.pid, cold_start_ms: s.coldStartMs, protocol_version: s.protocolVersion, server_info: s.serverInfo,
        instructions_bytes: s.instructionsBytes, tools_list_bytes: s.toolsListBytes, exit, stderr_path: stderrPath, egress_sandbox: s.egressSandbox,
      },
      calls: exec.calls, op_outcomes: exec.op_outcomes, flags: [...new Set(flags)],
    };
  } catch (e) {
    record = {
      ...base,
      server: {
        command: recordedCommand(a.arm, ctx), pid: null, cold_start_ms: null, protocol_version: null, server_info: null, instructions_bytes: 0,
        tools_list_bytes: 0, exit: null, stderr_path: stderrPath, egress_sandbox: SANDBOX && !isAwsDirectArm(a.arm) ? 'sandbox-exec' : 'none',
      },
      calls: [], op_outcomes: a.unit.operations.map((_, i) => ({ op_index: i, outcome: 'failed' as const, detail: String((e as Error).message).slice(0, 300) })),
      flags: ['server_start_failed'],
    };
  }
  const wallMs = Math.round(performance.now() - t0);
  await sleep(30); // let the proxy finish writing its last log line
  a.proxy.setRunId('idle');
  const lastSeq = a.proxy.nextSeq() - 1;
  const recs = await proxyRecords(a.logPath, logOffset, a.runId);
  rmSync(runTmp, { recursive: true, force: true });
  return {
    ...record, wall_ms: wallMs,
    upstream: { proxy_log: a.logPath, requests: recs.length, blocked_writes: recs.filter(r => r.blocked).length,
      first_seq: recs.length ? firstSeq : null, last_seq: recs.length ? lastSeq : null },
  };
}

/** The command for a failed start's record; for Ws and Wm without a prepared token, the command without its token. */
function recordedCommand(arm: ArmId, ctx: Parameters<NonNullable<(typeof ARMS)[ArmId]['command']>>[0]): ServerCommand {
  try { return redactCommand(ARMS[arm].command!(ctx)); } catch (e) {
    return { command: '', args: [], env: {}, cwd: ctx.runDir, files: {}, unavailable: String((e as Error).message).slice(0, 200) } as ServerCommand;
  }
}

/** AH reports an expired or missing session as {"error": true, "type": "auth_error"} with a credential message. */
export function sessionLapsed(rec: Pick<RunRecord, 'arm' | 'calls'>): boolean {
  if (rec.arm !== 'AH') return false;
  const p = parserFor('AH');
  return rec.calls.some(c => {
    const r = p.parse(c).refused;
    return r?.code === 'auth_error' && /expired|credential|token|Unable to locate|credential_process/i.test(r.message);
  });
}

/** Digests of the HealthLake resource record, load and verify manifests an FBh, FBdh or AH campaign ran against. */
function healthlakeInputs(dataset: DatasetId): Record<string, string | null> {
  const f = (p: string) => (existsSync(p) ? sha256Text(readFileSync(p)) : null);
  return {
    resources_manifest: f(resourcesPath(dataset)),
    load_manifest: f(join(results.manifests, `healthlake-load-${dataset}.json`)),
    verify_manifest: f(join(results.manifests, `healthlake-verify-${dataset}.json`)),
  };
}

/** Digests of the Medplum load and client set a Ws or Wm campaign ran against. */
function medplumInputs(dataset: DatasetId): Record<string, string | null> {
  const f = (p: string) => (existsSync(p) ? sha256Text(readFileSync(p)) : null);
  return {
    infra_manifest: f(join(results.manifests, 'medplum-infra.json')),
    load_manifest: f(join(results.manifests, `medplum-load-${dataset}.json`)),
    clients_manifest: f(join(results.manifests, `medplum-clients-${dataset}.json`)),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
