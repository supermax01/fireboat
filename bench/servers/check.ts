// bench:arms-check -- --dataset <d> [--arm FB,W] [--slot 0] [--cell default] [--patient <id>] [--probe] [--base <url>] [--tag <t>]
// --tag writes arms-check/<d>-<t>/ and manifests/arms-check-<d>-<t>.json instead of the shared untagged files.
// For each arm: fresh process, initialize, tools/list, one capabilities call (and with --probe a read, a search and a
// next; page size via --page-size) through the arm's adapter and parser. Writes manifests/arms-check-<dataset>.json and raw calls under
// RESULTS/arms-check/<dataset>/<arm>/. --base bypasses the slot proxy (development only; recorded).
import { createServer, request as httpRequest, type Server } from 'node:http';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { COMMON_OPTIONS, datasetArg } from '../lib/cli.js';
import { appendJsonl } from '../lib/jsonl.js';
import { HAPI_BASE, RESULTS, knownPatient, proxyBase, results, slotPorts } from '../lib/paths.js';
import type { AbstractOp, ArmId, CallRecord, Cell, DatasetId, ParsedResult } from '../lib/types.js';
import { makeAdapter, pageSizeFor } from './adapters.js';
import { ARMS, DEFAULT_ARMS, availableArms, type Adapter, type Parser } from './arms.js';
import { isHealthLakeArm } from './healthlake.js';
import { benchGit } from './install.js';
import { launch, type LaunchedSession } from './launch.js';
import { parserFor } from './parsers.js';

export interface OpRun { calls: CallRecord[]; outcomes: { op_index: number; outcome: string; detail: string; flags: string[] }[]; parsed: ParsedResult[] }

/** Minimal executor for the check (the scripted track's executor lives in run/). Drain is not used here. */
export async function runOps(s: LaunchedSession, adapter: Adapter, parser: Parser, ops: AbstractOp[], pageSize: number): Promise<OpRun> {
  const out: OpRun = { calls: [], outcomes: [], parsed: [] };
  const lastParsed: (ParsedResult | null)[] = [];
  for (const [i, op] of ops.entries()) {
    let tc; let flags: string[] = [];
    if (op.op === 'capabilities') tc = adapter.capabilities(op.type);
    else if (op.op === 'read') tc = adapter.read(op.type, op.id);
    else if (op.op === 'search') { const r = adapter.search(op.type, op.params, pageSize); if ('call' in r) { tc = r.call; flags = r.flags; } else tc = r; }
    else if (op.op === 'next') {
      const prev = lastParsed[op.of];
      const r = prev ? adapter.next(prev) : { cannot_continue: 'no previous result' };
      tc = 'cannot_continue' in r ? null : r;
      if (!tc) { out.outcomes.push({ op_index: i, outcome: 'cannot_continue', detail: (r as { cannot_continue: string }).cannot_continue, flags }); lastParsed.push(null); continue; }
    } else throw new Error(`op ${op.op} not supported by the check`);
    if ('refused' in tc) { out.outcomes.push({ op_index: i, outcome: 'refused_by_adapter', detail: tc.refused, flags }); lastParsed.push(null); continue; }
    const outcome = await s.call(tc, 120_000);
    const rec: CallRecord = { seq: out.calls.length, op_index: i, op: op.op === 'next' ? 'next' : op.op, ...outcome };
    out.calls.push(rec);
    const parsed = parser.parse(rec);
    out.parsed.push(parsed);
    lastParsed.push(parsed);
    out.outcomes.push({ op_index: i, outcome: rec.error ? 'failed' : parsed.refused || parsed.is_error ? 'tool_error' : 'ok', detail: parsed.refused ? `${parsed.refused.code}: ${parsed.refused.message}`.slice(0, 300) : '', flags });
  }
  return out;
}

