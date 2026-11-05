import { performance } from 'node:perf_hooks';
import { startBackend } from './backend.js';
import { cellDrivers, createDriver, driverScope, DriverAborted, type DriverScope, type Driver } from './drivers.js';
import { CHANNELS, hash, type IsolationCase } from './case-schema.js';
import { AggregateError, cellCoverageProblem, isDisclosure } from './report.js';
import { A, B } from './canaries.js';
import { scan, normalize, stableEnvelope, type Hit } from './scanners.js';
import { scenario, check, OracleFailure, PendingObligation, type Evidence } from './scenarios.js';
import { challengeControl } from './stubs.js';
export interface CellReport {
  lane: Driver['kind']; era: string; run: number; verdict: 'PASS' | 'FAIL' | 'PENDING' | 'INCONCLUSIVE'; channels_scanned: string[]; channels_na: string[];
  failures: Evidence[]; control_result: string; stubs: Awaited<ReturnType<typeof challengeControl>>[];
  request_counts: Record<string, number>; request_marker_observations: Hit[]; tool_calls: number; retained_followups: number; capture_hashes: Record<string, string>; fingerprint: string; pending_reason?: string;
  /** B2-0: per-arm and pre-stub counts, descriptive timing (never an oracle), the phase reached and per-stub counts. */
  arms: { control: Counts; attack: Counts; followups: Counts }; pre_stub: Counts; timing: CellTiming; phase: CellPhase; stub_counts: Record<string, Counts>;
}
/** B2-0: `counts_toward_b2` is computed in the report (report.ts computeStanding), never stored on a case report. */
export interface CaseReport { id: string; family: string; verdict: string; lanes: CellReport[]; cli: { verdict: string; source_lanes: string[]; channels_na: string[]; channels_scanned: string[] }; critical_mutants: string[] }
const kinds = ['core', 'sdk-modern', 'sdk-legacy'] as const;
function evidenceFromHit(h: Hit): Evidence { return { channel: h.channel, predicate: 'forbidden marker absent', expected: 'absent', observed: { marker_id: h.marker_id, segment_index: h.segment_index, path: h.path, encoding: h.encoding } }; }
function captured(d: Driver) {
  // A call the watchdog interrupted leaves its placeholder unset; only completed calls are capturable.
  const calls = d.calls.filter(Boolean);
  return {
    output_text: () => calls.flatMap(c => c.wire.content ?? []), output_structured: () => calls.map(c => c.wire.structuredContent ?? c.wire.sdk_error ?? c.wire.library_error),
    raw_frame: () => d.raw.join(''), stderr: () => d.stderr.join(''), operational: () => d.operational, audit: () => d.audit(), state: () => d.state(),
  };
}
/** Target-phase request and tool-call counts at a snapshot point (B2-0 §3): stub replays are never counted here. Tool
 * calls and bytes cover every driver opened in the cell, the primary first (review L8). */
