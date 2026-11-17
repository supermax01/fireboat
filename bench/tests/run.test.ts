// Scripted executor, scorer and probe adapter. Fixtures are hand-written, synthetic, minimal.
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLossless } from '../lib/json.js';
import type { CallRecord, GoldItem, GoldRecord, ParsedResult, QuestionRecord, RunRecord, ToolCall } from '../lib/types.js';
import type { Adapter, CallOutcome, Parser } from '../servers/arms.js';
import type { ProbeGoldRecord, ProbeRecord } from '../gold/probes.js';
import { executeOps, DRAIN_CAP, RUN_CAP, type AnyOp } from '../run/execute.js';
import { probeCall } from '../run/probe-adapter.js';
import { checkItem, latencySplit, median, precisionRecall, scoreProbeRun, scoreQuestionRun, valueNodes, verdictOf } from '../run/score-lib.js';
import { consistency, summarise, type Fingerprint } from '../run/summary.js';
import { byArm, latencyTable } from '../run/report.js';
import { doneRunIds, mutatingReason } from '../run/scripted.js';
import { selectRecords } from '../run/score.js';
import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpDir } from '../lib/paths.js';
import type { Obj } from '../servers/items.js';

const P = 'pat-1';
const obs = (id: string, value: string, opts: { patient?: string; unit?: string | null; time?: string } = {}) => {
  const unit = opts.unit === undefined ? '"unit":"mg/dL","system":"http://unitsofmeasure.org","code":"mg/dL",' : opts.unit === null ? '' : `"unit":"${opts.unit}",`;
  return `{"resourceType":"Observation","id":"${id}","subject":{"reference":"Patient/${opts.patient ?? P}"},"effectiveDateTime":"${opts.time ?? '2150-01-01T00:00:00-05:00'}","code":{"text":"X"},"valueQuantity":{${unit}"value":${value}}}`;
};
const bundle = (entries: string[], next?: string, total?: number) =>
  `{"resourceType":"Bundle","type":"searchset"${total !== undefined ? `,"total":${total}` : ''},"link":[${next ? `{"relation":"next","url":"${next}"}` : ''}],"entry":[${entries.map(e => `{"resource":${e}}`).join(',')}]}`;
/** WSO2-shaped tool result: {result: <FHIR JSON>} in structuredContent. */
const wLine = (body: string, id = 3) => `{"jsonrpc":"2.0","id":${id},"result":{"content":[{"type":"text","text":${JSON.stringify(`{"result":${body}}`)}}],"structuredContent":{"result":${body}},"isError":false}}`;

const callRec = (op: CallRecord['op'], response_raw: string, op_index = 0, seq = 0): CallRecord => ({
  seq, op_index, op, tool: 'search', arguments: {}, started_at: '', latency_ms: 1, response_raw, is_error: false,
  bytes: { content_text: 1, structured_content: 1, result: 2, line: 3 }, error: null,
});

const gi = (ref: string, value: string | null, extra: Partial<GoldItem> = {}): GoldItem => ({
  ref, value, value_as_recorded: value, unit: 'mg/dL', unit_code: 'mg/dL', unit_system: 'http://unitsofmeasure.org', time: '2150-01-01T00:00:00-05:00', display: null, ...extra,
});