/** Development fallback when infra's token shim is unavailable: POST /oauth2/token -> fixed token; everything else forwarded. */
function startLocalTokenShim(port: number, upstream: string): Promise<Server> {
  const up = new URL(upstream);
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url?.startsWith('/oauth2/token')) {
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"access_token":"bench","token_type":"Bearer","expires_in":3600}');
      return;
    }
    const fwd = httpRequest({ host: up.hostname, port: up.port, method: req.method, path: req.url, headers: { ...req.headers, host: `${up.hostname}:${up.port}` } },
      r => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
    fwd.on('error', e => { res.writeHead(502).end(String(e)); });
    req.pipe(fwd);
  });
  return new Promise((resolve, reject) => server.once('error', reject).listen(port, '127.0.0.1', () => resolve(server)));
}

interface Backend { fhirBaseUrl: string; kind: string; close(): Promise<void>; setRunId(id: string): void }

async function backend(dataset: DatasetId, slot: number, base: string | undefined, logPath: string): Promise<Backend> {
  const closers: (() => Promise<void> | void)[] = [];
  let setRunId = (_: string) => {};
  let fhirBaseUrl: string; let kind: string;
  let infra: Record<string, unknown> | null = null;
  try { infra = await import(['..', 'infra', 'proxy.js'].join('/')) as Record<string, unknown>; } catch { infra = null; }
  if (base) {
    fhirBaseUrl = base; kind = 'direct (development; --base)';
  } else {
    const active = await import(['..', 'infra', 'active.js'].join('/')) as { assertActiveDataset(d: DatasetId): Promise<void> };
    await active.assertActiveDataset(dataset);
    if (infra && typeof infra.startRecordingProxy === 'function') {
      const p = await (infra.startRecordingProxy as (o: unknown) => Promise<{ close(): Promise<void>; setRunId(id: string): void }>)({ slot, runId: 'arms-check', logPath });
      closers.push(() => p.close());
      setRunId = id => p.setRunId(id);
      fhirBaseUrl = proxyBase(slot); kind = 'slot recording proxy';
    } else {
      fhirBaseUrl = HAPI_BASE; kind = 'direct HAPI (infra proxy not available)';
    }
  }
  if (infra && typeof infra.startTokenShim === 'function' && !base) {
    const shim = await (infra.startTokenShim as (o: unknown) => Promise<{ close(): Promise<void> }>)({ slot });
    closers.push(() => shim.close());
  } else {
    const shim = await startLocalTokenShim(slotPorts(slot).tokenShim, fhirBaseUrl);
    closers.push(() => new Promise<void>(r => shim.close(() => r())));
    kind += '; momentum via local development token shim';
  }
  return { fhirBaseUrl, kind, setRunId, close: async () => { for (const c of closers.reverse()) await c(); } };
}