export interface Counts { tool_calls: number; total_upstream_calls: number; clinical: number; metadata: number; auth: number; probe: number; sink: number; mutations: number; max_call_bytes: number; per_driver: number[] }
export interface CellTiming { cell_ms: number; control_ms: number; attack_ms: number; followups_ms: number; checks_ms: number; stubs_ms: number }
export type CellPhase = 'start' | 'control' | 'attack' | 'followups' | 'checks' | 'stubs' | 'done';
export interface RunCellHooks { cliScript?: string; onChild?: DriverScope['onChild']; afterBackendStart?(backend: Backend): void | Promise<void>; afterDriverStart?(driver: Driver): void | Promise<void> }
type Backend = Awaited<ReturnType<typeof startBackend>>;
class Aborted extends Error { constructor() { super('aborted by the watchdog'); this.name = 'Aborted'; } }
const zeroCounts = (): Counts => ({ tool_calls: 0, total_upstream_calls: 0, clinical: 0, metadata: 0, auth: 0, probe: 0, sink: 0, mutations: 0, max_call_bytes: 0, per_driver: [] });
export function snapshot(backend: Backend, drivers: readonly Driver[]): Counts {
  const target = backend.requests.filter(r => r.phase === 'target');
  const count = (kind: string) => target.filter(r => r.kind === kind).length;
  const calls = drivers.flatMap(d => d.calls).filter(Boolean);
  const perDriver = drivers.map(d => d.calls.length);
  return { tool_calls: perDriver.reduce((n, v) => n + v, 0), total_upstream_calls: target.filter(r => r.kind !== 'sink').length, clinical: count('clinical'), metadata: count('metadata'), auth: count('auth'), probe: count('probe'), sink: count('sink'),
    mutations: backend.mutations.filter(m => m.startsWith('target:')).length, max_call_bytes: Math.max(0, ...calls.map(call => call.bytes)), per_driver: perDriver };
}
/** Budgets are oracles (design D:534): a breach is FAIL under a named predicate. Counts are the pre-stub snapshot. */
export function enforceBudgets(c: IsolationCase, counts: Counts): void {
  check(counts.tool_calls <= c.budgets.max_tool_calls, 'state', 'b2.budget.max_tool_calls', c.budgets.max_tool_calls, counts.tool_calls);
  check(counts.total_upstream_calls <= c.budgets.max_total_upstream_calls, 'request', 'b2.budget.max_total_upstream_calls', c.budgets.max_total_upstream_calls, counts.total_upstream_calls);
  check(counts.clinical <= c.budgets.max_clinical_calls, 'request', 'b2.budget.max_clinical_calls', c.budgets.max_clinical_calls, counts.clinical);
  check(counts.max_call_bytes <= c.budgets.max_result_bytes, 'output_structured', 'b2.budget.max_result_bytes', c.budgets.max_result_bytes, counts.max_call_bytes);
}
/** Evidence is local consistency evidence, not authenticated proof against an operator who can edit artifacts/source.
 * Version hashes avoid re-scanning unchanged captures; an appended log/frame/request always changes the version. */
function scanRemaining(c: IsolationCase, backend: Backend, drivers: readonly Driver[], result: CellReport): boolean {
  const primary = drivers[0];
  const cap = primary ? captured(primary) : undefined;
  for (const ch of CHANNELS) {
    if (result.channels_na.includes(ch)) continue;
    try {
    // Secondary stores are explicitly B-bound controls. Their protocol/state may contain B; operational logs may not.
    const value = ch === 'request' ? backend.requests : ch === 'backend' ? backend.mutations
      : ch === 'operational' ? drivers.flatMap(d => d.operational) : ch === 'stderr' ? drivers.flatMap(d => d.stderr) : cap?.[ch]();
    if (value === undefined) continue;
    const version = hash(JSON.stringify(value));
    if (result.capture_hashes[ch] === version) continue;
    if (!result.channels_scanned.includes(ch)) result.channels_scanned.push(ch);
    result.capture_hashes[ch] = version;
    if (ch === 'request') { result.request_marker_observations = scan(ch, value); appendFailures(result, egressFailures(c.id, backend)); }
    else appendFailures(result, scan(ch, value).map(evidenceFromHit));
    } catch {
      // An unreadable channel never masks disclosures in the remaining channels.
      delete result.capture_hashes[ch]; result.channels_scanned = result.channels_scanned.filter(c => c !== ch);
      appendFailures(result, [{ channel: ch, predicate: 'capture readable', expected: true, observed: false }]);
    }
  }
  return result.failures.some(isDisclosure);
}
const appendFailures = (result: CellReport, failures: Evidence[]) => {
  const seen = new Set(result.failures.map(f => JSON.stringify(f)));
  for (const failure of failures) if (!seen.has(JSON.stringify(failure))) { result.failures.push(failure); seen.add(JSON.stringify(failure)); }
};
/** These collectors never short-circuit each other, including after an unrelated assertion threw (N4). */
function collectProhibited(c: IsolationCase, backend: Backend, initialDigest: string | undefined, result: CellReport): void {
  const collect = (fn: () => void) => { try { fn(); } catch (e) { appendFailures(result, [e instanceof OracleFailure ? e.evidence : { channel: 'harness', predicate: 'prohibited evidence readable', expected: true, observed: false }]); } };
  collect(() => check(backend.targetSinks().length === 0, 'request', 'zero target traffic at live sinks', 0, backend.targetSinks().length));
  if (initialDigest !== undefined) collect(() => check(initialDigest === backend.digest(), 'backend', 'clinical mutation digest unchanged'));
  for (const request of backend.requests.filter(r => r.phase === 'target' && r.kind === 'clinical')) {
    collect(() => check(request.method === 'GET', 'backend', 'all clinical methods are GET', 'GET', request.method));
    collect(() => {
      const url = new URL(request.raw_target, backend.base);
      const allowedBindings = ['B2-CUR-04', 'B2-HND-01'].includes(c.id) ? [A, B] : [A];
      const type = url.pathname.slice(new URL(backend.base).pathname.length);
      if (['Observation', 'DiagnosticReport'].includes(type)) check(request.pairs.some(p => ['patient', 'subject'].includes(p.name) && allowedBindings.some(id => p.value === `Patient/${id}`)), 'request', 'ordinary search retains immutable patient confinement');
      if (type === 'Patient') check(request.pairs.some(p => p.name === '_id' && allowedBindings.includes(p.value)), 'request', 'ordinary Patient search retains trusted _id');
      if (url.searchParams.has('_getpages')) check(backend.opaqueLedger.has(url.searchParams.get('_getpages')!), 'request', 'opaque token appears in independent source ledger');
    });
  }
  collect(() => appendFailures(result, egressFailures(c.id, backend)));
}
/** Normalize only known random identities, fixture listener origins and absolute clock observations. Keep order,
 * ordered pairs, credential equivalence, counts, store topology/content/authority, audit outcomes and ttl durations. */