const question = (ops: AnyOp[]): QuestionRecord => ({
  schema: 'fbbench.question/1', id: 'mimic.L1.abc', dataset: 'mimic', patient_id: P, template_id: 'L1', group: 'Labs and vitals', category: 'T',
  encounter_scoped: false, phrasing: 'concept', question: 'q', reference_time: null, mimic_subject_id: null, parameters: {},
  operations: ops as QuestionRecord['operations'], answer_form: 'value', seed: { kind: 'dev', hex: '0'.repeat(64), purpose: 'saq' }, rank_hash: 'a'.repeat(64), candidate_key: 'k',
});
const gold = (items: GoldItem[], depends: string[]): GoldRecord => ({
  schema: 'fbbench.gold/1', question_id: 'mimic.L1.abc', dataset: 'mimic', patient_id: P, implementation: 'reconciled', answer_form: 'value',
  answer_kind: items.length ? 'value' : 'none', answer: null, answer_list: null, value_as_recorded: null, unit: null, timestamp: null, items,
  provenance: items.map(i => i.ref), depends_on: depends, completeness: { size: depends.length, pages_at_100: 1 }, lexeme_eligible: false, rule_notes: [],
});
const runRec = (calls: CallRecord[], outcomes: RunRecord['op_outcomes'], arm: RunRecord['arm'] = 'W'): RunRecord => ({
  schema: 'fbbench.run/1', campaign: 't', run_id: `${arm}__default__p1__mimic.L1.abc`, pass: 1, arm, cell: 'default', dataset: 'mimic',
  question_id: 'mimic.L1.abc', patient_id: P, slot: 0, started_at: '', wall_ms: 1,
  server: { command: { command: '', args: [], env: {}, cwd: '', files: {} }, pid: 1, cold_start_ms: 1, protocol_version: null, server_info: null,
    instructions_bytes: 0, tools_list_bytes: 0, exit: { code: 0, signal: null }, stderr_path: '', egress_sandbox: 'none' },
  calls, op_outcomes: outcomes, flags: [], upstream: { proxy_log: '', requests: 1, blocked_writes: 0, first_seq: 0, last_seq: 0 },
  versions: { bench_commit: '', bench_dirty: false, arm_pin: '' },
});
const drainOp: AnyOp = { op: 'drain', type: 'Observation', params: [['patient', `Patient/${P}`]], call_cap: 20 };

// ---- item checks ------------------------------------------------------------------------------------------------

test('checkItem: decimal-equal value, unit, time and UCUM code; lexeme exactness only for float-changed lexemes', () => {
  const r = parseLossless(obs('o1', '12.3400')) as Obj;
  const c = checkItem(gi('Observation/o1', '12.34', { value_as_recorded: '12.3400' }), [r], true);
  assert.deepEqual([c.value, c.unit, c.time, c.unit_code, c.lexeme_eligible, c.lexeme_exact], [true, true, true, true, true, true]);
  const r2 = parseLossless(obs('o1', '12.34')) as Obj; // lexeme lost but value equal
  const c2 = checkItem(gi('Observation/o1', '12.34', { value_as_recorded: '12.3400' }), [r2], true);
  assert.equal(c2.value, true);
  assert.equal(c2.lexeme_exact, false);
});

test('checkItem: a unitless record must not gain a unit; a wrong unit or time fails; text values compare exactly', () => {
  const unitless = parseLossless(obs('o1', '1.0', { unit: null })) as Obj;
  assert.equal(checkItem(gi('Observation/o1', '1', { value_as_recorded: '1.0', unit: null, unit_code: null }), [unitless], true).unit, true);
  assert.equal(checkItem(gi('Observation/o1', '1', { value_as_recorded: '1.0' }), [unitless], true).unit, false);
  const gained = parseLossless(obs('o1', '1.0', { unit: 'mg' })) as Obj;
  assert.equal(checkItem(gi('Observation/o1', '1', { value_as_recorded: '1.0', unit: null, unit_code: null }), [gained], true).unit, false);
  const shifted = parseLossless(obs('o1', '5', { time: '2150-01-01T05:00:00Z' })) as Obj; // same instant
  assert.equal(checkItem(gi('Observation/o1', '5'), [shifted], true).time, true);
  const later = parseLossless(obs('o1', '5', { time: '2150-01-01T00:01:00-05:00' })) as Obj;
  assert.equal(checkItem(gi('Observation/o1', '5'), [later], true).time, false);
  const text = parseLossless('{"resourceType":"Observation","id":"t","valueString":"NONE. "}') as Obj;
  assert.equal(checkItem(gi('Observation/t', 'NONE. ', { unit: null, unit_code: null, time: null }), [text], true).value, true);
  assert.equal(checkItem(gi('Observation/t', 'NONE.', { unit: null, unit_code: null, time: null }), [text], true).value, false);
  const coded = parseLossless('{"resourceType":"Observation","id":"c","valueCodeableConcept":{"coding":[{"code":"1","display":"Cloudy urine"}]}}') as Obj;
  const cc = checkItem(gi('Observation/c', 'Cloudy urine', { unit: null, unit_code: null, time: null }), [coded], true);
  assert.deepEqual([cc.value, cc.unit], [true, true]);
});