async function main() {
  const { values } = parseArgs({ options: { ...COMMON_OPTIONS, patient: { type: 'string' }, base: { type: 'string' }, probe: { type: 'boolean' }, 'page-size': { type: 'string' }, tag: { type: 'string' } }, strict: true });
  const tag = values.tag ?? null;
  if (tag !== null && !/^[a-z0-9][a-z0-9._-]{0,60}$/.test(tag)) throw new Error('--tag must match ^[a-z0-9][a-z0-9._-]{0,60}$');
  const dataset = datasetArg(values.dataset);
  const slot = Number(values.slot ?? '0');
  const cell = (values.cell ?? 'default') as Cell;
  const arms = availableArms((values.arm ?? DEFAULT_ARMS.join(',')).split(',') as ArmId[]);
  for (const a of arms) if (isHealthLakeArm(a)) throw new Error(`arm ${a} runs against HealthLake: use bench:scripted -- --backend healthlake`);
  const patientId = values.patient ?? knownPatient(dataset);
  const outRoot = join(RESULTS, 'arms-check', tag ? `${dataset}-${tag}` : dataset);
  mkdirSync(outRoot, { recursive: true });
  const be = await backend(dataset, slot, values.base, join(outRoot, 'proxy.jsonl'));
  const ops: AbstractOp[] = [{ op: 'capabilities', type: 'Patient' }];
  if (values.probe) {
    ops.push({ op: 'read', type: 'Patient', id: patientId });
    ops.push({ op: 'search', type: 'Observation', params: [['patient', `Patient/${patientId}`], ['category', 'laboratory']] });
    ops.push({ op: 'next', of: 2 });
  }
  const summary: Record<string, unknown>[] = [];
  let failed = false;
  try {
    for (const arm of arms) {
      const dir = join(outRoot, arm);
      rmSync(dir, { recursive: true, force: true });
      be.setRunId(`arms-check__${arm}`);
      const started = new Date().toISOString();
      try {
        const s = await launch({ arm, dataset, patientId, slot, cell, fhirBaseUrl: be.fhirBaseUrl, runDir: join(dir, 'run'), runTmp: join(dir, 'tmp') },
          { stderrPath: join(dir, 'stderr.txt') });
        const adapter = makeAdapter(arm, s.tools, { cell, patientId });
        const r = await runOps(s, adapter, parserFor(arm), ops, values['page-size'] ? Number(values['page-size']) : values.base ? 50 : pageSizeFor(arm));
        const exit = await s.close();
        await appendJsonl(join(dir, 'calls.jsonl'), r.calls);
        writeFileSync(join(dir, 'tools-list.jsonl'), s.toolsListRaw.join('\n') + '\n');
        rmSync(join(dir, 'tmp'), { recursive: true, force: true });
        summary.push({
          arm, pin: ARMS[arm].pin, started_at: started, pid: s.pid, cold_start_ms: s.coldStartMs, protocol_version: s.protocolVersion,
          server_info: s.serverInfo, instructions_bytes: s.instructionsBytes, tools_list_bytes: s.toolsListBytes, tool_names: s.toolNames,
          egress_sandbox: s.egressSandbox, exit, stderr_path: s.stderrPath, stdout_noise_lines: s.stdoutNoise.length,
          validation_issues: s.validationIssues,
          ops: r.outcomes.map(o => {
            const call = r.calls.find(c => c.op_index === o.op_index);
            const p = call ? r.parsed[call.seq] : undefined;
            return { ...o, op: ops[o.op_index], tool: call?.tool ?? null, arguments: call?.arguments ?? null, latency_ms: call?.latency_ms ?? null,
              bytes: call?.bytes ?? null, items: p?.items.length ?? null, other_patient_items: p?.items.filter(i => i.patient && i.patient !== patientId).length ?? null,
              signals: p?.signals ?? null, blanket: p?.blanket ?? null, explicit_complete: p?.explicit_complete ?? null, page_handle: p?.page_handle ? 'present' : null,
              first_item: p?.items[0] ?? null };
          }),
        });
        process.stdout.write(`${arm}: ${s.toolNames.length} tools; ${r.outcomes.map(o => `${o.op_index}:${o.outcome}`).join(' ')}\n`);
      } catch (e) {
        failed = true;
        summary.push({ arm, started_at: started, error: (e as Error).message });
        process.stderr.write(`${arm}: FAILED: ${(e as Error).message}\n`);
      }
    }
  } finally {
    await be.close();
  }
  const manifest = { schema: 'fbbench.manifest.arms-check/1', dataset, tag, slot, cell, patient_id: patientId, backend: be.kind, fhir_base_url: be.fhirBaseUrl,
    ops, argv: process.argv.slice(2), finished_at: new Date().toISOString(), ...benchGit(), arms: summary };
  mkdirSync(results.manifests, { recursive: true });
  writeFileSync(join(results.manifests, `arms-check-${dataset}${values.base ? '-dev' : ''}${tag ? `-${tag}` : ''}.json`), JSON.stringify(manifest, null, 2) + '\n');
  process.exit(failed ? 1 : 0);
}

await main();