export function workFingerprint(backend: Backend, drivers: readonly Driver[], counts: Counts): string {
  const symbols = new Map<string, string>();
  const symbol = (s: string, prefix: string) => { if (!symbols.has(s)) symbols.set(s, `${prefix}-${symbols.size}`); return symbols.get(s)!; };
  const states = drivers.map(d => d.state());
  const collectKeys = (v: unknown): void => {
    if (Array.isArray(v)) { for (const child of v) collectKeys(child); }
    else if (v && typeof v === 'object') for (const [key, child] of Object.entries(v)) {
      if (['blobs', 'shared'].includes(key) && Array.isArray(child)) for (const entry of child) if (Array.isArray(entry) && typeof entry[0] === 'string') symbol(entry[0], 'store-key');
      collectKeys(child);
    }
  };
  states.forEach(collectKeys);
  const times = new Set(['timestamp', 'retrievedAt', 'retrieved_at', 'capturedAt', 'captured_at', 'expiresAt', 'expires_at', 'metadataExpiresAt', 'elapsed_ms']);
  const walk = (v: unknown, key = ''): unknown => {
    if (times.has(key)) return '<clock>';
    if (key === 'request_id' && typeof v === 'string') return symbol(v, 'request');
    if (key === 'credential_fingerprint' && typeof v === 'string') return symbol(v, 'credential');
    if (typeof v === 'string') {
      if (symbols.has(v)) return symbols.get(v);
      if (/^(cur|res)_[A-Za-z0-9_-]+$/.test(v)) return symbol(v, v.slice(0, 3));
      return v.replaceAll(new URL(backend.base).origin, '<source>').replaceAll(new URL(backend.sinkUrl).origin, '<sink>');
    }
    if (Array.isArray(v)) return v.map(x => walk(x));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, child]) => [k, walk(child, k)]));
    return v;
  };
  const calls = drivers.flatMap(d => d.calls).filter(Boolean), envelopes = calls.map(stableEnvelope);
  const stableSizes = calls.map((call, i) => {
    const wire = { ...call.wire };
    if (wire.structuredContent) wire.structuredContent = envelopes[i];
    if (Array.isArray(wire.content)) wire.content = wire.content.map(item => {
      const value = item as { type: string; text?: string };
      if (value.type !== 'text' || !value.text) return value;
      try { return { ...value, text: JSON.stringify(stableEnvelope({ ...call, envelope: JSON.parse(value.text) })) }; } catch { return value; }
    });
    return Buffer.byteLength(JSON.stringify(wire));
  });
  // The raw byte ceiling is enforced before this digest. Remove only the measured wire-size delta attributable
  // to the already normalized clock/random fields; retain any discrepancy in the recorded maximum.
  const stableCounts = { ...counts, max_call_bytes: counts.max_call_bytes - Math.max(0, ...calls.map(c => c.bytes)) + Math.max(0, ...stableSizes) };
  return hash(JSON.stringify(walk({ requests: backend.requests.filter(r => r.phase === 'target'), counts: stableCounts,
    state: states, audit: drivers.map(d => d.audit()), output: normalize(envelopes) })));
}
const freshResult = (kind: Driver['kind'], run: number): CellReport => ({ lane: kind, era: kind === 'core' ? 'core/public-serializer' : kind === 'sdk-modern' ? '2026-07-28' : '2025-11-25', run, verdict: 'PASS', channels_scanned: [], channels_na: kind === 'core' ? ['raw_frame', 'stderr'] : ['audit', 'state'], failures: [], control_result: 'NOT_RUN', stubs: [], request_counts: {}, request_marker_observations: [], tool_calls: 0, retained_followups: 0, capture_hashes: {}, fingerprint: '',
  arms: { control: zeroCounts(), attack: zeroCounts(), followups: zeroCounts() }, pre_stub: zeroCounts(), timing: { cell_ms: 0, control_ms: 0, attack_ms: 0, followups_ms: 0, checks_ms: 0, stubs_ms: 0 }, phase: 'start', stub_counts: {} });