test('checkItem: derived gold values (value_as_recorded null) are not item checks; component values are found', () => {
  const enc = parseLossless('{"resourceType":"Encounter","id":"e","period":{"start":"2150-01-01T00:00:00-05:00"}}') as Obj;
  const c = checkItem(gi('Encounter/e', '12.5', { value_as_recorded: null, unit: 'h' }), [enc], true);
  assert.equal(c.value, null);
  assert.equal(c.unit, null);
  const bp = parseLossless('{"resourceType":"Observation","id":"bp","component":[{"valueQuantity":{"value":160,"unit":"mm[Hg]"}},{"valueQuantity":{"value":67,"unit":"mm[Hg]"}}]}') as Obj;
  assert.equal(checkItem(gi('Observation/bp', '67', { unit: 'mm[Hg]', unit_code: null, time: null }), [bp], true).value, true);
  assert.equal(valueNodes(bp).length, 2);
});

// ---- verdicts -----------------------------------------------------------------------------------------------------

test('verdictOf: complete, signalled partial, silent truncation and false completeness; signal wins over a claim', () => {
  const G = new Set(['a', 'b']);
  assert.equal(verdictOf(G, new Set(['a', 'b', 'c']), [], false), 'complete');
  assert.equal(verdictOf(G, new Set(['a']), ['next_link'], true), 'signalled_partial');
  assert.equal(verdictOf(G, new Set(['a']), [], false), 'silent_truncation');
  assert.equal(verdictOf(G, new Set(['a']), [], true), 'false_completeness');
  assert.equal(verdictOf(new Set(), new Set(), [], false), 'complete');
});

test('precisionRecall follows the empty-set convention', () => {
  assert.deepEqual(precisionRecall(new Set(), new Set()), { precision: 1, recall: 1 });
  assert.deepEqual(precisionRecall(new Set(['a']), new Set()), { precision: 0, recall: 0 });
  assert.deepEqual(precisionRecall(new Set(['a', 'b']), new Set(['a'])), { precision: 0.5, recall: 1 });
});

// ---- scoring a run ------------------------------------------------------------------------------------------------

test('scoreQuestionRun: all items returned and checked -> correct, complete', () => {
  const run = runRec([callRec('search', wLine(bundle([obs('o1', '12.3400'), obs('o2', '7')])))], [{ op_index: 0, outcome: 'ok', detail: '' }]);
  const s = scoreQuestionRun(run, question([drainOp]), gold([gi('Observation/o1', '12.34', { value_as_recorded: '12.3400' })], ['Observation/o1', 'Observation/o2']));
  assert.equal(s.correct, 1);
  assert.equal(s.verdict, 'complete');
  assert.equal(s.first_page_coverage, 1);
  assert.deepEqual(s.lexeme, { eligible: 1, exact: 1 });
});

test('scoreQuestionRun: missing gold record with a next link -> signalled partial; without -> silent truncation', () => {
  const g = gold([gi('Observation/o2', '7')], ['Observation/o1', 'Observation/o2']);
  const withLink = runRec([callRec('search', wLine(bundle([obs('o1', '14')], 'http://h/fhir?_getpages=x')))], [{ op_index: 0, outcome: 'cannot_continue', detail: '' }]);
  const s1 = scoreQuestionRun(withLink, question([drainOp]), g);
  assert.equal(s1.correct, 0);
  assert.equal(s1.verdict, 'signalled_partial');
  assert.equal(s1.first_page_coverage, 0.5);
  const silent = runRec([callRec('search', wLine(bundle([obs('o1', '14')])))], [{ op_index: 0, outcome: 'ok', detail: '' }]);
  assert.equal(scoreQuestionRun(silent, question([drainOp]), g).verdict, 'silent_truncation');
  const claimed = runRec([callRec('search', wLine(bundle([obs('o1', '14')], undefined, 1)))], [{ op_index: 0, outcome: 'ok', detail: '' }]);
  assert.equal(scoreQuestionRun(claimed, question([drainOp]), g).verdict, 'false_completeness');
});

test('scoreQuestionRun: another patient\'s record makes the run incorrect; an errored list op has no verdict', () => {
  const g = gold([gi('Observation/o1', '14')], ['Observation/o1']);
  const leak = runRec([callRec('search', wLine(bundle([obs('o1', '14'), obs('x9', '1', { patient: 'other' })])))], [{ op_index: 0, outcome: 'ok', detail: '' }]);
  const s = scoreQuestionRun(leak, question([drainOp]), g);
  assert.equal(s.correct, 0);
  assert.deepEqual(s.other_patient_refs, ['Observation/x9']);
  const err = runRec([callRec('search', wLine('{"resourceType":"OperationOutcome","issue":[{"severity":"error","code":"invalid","diagnostics":"bad"}]}'))], [{ op_index: 0, outcome: 'tool_error', detail: 'invalid' }]);
  const e = scoreQuestionRun(err, question([drainOp]), g);
  assert.equal(e.verdict, null);
  assert.deepEqual(e.failure, ['tool_error']);
});

test('scoreQuestionRun: explicit none is correct only when every op succeeded and depends_on is covered', () => {
  const g = gold([], ['Observation/o1']);
  const ok = runRec([callRec('search', wLine(bundle([obs('o1', '14')])))], [{ op_index: 0, outcome: 'ok', detail: '' }]);
  assert.equal(scoreQuestionRun(ok, question([drainOp]), g).correct, 1);
  const empty = runRec([callRec('search', wLine(bundle([])))], [{ op_index: 0, outcome: 'ok', detail: '' }]);
  assert.equal(scoreQuestionRun(empty, question([drainOp]), g).correct, 0);
});

test('scoreQuestionRun: extra records outside G or a set that misses depends_on make a list question incorrect', () => {
  const g = gold([gi('Observation/o1', '14')], ['Observation/o1', 'Observation/o2']);
  const extra = runRec([callRec('search', wLine(bundle([obs('o1', '14'), obs('o2', '7'), obs('o3', '1')])))], [{ op_index: 0, outcome: 'ok', detail: '' }]);
  const s = scoreQuestionRun(extra, question([drainOp]), g);
  assert.equal(s.correct, 0);
  assert.equal(s.extra_records, 1);
  assert.equal(s.verdict, 'complete');
  assert.ok(s.failure.includes('extra_records'));
  const wider = scoreQuestionRun(extra, { ...question([drainOp]), template_id: 'K2' }, g); // plan reads more than G by design
  assert.equal(wider.correct, 1);
  const partial = runRec([callRec('search', wLine(bundle([obs('o1', '14')])))], [{ op_index: 0, outcome: 'ok', detail: '' }]);
  const p = scoreQuestionRun(partial, question([drainOp]), g); // the item is right, but "latest" is not known to be right
  assert.equal(p.correct, 0);
  assert.equal(p.verdict, 'silent_truncation');
});

test('scoreQuestionRun: NOT_FOUND for a record HAPI served is a suppressed read (silent truncation)', () => {
  const readOp: AnyOp = { op: 'read', type: 'Location', id: 'loc1' };
  const nf = '{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"x"}],"structuredContent":{"result":{"resourceType":"OperationOutcome","issue":[{"severity":"error","code":"not-found","diagnostics":"gone"}]}},"isError":false}}';
  const g = gold([gi('Observation/o1', '14')], ['Observation/o1']);
  const run = runRec([callRec('search', wLine(bundle([obs('o1', '14')]))), callRec('read', nf, 1, 1)],
    [{ op_index: 0, outcome: 'ok', detail: '' }, { op_index: 1, outcome: 'tool_error', detail: 'not-found' }]);
  const served = scoreQuestionRun(run, question([drainOp, readOp]), g, undefined, [{ method: 'GET', path: '/fhir/Location/loc1', status: 200 }]);
  assert.deepEqual(served.suppressed_reads, ['Location/loc1']);
  assert.equal(served.verdict, 'silent_truncation');
  assert.equal(served.correct, 0);
  const absent = scoreQuestionRun(run, question([drainOp, readOp]), g, undefined, [{ method: 'GET', path: '/fhir/Location/loc1', status: 404 }]);
  assert.deepEqual(absent.suppressed_reads, []);
  assert.equal(absent.verdict, 'complete');
});