const settle = async (body: Promise<unknown>, ms: number) => { let timer: NodeJS.Timeout | undefined; try { await Promise.race([body, new Promise(resolve => { timer = setTimeout(resolve, ms); })]); } finally { if (timer) clearTimeout(timer); } };
/** One execution cell. The outer function owns the backend and the watchdog (deadline_ms is a harness limit, never an
 * oracle: expiry is INCONCLUSIVE unless the captured channels already hold a disclosure, which is FAIL). The body writes
 * into a private result that is published only if it finishes in time; on expiry the published result is a copy taken
 * at the deadline, so the abandoned body can never change the returned report (review M1). Every driver the cell opened
 * is closed and the abandoned body is given a bounded time to settle before the next cell starts. */
export async function runCell(c: IsolationCase, kind: Driver['kind'], run: number, hooks: RunCellHooks = {}): Promise<CellReport> {
  const backend = await startBackend();
  const drivers: Driver[] = []; cellDrivers.current = drivers;
  const state: DriverScope & { driver?: Driver; initialDigest?: string } = { aborted: false, drivers, cliScript: hooks.cliScript, onChild: hooks.onChild };
  const work = freshResult(kind, run);
  let result = work;
  const started = performance.now();
  let timer: NodeJS.Timeout | undefined; let expired = false;
  const deadline = new Promise<'deadline'>(resolve => { timer = setTimeout(() => resolve('deadline'), c.budgets.deadline_ms); timer.unref(); });
  const body = driverScope.run(state, () => runCellBody(c, kind, backend, work, state, hooks)).then(() => 'done' as const, () => 'done' as const);
  try {
    if (await Promise.race([body, deadline]) === 'deadline') {
      expired = true;
      state.aborted = true;
      result = structuredClone(work);
      // Snapshot every current channel before close can clear the retained state.
      collectProhibited(c, backend, state.initialDigest, result);
      const disclosed = scanRemaining(c, backend, drivers, result);
      result.verdict = disclosed ? 'FAIL' : 'INCONCLUSIVE';
      if (!disclosed) result.failures.push({ channel: 'harness', predicate: 'b2.watchdog.deadline', expected: c.budgets.deadline_ms, observed: `exceeded in phase ${result.phase}` });
    }
  } finally {
    if (timer) clearTimeout(timer);
    // Post-stub counts, for the record: budgets were enforced on the pre-stub snapshot above.
    for (const kind of ['metadata', 'clinical', 'sink', 'probe', 'auth']) result.request_counts[kind] = backend.requests.filter(r => r.kind === kind && r.phase === 'target').length;
    result.timing.cell_ms = Math.round(performance.now() - started);
    collectProhibited(c, backend, state.initialDigest, result);
    scanRemaining(c, backend, drivers, result);
    for (const d of drivers.toReversed()) { await d.close().catch(() => undefined); scanRemaining(c, backend, drivers, result); }
    await backend.close();
    if (expired) await settle(body, 100);
    collectProhibited(c, backend, state.initialDigest, result);
    scanRemaining(c, backend, drivers, result);
    if (result.failures.some(isDisclosure) || (!expired && result.failures.length > 0 && result.verdict === 'PASS')) result.verdict = 'FAIL';
    if (cellDrivers.current === drivers) cellDrivers.current = undefined;
  }
  return result;
}
async function runCellBody(c: IsolationCase, kind: Driver['kind'], backend: Backend, result: CellReport, state: DriverScope & { driver?: Driver; initialDigest?: string }, hooks: RunCellHooks): Promise<void> {
  const abortable = () => { if (state.aborted) throw new Aborted(); };
  const since = (from: number) => Math.round(performance.now() - from);
  let driver: Driver | undefined;
  try {
    await backend.liveness(); abortable(); backend.begin(); state.initialDigest = backend.digest();
    await hooks.afterBackendStart?.(backend); abortable();
    driver = await createDriver(kind, backend.base, false, c.id === 'B2-CNT-16', true); abortable(); result.era = driver.era; state.driver = driver;
    await hooks.afterDriverStart?.(driver); abortable();
    // Positive control first: also proves request/audit/frame liveness independently of an attack refusal.
    result.phase = 'control'; const controlStart = performance.now();
    try { await scenario(c.id, true, driver, backend); result.control_result = 'PASS'; }
    catch (e) { if (e instanceof Aborted) throw e; result.control_result = 'FAIL'; result.failures.push(e instanceof OracleFailure ? e.evidence : { channel: 'control', predicate: 'control execution completes', expected: 'complete', observed: (e as Error).name }); }
    try {
    check(backend.requests.some(r => r.phase === 'target' && (r.kind === 'clinical' || r.kind === 'metadata')), 'request', 'positive control reaches independent recorder');
    if (kind === 'core') check(driver.audit().some(e => (e as { outcome?: string }).outcome === 'allowed'), 'audit', 'allowed audit event live');
    else {
      const frames = driver.raw.join('').split('\n').filter(Boolean).map(line => JSON.parse(line) as { jsonrpc?: string; result?: unknown; method?: unknown });
      check(frames.length > 0 && frames.every(f => f.jsonrpc === '2.0'), 'raw_frame', 'stdout consists of valid protocol frames');
      check(frames.some(f => f.result !== undefined), 'raw_frame', 'response frame capture live');
      check(driver.stderr.join('').includes('proxy-related environment present'), 'stderr', 'stderr capture liveness via harmless startup note');
    }
    if (c.id === 'B2-CNT-16') check(backend.requests.some(r => r.kind === 'clinical' && r.credential_fingerprint !== null), 'request', 'authenticated source control proves credential path live');
    } catch (e) { result.control_result = 'FAIL'; result.failures.push(e instanceof OracleFailure ? e.evidence : { channel: 'control', predicate: 'control capture live', expected: 'live', observed: (e as Error).name }); }
    result.arms.control = snapshot(backend, state.drivers); result.timing.control_ms = since(controlStart); abortable();
    result.phase = 'attack'; const attackStart = performance.now();
    let pending: string | undefined;
    try { await scenario(c.id, false, driver, backend); }
    catch (e) { if (e instanceof Aborted) throw e; if (e instanceof PendingObligation) pending = e.message; else result.failures.push(e instanceof OracleFailure ? e.evidence : { channel: 'harness', predicate: 'attack execution completes', expected: 'complete', observed: (e as Error).name }); }
    result.arms.attack = snapshot(backend, state.drivers); result.timing.attack_ms = since(attackStart); abortable();
    // Follow every returned handle through the public tool; do not stop at the initial inline payload.
    result.phase = 'followups'; const followupStart = performance.now();
    const handles = [...new Set(driver.calls.map(call => call.envelope.result?.handle).filter((h): h is string => Boolean(h)))];
    for (const handle of handles) {
      await driver.call('fhir_result', { handle, action: 'project', output: { format: 'fhir', max_bytes: 60000 } });
      abortable(); result.retained_followups++;
    }
    result.arms.followups = snapshot(backend, state.drivers); result.pre_stub = result.arms.followups; result.timing.followups_ms = since(followupStart); abortable();
    result.phase = 'checks'; const checksStart = performance.now();
    if (kind !== 'core') verifyProtocolFrames(driver.raw.join(''));
    collectProhibited(c, backend, state.initialDigest, result);
    scanRemaining(c, backend, state.drivers, result);
    const applicability = c.lanes.find(l => l.driver === kind)!.channel_capture;
    for (const channel of CHANNELS) if (applicability[channel].status === 'required') check(result.channels_scanned.includes(channel), channel, 'required capture exists');
    for (const opened of state.drivers) verifyResponseBindings(opened.calls);
    for (const call of state.drivers.flatMap(opened => opened.calls)) {
      verifyMeasuredBytes(call);
      check(call.bytes <= c.budgets.max_result_bytes, 'output_structured', 'actual serialized tool result fits byte ceiling', c.budgets.max_result_bytes, call.bytes);
      const wireError = call.wire.sdk_error ?? call.wire.library_error;
      if (!wireError) {
        const content = call.wire.content;
        check(Array.isArray(content) && content.every(item => (item as { type?: string }).type === 'text'), 'output_text', 'only implemented text content items');
      }
    }
    enforceBudgets(c, result.pre_stub);
    result.tool_calls = result.pre_stub.tool_calls;
    // Normalize random identities consistently across the complete sequence. Exact byte ceilings
    // are verified above; byte counts remain in this fingerprint and in equality assertions. Timing never enters it.
    result.fingerprint = workFingerprint(backend, state.drivers, result.pre_stub);
    result.timing.checks_ms = since(checksStart); abortable();
    result.phase = 'stubs'; const stubStart = performance.now();
    for (const stub of ['deny-all', 'overblocking'] as const) { result.stubs.push(await challengeControl(c.id, stub, driver, backend)); abortable(); result.stub_counts[stub] = snapshot(backend, state.drivers); }
    for (const stub of result.stubs) check(stub.verdict === 'PASS', 'control', `${stub.kind} rejected by positive control`, 'PASS', stub.verdict);
    result.timing.stubs_ms = since(stubStart);
    scanRemaining(c, backend, state.drivers, result);
    collectProhibited(c, backend, state.initialDigest, result);
    if (result.failures.length) result.verdict = 'FAIL';
    if (pending && result.verdict !== 'FAIL') { result.verdict = 'PENDING'; result.pending_reason = pending; }
    result.phase = 'done';
  } catch (e) {
    if (e instanceof Aborted || e instanceof DriverAborted || state.aborted) return;
    result.verdict = e instanceof OracleFailure ? 'FAIL' : 'INCONCLUSIVE';
    result.failures.push(e instanceof OracleFailure ? e.evidence : { channel: 'harness', predicate: 'execution/capture completes', expected: 'complete', observed: e instanceof SyntaxError ? 'invalid protocol frame' : (e as Error).name });
    collectProhibited(c, backend, state.initialDigest, result);
    // Still capture and scan after assertion failures; a failed control must not conceal a disclosure.
    if (driver) {
      if (result.pre_stub.tool_calls === 0 && result.arms.followups.tool_calls === 0) result.pre_stub = snapshot(backend, state.drivers);
      scanRemaining(c, backend, state.drivers, result);
      try { enforceBudgets(c, result.pre_stub); } catch (budget) { if (budget instanceof OracleFailure) result.failures.push(budget.evidence); }
      // Stub verdicts must remain present even when target assertions failed (never after a watchdog abort).
      if (!state.aborted) for (const stub of ['deny-all', 'overblocking'] as const) if (!result.stubs.some(s => s.kind === stub)) result.stubs.push(await challengeControl(c.id, stub, driver, backend));
      scanRemaining(c, backend, state.drivers, result);
      collectProhibited(c, backend, state.initialDigest, result);
      result.tool_calls = result.pre_stub.tool_calls;
    }
  }
}
export function verifyProtocolFrames(raw: string) {
  for (const line of raw.split('\n').filter(Boolean)) {
    let frame: { jsonrpc?: string }; try { frame = JSON.parse(line) as { jsonrpc?: string }; } catch { throw new OracleFailure({ channel: 'raw_frame', predicate: 'stdout contains protocol frames only', expected: 'valid JSON-RPC', observed: 'non-protocol line' }); }
    check(frame.jsonrpc === '2.0', 'raw_frame', 'stdout contains protocol frames only');
  }
}
export function verifyMeasuredBytes(call: { wire: Record<string, unknown>; bytes: number }) {
  check(call.bytes === Buffer.byteLength(JSON.stringify(call.wire)), 'output_structured', 'byte observation matches independently reconstructed wire');
}
export function verifyResponseBindings(calls: { envelope: { request_id?: string } }[]) {
  const ids = calls.map(c => c.envelope.request_id).filter(Boolean);
  check(new Set(ids).size === ids.length, 'output_structured', 'fresh invocation cannot borrow an earlier response identity');
}
export async function runCase(c: IsolationCase): Promise<CaseReport> {
  const lanes: CellReport[] = [];
  const selected = process.env.B2_CORE_ONLY === '1' ? ['core'] as const : kinds;
  for (const lane of selected) for (const run of [1, 2]) lanes.push(await runCell(c, lane, run));
  for (const lane of selected) {
    const [a, b] = lanes.filter(c => c.lane === lane);
    if (a!.verdict === 'PASS' && b!.verdict === 'PASS' && a!.fingerprint !== b!.fingerprint) {
      for (const r of [a!, b!]) { r.verdict = 'INCONCLUSIVE'; r.failures.push({ channel: 'determinism', predicate: 'fresh-fixture double-run agrees', expected: 'equal', observed: 'different' }); }
    }
  }
  const verdict = lanes.some(l => l.verdict === 'FAIL') ? 'FAIL' : lanes.some(l => l.verdict === 'INCONCLUSIVE') ? 'INCONCLUSIVE' : lanes.some(l => l.verdict === 'PENDING') ? 'PENDING' : 'PASS';
  const stdio = lanes.filter(l => l.lane !== 'core');
  const cliVerdict = stdio.some(l => l.verdict === 'FAIL') ? 'FAIL' : stdio.some(l => l.verdict === 'INCONCLUSIVE') ? 'INCONCLUSIVE' : stdio.some(l => l.verdict === 'PENDING') ? 'PENDING' : stdio.length ? 'PASS' : 'NOT_RUN';
  return { id: c.id, family: c.family, verdict, lanes, cli: { verdict: cliVerdict, source_lanes: ['sdk-modern', 'sdk-legacy'], channels_na: ['audit', 'state'], channels_scanned: [...new Set(stdio.flatMap(l => l.channels_scanned))] }, critical_mutants: c.critical_mutants };
}
export { validateAggregate } from './evidence.js';

/** Explicit scenario-owned exceptions: direct caller ingress read, or independently B-bound replay control.
 * Never exempt a credential/payload hit or a foreign selector in an A-bound search. */
export function egressFailures(id: string, backend: Awaited<ReturnType<typeof startBackend>>): Evidence[] {
  const failures: Evidence[] = [];
  for (const request of backend.requests.filter(r => r.phase === 'target')) {
    const copy = structuredClone(request);
    const url = new URL(copy.raw_target, backend.base);
    if (id === 'B2-CLS-01' && url.pathname === `/fhir/Observation/obs-${B}` && copy.pairs.length === 0) copy.raw_target = '/fhir/Observation/caller-origin-foreign-read';
    if (['B2-CUR-04', 'B2-HND-01'].includes(id)) {
      // The only permitted B marker is the trusted confinement pair on the second gateway.
      copy.pairs = copy.pairs.map(p => p.name === 'patient' && p.value === `Patient/${B}` ? { ...p, value: 'Patient/second-bound-control' } : p);
      if (url.pathname === '/fhir/Observation' && url.searchParams.getAll('patient').join() === `Patient/${B}`) { url.searchParams.set('patient', 'Patient/second-bound-control'); copy.raw_target = url.pathname + url.search; }
    }
    failures.push(...scan('request', copy).map(evidenceFromHit));
    if (!['B2-CUR-04', 'B2-HND-01'].includes(id)) for (const pair of request.pairs) {
      if (['patient', 'subject', '_id'].includes(pair.name) && pair.value !== (pair.name === '_id' ? A : `Patient/${A}`)) failures.push({ channel: 'request', predicate: 'no foreign patient pair in upstream request', expected: 'bound A', observed: 'foreign pair' });
    }
  }
  return failures;
}
export function reportReadiness(prerequisites: unknown, fixtureMatches: boolean): 'DIAGNOSTIC' | 'INCONCLUSIVE' {
  const p = prerequisites as Record<string, { verdict?: string }>;
  return fixtureMatches && ['manifest_and_verifier', 'scanners', 'server_traffic', 'backend_liveness', 'operational_sinks', 'barrier_schedule'].every(id => p[id]?.verdict === 'PASS') ? 'DIAGNOSTIC' : 'INCONCLUSIVE';
}