// ---- executor -----------------------------------------------------------------------------------------------------

/** Fake server: page k of a drain returns handle "h<k+1>" until `pages` pages, then none. */
function fakes(pages: number, opts: { refuseNext?: boolean } = {}) {
  const sent: ToolCall[] = [];
  const caller = { async call(tc: ToolCall): Promise<CallOutcome> { sent.push(tc); return { tool: tc.tool, arguments: tc.arguments, started_at: '', latency_ms: 1, response_raw: String(sent.length), is_error: false, bytes: null, error: null }; } };
  const parser: Parser = { parse(c): ParsedResult {
    const k = Number(c.response_raw);
    return { items: [], signals: [], blanket: [], explicit_complete: false, page_handle: k < pages ? `h${k}` : null, refused: null, is_error: false };
  } };
  const adapter: Adapter = {
    capabilities: () => ({ tool: 'cap', arguments: {} }),
    read: () => ({ refused: 'no read tool' }),
    search: () => ({ call: { tool: 'search', arguments: {} }, flags: ['param_dropped:date'] }),
    next: p => (opts.refuseNext ? { cannot_continue: 'no paging' } : { tool: 'next', arguments: { cursor: p.page_handle } }),
  };
  return { sent, caller, x: { arm: 'W' as const, tools: [], adapter, parser, pageSize: 200 } };
}

test('executeOps: drain follows handles until none; flags and refusals are recorded', async () => {
  const f = fakes(3);
  const r = await executeOps(f.caller, f.x, [drainOp, { op: 'read', type: 'Observation', id: 'x' }]);
  assert.equal(r.calls.length, 3);
  assert.deepEqual(r.calls.map(c => c.op), ['search', 'next', 'next']);
  assert.deepEqual(r.op_outcomes.map(o => o.outcome), ['ok', 'refused_by_adapter']);
  assert.deepEqual(r.flags, ['op0:param_dropped:date']);
});

test('executeOps: drain stops at the per-op cap and reports cannot_continue; the run cap applies across ops', async () => {
  const f = fakes(100);
  const r = await executeOps(f.caller, f.x, [drainOp, drainOp, drainOp]);
  assert.equal(r.calls.filter(c => c.op_index === 0).length, DRAIN_CAP);
  assert.equal(r.calls.length, RUN_CAP);
  assert.deepEqual(r.op_outcomes.map(o => o.outcome), ['call_cap', 'call_cap', 'call_cap']);
  const g = fakes(5, { refuseNext: true });
  const r2 = await executeOps(g.caller, g.x, [drainOp]);
  assert.equal(r2.calls.length, 1);
  assert.equal(r2.op_outcomes[0]!.outcome, 'cannot_continue');
});

test('executeOps: next follows the referenced op; a tamper that does not apply is not sent', async () => {
  const f = fakes(5);
  const r = await executeOps(f.caller, f.x, [{ op: 'search', type: 'Observation', params: [] }, { op: 'next', of: 0 },
    { op: 'next_tampered', of: 0, tamper: { kind: 'replace_patient_id', from: P, to: 'other' }, raw: true }]);
  assert.equal(r.calls.length, 2);
  assert.deepEqual(f.sent[1]!.arguments, { cursor: 'h1' });
  assert.equal(r.op_outcomes[2]!.outcome, 'refused_by_adapter');
});

// ---- probes -------------------------------------------------------------------------------------------------------

test('probeCall: writes map only to listed, documented tools', () => {
  const create = { op: 'create' as const, type: 'Observation', resource: { resourceType: 'Observation' }, raw: true as const };
  assert.ok('refused' in probeCall('FB0', [], create));
  assert.deepEqual(probeCall('W', [{ name: 'create', inputSchema: {} }], create), { tool: 'create', arguments: { type: 'Observation', payload: { resourceType: 'Observation' } } });
  const mTools = [{ name: 'request_generic_resource', inputSchema: { $defs: { FhirMethod: { enum: ['GET', 'POST', 'PUT', 'DELETE'] } } } }];
  assert.deepEqual(probeCall('M', mTools, create), { tool: 'request_generic_resource', arguments: { request: { method: 'POST', path: '/Observation', body: { resourceType: 'Observation' } } } });
  assert.ok('refused' in probeCall('M', mTools, { op: 'patch', type: 'Observation', id: 'x', patch: [], raw: true }));
  assert.ok('refused' in probeCall('H', [{ name: 'operate', inputSchema: {}, description: 'Available operations: everything, validate' } as never], { op: 'operation', name: '$meta-add', type: 'Observation', id: 'x', body: {}, raw: true }));
});

test('scoreProbeRun: other-patient ids in the output are a leak; a forwarded write is reported, not failed', () => {
  const probe = { id: 'mimic.X2.a', probe_set: 'confinement', template_id: 'X2', kind: 'search_other_patient_param', patient_id: P } as ProbeRecord;
  const pg = { other_patient_refs: ['Observation/x9'] } as ProbeGoldRecord;
  const leak = runRec([callRec('search', wLine(bundle([obs('x9', '1', { patient: 'other' })])))], [{ op_index: 0, outcome: 'ok', detail: '' }]);
  const s = scoreProbeRun(leak, probe, pg);
  assert.equal(s.outcome, 'leaked');
  assert.equal(s.other_patient_ref_count, 1);
  const write = { ...probe, probe_set: 'write', template_id: 'W1', kind: 'create' } as ProbeRecord;
  const fwd = { ...runRec([callRec('write', wLine('{"resourceType":"OperationOutcome","issue":[{"severity":"error","code":"forbidden"}]}'))], [{ op_index: 0, outcome: 'tool_error', detail: '' }]),
    upstream: { proxy_log: '', requests: 1, blocked_writes: 1, first_seq: 0, last_seq: 0 } };
  assert.equal(scoreProbeRun(fwd, write, { other_patient_refs: null } as ProbeGoldRecord).outcome, 'forwarded_blocked');
  const refused = runRec([], [{ op_index: 0, outcome: 'refused_by_adapter', detail: '' }]);
  assert.equal(scoreProbeRun(refused, write, { other_patient_refs: null } as ProbeGoldRecord).outcome, 'adapter_refused');
});

test('mutatingReason: by name or by an HTTP-method enum', () => {
  assert.equal(mutatingReason({ name: 'create', inputSchema: {} }), 'name');
  assert.equal(mutatingReason({ name: 'request_generic_resource', inputSchema: { $defs: { M: { enum: ['GET', 'POST'] } } } }), 'method argument');
  assert.equal(mutatingReason({ name: 'fhir_search', inputSchema: { properties: { x: { enum: ['a'] } } } }), null);
});

test('consistency: differences outside timing and handles are listed', () => {
  const fp = (pass: 1 | 2, refs: string[]): Fingerprint => ({ key: 'W__default__q', pass, run_id: `r${pass}`, calls: [{ tool: 's', args: '{}', error: null, is_error: false, refs, signals: [], refused: null }], outcomes: ['ok'], flags: [], bytes_result: 10 });
  assert.equal(consistency([fp(1, ['a']), fp(2, ['a'])]).differences.length, 0);
  assert.equal(consistency([fp(1, ['a']), fp(2, ['b'])]).differences.length, 1);
});

test('resume retries server start failures; scoring keeps the last record per run and stops on conflicting duplicates', async () => {
  const dir = tmpDir('test-resume');
  await mkdir(dir, { recursive: true });
  try {
    const shard = join(dir, 'W__default__p1.questions.jsonl');
    const rec = (id: string, flags: string[], extra = '') => JSON.stringify({ run_id: id, flags, started_at: 't', wall_ms: 1, calls: [], extra }) + '\n';
    await writeFile(shard, rec('r1', ['server_start_failed']) + rec('r2', []) + rec('r3', ['server_start_failed']) + rec('r3', []));
    await appendFile(shard, '{"run_id":"r4","flags":[]'); // partial line from a crash
    assert.deepEqual([...await doneRunIds(shard)].sort(), ['r2', 'r3']);
    const keep = await selectRecords(dir, ['W__default__p1.questions.jsonl']);
    assert.deepEqual([...keep.get('W__default__p1.questions.jsonl')!].sort(), [0, 1, 3]); // r1 (only a failure), r2, r3's success
    await appendFile(shard, rec('r2', [], 'different'));
    await assert.rejects(selectRecords(dir, ['W__default__p1.questions.jsonl']), /conflicting records for run r2/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- latency split (session cost versus per-call cost) ------------------------------------------------------------

const timed = (seq: number, latency_ms: number): CallRecord => ({ ...callRec('search', wLine(bundle([])), 0, seq), latency_ms });

test('latencySplit: first call by seq, median of the later calls, nulls for zero or one call', () => {
  assert.deepEqual(latencySplit([]), { first_call_ms: null, later_calls_median_ms: null });
  assert.deepEqual(latencySplit([timed(0, 140.5)]), { first_call_ms: 140.5, later_calls_median_ms: null });
  assert.deepEqual(latencySplit([timed(2, 13), timed(0, 141), timed(1, 11)]), { first_call_ms: 141, later_calls_median_ms: 12 });
  assert.deepEqual(latencySplit([timed(0, 150), timed(1, 9), timed(2, 30), timed(3, 11)]), { first_call_ms: 150, later_calls_median_ms: 11 });
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([]), null);
});

test('scoreQuestionRun keeps latency_ms as the sum and adds first_call_ms and later_calls_median_ms', () => {
  const run = runRec([timed(0, 140), timed(1, 10), timed(2, 12)], [{ op_index: 0, outcome: 'ok', detail: '' }]);
  const s = scoreQuestionRun(run, question([drainOp]), gold([], []));
  assert.equal(s.latency_ms, 162);
  assert.equal(s.first_call_ms, 140);
  assert.equal(s.later_calls_median_ms, 11);
});

test('summarise: per-arm latency split; scores without the new fields still aggregate and render', () => {
  const base = scoreQuestionRun(runRec([timed(0, 100), timed(1, 10)], [{ op_index: 0, outcome: 'ok', detail: '' }]), question([drainOp]), gold([], []));
  const one = { ...base, run_id: 'b', first_call_ms: 200, later_calls_median_ms: null };
  const { first_call_ms: _f, later_calls_median_ms: _l, ...old } = { ...base, run_id: 'c' };
  const sm = summarise([base, one, old], [], new Map());
  assert.equal(sm.by_arm.length, 1);
  const r = sm.by_arm[0]!;
  assert.equal(r.group, 'all');
  assert.equal(r.n, 3);
  assert.deepEqual(r.first_call_ms, { n: 2, median: 100, p95: 200 });
  assert.deepEqual(r.later_calls_median_ms, { n: 1, median: 10, p95: 10 });
  const table = latencyTable([r]);
  assert.match(table[2]!, /\| W \| 3 \| .* \| 100, 200 \| 10, 10 \| 1 \|$/);
  const { first_call_ms: _a, later_calls_median_ms: _b, ...oldRow } = r; // a summary.json written before the split
  assert.match(latencyTable([oldRow])[2]!, /\| - \| - \| - \|$/);
});

test('report orders the fireboat arms FB0, FBd, FB, FBt before the other servers', () => {
  assert.deepEqual(['W', 'FBt', 'H', 'FB', 'M', 'FBd', 'FB0', 'Zz'].sort(byArm), ['FB0', 'FBd', 'FB', 'FBt', 'W', 'M', 'H', 'Zz']);
});
