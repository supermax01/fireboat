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
import { ANSWER_ENTRIES, answerOptions } from '../gold/rules.js';

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

// ---- answer entries read from returned copies (ANSWER_ENTRIES): question scope N2, K2 ------------------------------

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const NOTE_TIME = '2020-03-01T10:00:00Z';
/** A synthetic Synthea-style note; `text` null = metadata only (no attachment data). */
const noteDoc = (id: string, text: string | null) =>
  `{"resourceType":"DocumentReference","id":"${id}","status":"current","subject":{"reference":"Patient/${P}"},"date":"${NOTE_TIME}","type":{"text":"Note"},` +
  `"content":[{"attachment":{"contentType":"text/plain"${text === null ? '' : `,"data":"${b64(text)}"`}}}]}`;
/** fireboat-shaped tool result: the envelope in structuredContent. */
const fbLine = (resources: string[]) => {
  const env = `{"schema_version":"0.3","data":{"resources":[${resources.join(',')}]},"coverage":{"state":"complete_for_query","scope":"query","reasons":[]},"pagination":{"has_more":false}}`;
  return `{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":${JSON.stringify(env)}}],"structuredContent":${env},"isError":false}}`;
};
const noteGold = (ref: string, list: string[] | null, time = NOTE_TIME): GoldRecord => ({
  ...gold([gi(ref, null, { value_as_recorded: null, unit: null, unit_code: null, unit_system: null, time })], [ref]),
  answer_form: 'list', answer_kind: list ? 'list' : 'none', answer_list: list,
});
const listQuestion = (template_id: string, type: string): QuestionRecord => ({
  ...question([{ op: 'drain', type, params: [['patient', `Patient/${P}`]], call_cap: 20 }]), template_id, category: 'R', answer_form: 'list',
});
const okRun = (line: string, arm: RunRecord['arm'] = 'W') => runRec([callRec('search', line)], [{ op_index: 0, outcome: 'ok', detail: '' }], arm);
const NOTE = 'Note.\n\nPatient has a history of Asthma, Hypertension.\nPatient is presenting with Sprain of ankle.\n';
const N2_LIST = ['Asthma', 'Hypertension', 'Sprain of ankle'];

test('answer text: N2 with the full note text passes; answer_text is recorded', () => {
  const s = scoreQuestionRun(okRun(wLine(bundle([noteDoc('d1', NOTE)]))), listQuestion('N2', 'DocumentReference'), noteGold('DocumentReference/d1', N2_LIST));
  assert.equal(s.correct, 1);
  assert.deepEqual(s.answer_text, { checked: 1, ok: 1 });
  assert.ok(!s.failure.includes('answer_text_missing'));
});

test('answer text: N2 with note metadata only fails with answer_text_missing; identity and time still pass', () => {
  const g = noteGold('DocumentReference/d1', N2_LIST);
  const run = okRun(fbLine([noteDoc('d1', null)]), 'FB');
  const r = parseLossless(noteDoc('d1', null)) as Obj;
  const c = checkItem(g.items[0]!, [r], true, { expected: N2_LIST, from: copy => answerOptions(ANSWER_ENTRIES.N2!, copy, () => [], {}), mode: 'equal' });
  assert.deepEqual([c.found, c.identity, c.time, c.text], [true, true, true, false]);
  const s = scoreQuestionRun(run, listQuestion('N2', 'DocumentReference'), g);
  assert.equal(s.correct, 0);
  assert.equal(s.verdict, 'complete');
  assert.deepEqual(s.answer_text, { checked: 1, ok: 0 });
  assert.ok(s.failure.includes('answer_text_missing'));
});

test('answer text: N2 whose returned note lists other conditions fails', () => {
  const other = 'Note.\n\nPatient has a history of Asthma.\nPatient is presenting with Otitis media.\n';
  const s = scoreQuestionRun(okRun(wLine(bundle([noteDoc('d1', other)]))), listQuestion('N2', 'DocumentReference'), noteGold('DocumentReference/d1', N2_LIST));
  assert.equal(s.correct, 0);
  assert.ok(s.failure.includes('answer_text_missing'));
});

test('answer text: an N2 gold "none" passes only when the copy carries text that lists nothing', () => {
  const g = noteGold('DocumentReference/d1', null);
  const q = listQuestion('N2', 'DocumentReference');
  assert.equal(scoreQuestionRun(okRun(wLine(bundle([noteDoc('d1', 'Note.\n\nNothing to report.\n')]))), q, g).correct, 1);
  const bare = scoreQuestionRun(okRun(fbLine([noteDoc('d1', null)]), 'FB'), q, g);
  assert.equal(bare.correct, 0);
  assert.ok(bare.failure.includes('answer_text_missing'));
});

test('answer text: the same DocumentReference gets the same verdict in the WSO2 and fireboat envelopes', () => {
  const q = listQuestion('N2', 'DocumentReference');
  const g = noteGold('DocumentReference/d1', N2_LIST);
  for (const doc of [noteDoc('d1', NOTE), noteDoc('d1', null)]) {
    const w = scoreQuestionRun(okRun(wLine(bundle([doc]))), q, g);
    const fb = scoreQuestionRun(okRun(fbLine([doc]), 'FB'), q, g);
    assert.deepEqual([fb.correct, fb.answer_text, fb.failure], [w.correct, w.answer_text, w.failure]);
  }
});

const careTeam = (patientDisplay: boolean) =>
  `{"resourceType":"CareTeam","id":"ct1","status":"active","subject":{"reference":"Patient/${P}"},"period":{"start":"2020-01-01T00:00:00Z"},"participant":[` +
  `{"role":[{"coding":[{"code":"116154003","display":"Patient"}]}],"member":{"reference":"Patient/${P}"${patientDisplay ? ',"display":"Ms. Synthetic Person"' : ''}}},` +
  `{"role":[{"coding":[{"code":"223366009","display":"Healthcare professional"}]}],"member":{"reference":"Practitioner/pr1","display":"Dr. Example Doctor"}}]}`;
const K2_LIST = ['Dr. Example Doctor (Healthcare professional)', 'Ms. Synthetic Person (Patient)'];

test('answer text: K2 passes with every member display and fails with the patient\'s own display removed', () => {
  const q = listQuestion('K2', 'CareTeam');
  const g = noteGold('CareTeam/ct1', K2_LIST, '2020-01-01T00:00:00Z');
  const full = scoreQuestionRun(okRun(fbLine([careTeam(true)]), 'FB'), q, g);
  assert.equal(full.correct, 1);
  assert.deepEqual(full.answer_text, { checked: 1, ok: 1 });
  const withheld = scoreQuestionRun(okRun(fbLine([careTeam(false)]), 'FB'), q, g);
  assert.equal(withheld.correct, 0);
  assert.deepEqual(withheld.answer_text, { checked: 1, ok: 0 });
  assert.ok(withheld.failure.includes('answer_text_missing'));
});

test('answer text: a value template is not text-checked', () => {
  const r = parseLossless(obs('o1', '5')) as Obj;
  assert.equal(checkItem(gi('Observation/o1', '5'), [r], true).text, null);
  const s = scoreQuestionRun(okRun(wLine(bundle([obs('o1', '5')]))), question([drainOp]), gold([gi('Observation/o1', '5')], ['Observation/o1']));
  assert.equal(s.correct, 1);
  assert.equal(s.answer_text, undefined);
});

// ---- answer entries: item scope (referenced Medication, Location, Specimen), question scope, set scope --------------

type Arm = RunRecord['arm'];
/** A run with one drain per response, every operation ok; `resources[i]` are the records the i-th operation returned. */
function entryRun(arm: Arm, resources: string[][]): { run: RunRecord; ops: AnyOp[] } {
  const ops: AnyOp[] = resources.map((_, i) => ({ op: 'drain', type: `T${i}`, params: [['patient', `Patient/${P}`]], call_cap: 20 }));
  const calls = resources.map((rs, i) => callRec('search', arm === 'W' ? wLine(bundle(rs)) : fbLine(rs), i, i));
  return { run: runRec(calls, resources.map((_, i) => ({ op_index: i, outcome: 'ok' as const, detail: '' })), arm), ops };
}
const listGold = (items: GoldItem[], depends: string[], list: string[] | null): GoldRecord => ({
  ...gold(items, depends), answer_form: 'list', answer_kind: list ? 'list' : 'none', answer_list: list,
});
const textItem = (ref: string, display: string | null, time: string | null = null): GoldItem =>
  gi(ref, null, { value_as_recorded: null, unit: null, unit_code: null, unit_system: null, time, display });
function scoreEntries(template_id: string, parameters: Record<string, string>, g: GoldRecord, resources: string[][], arm: Arm = 'W') {
  const { run, ops } = entryRun(arm, resources);
  return scoreQuestionRun(run, { ...question(ops), template_id, category: 'R', answer_form: 'list', parameters }, g);
}
const failedText = (s: ReturnType<typeof scoreEntries>) => s.correct === 0 && s.failure.includes('answer_text_missing');
const passed = (s: ReturnType<typeof scoreEntries>) => s.correct === 1 && !s.failure.includes('answer_text_missing') && s.answer_text!.ok === s.answer_text!.checked;

const MA_TIME = '2150-01-02T00:00:00Z';
const admin = (medication: string | null) => JSON.stringify({ resourceType: 'MedicationAdministration', id: 'ma1', status: 'completed', subject: { reference: `Patient/${P}` },
  effectiveDateTime: MA_TIME, ...(medication ? { medicationReference: { reference: medication } } : {}) });
const med = (id: string, body: object) => JSON.stringify({ resourceType: 'Medication', id, ...body });
const DRUG_GOLD = listGold([textItem('MedicationAdministration/ma1', 'Drug X', MA_TIME)], ['Medication/m1', 'MedicationAdministration/ma1'], ['Drug X']);
const G1_P = { encounter: 'Encounter/e1', encounter_start: '2150-01-01T00:00:00Z' };

test('answer entries, item scope: a drug named through its referenced Medication passes only when the Medication copy carries the gold name', () => {
  const full = med('m1', { code: { text: 'Drug X', coding: [{ system: 'http://example.org/cs', code: 'x', display: 'Drug X display' }] } });
  assert.ok(passed(scoreEntries('G1', G1_P, DRUG_GOLD, [[admin('Medication/m1')], [full]])));
  // the order's reference removed
  assert.ok(failedText(scoreEntries('G1', G1_P, DRUG_GOLD, [[admin(null)], [full]])));
  // the name altered
  assert.ok(failedText(scoreEntries('G1', G1_P, DRUG_GOLD, [[admin('Medication/m1')], [med('m1', { code: { text: 'Drug Y' } })]])));
  // the referenced Medication absent
  assert.ok(failedText(scoreEntries('G1', G1_P, DRUG_GOLD, [[admin('Medication/m1')], []])));
  // the Medication present without a name
  assert.ok(failedText(scoreEntries('G1', G1_P, DRUG_GOLD, [[admin('Medication/m1')], [med('m1', { status: 'active' })]])));
  // only the coding display kept, not the code.text the gold names the drug by
  assert.ok(failedText(scoreEntries('G1', G1_P, DRUG_GOLD, [[admin('Medication/m1')], [med('m1', { code: { coding: [{ system: 'http://example.org/cs', code: 'x', display: 'Drug X display' }] } })]])));
});

test('answer entries, item scope: a mix is named by every ingredient\'s returned copy; one ingredient absent fails', () => {
  const g = listGold([textItem('MedicationAdministration/ma1', 'Drug A + Drug B', MA_TIME)], ['Medication/a', 'Medication/b', 'Medication/mix', 'MedicationAdministration/ma1'], ['Drug A + Drug B']);
  const mix = med('mix', { ingredient: [{ itemReference: { reference: 'Medication/a' } }, { itemReference: { reference: 'Medication/b' } }] });
  const a = med('a', { code: { text: 'Drug A' } }), b = med('b', { code: { text: 'Drug B' } });
  assert.ok(passed(scoreEntries('O3', G1_P, g, [[admin('Medication/mix')], [mix, a, b]])));
  assert.ok(failedText(scoreEntries('O3', G1_P, g, [[admin('Medication/mix')], [mix, a]])));
});

const ICU_ENC = JSON.stringify({ resourceType: 'Encounter', id: 'icu', subject: { reference: `Patient/${P}` }, period: { start: '2150-01-01T00:00:00Z' }, location: [{ location: { reference: 'Location/l1' } }] });
const loc = (body: object) => JSON.stringify({ resourceType: 'Location', id: 'l1', ...body });
const E2_GOLD = listGold([textItem('Location/l1', 'MICU')], ['Encounter/icu', 'Location/l1'], ['MICU']);
const E2_P = { encounter: 'Encounter/icu', encounter_start: '2150-01-01T00:00:00Z' };

test('answer entries, item scope: a Location passes with its name; name removed or altered fails; Location absent fails', () => {
  assert.ok(passed(scoreEntries('E2', E2_P, E2_GOLD, [[ICU_ENC], [loc({ name: 'MICU' })]])));
  assert.ok(failedText(scoreEntries('E2', E2_P, E2_GOLD, [[ICU_ENC], [loc({ status: 'active' })]])));
  assert.ok(failedText(scoreEntries('E2', E2_P, E2_GOLD, [[ICU_ENC], [loc({ name: 'SICU' })]])));
  const absent = scoreEntries('E2', E2_P, E2_GOLD, [[ICU_ENC], []]);
  assert.equal(absent.correct, 0);
  assert.deepEqual(absent.answer_text, { checked: 0, ok: 0 });
});

const MICRO = 'http://example.org/fhir/CodeSystem/microbiology';
const spec = (type: string | null) => JSON.stringify({ resourceType: 'Specimen', id: 's1', subject: { reference: `Patient/${P}` }, collection: { collectedDateTime: '2150-01-01T10:00:00Z' },
  ...(type ? { type: { coding: [{ display: type }] } } : {}) });
const TEST = JSON.stringify({ resourceType: 'Observation', id: 't1', subject: { reference: `Patient/${P}` }, code: { coding: [{ system: `${MICRO}-test`, code: 't', display: 'Culture' }] }, specimen: { reference: 'Specimen/s1' } });
const ORG = JSON.stringify({ resourceType: 'Observation', id: 'org', subject: { reference: `Patient/${P}` }, effectiveDateTime: '2150-01-02T00:00:00Z',
  code: { coding: [{ system: `${MICRO}-organism`, code: 'o', display: 'E. COLI' }] }, derivedFrom: [{ reference: 'Observation/t1' }] });
const B1_GOLD = listGold([textItem('Observation/org', 'E. COLI (URINE)', '2150-01-02T00:00:00Z')], ['Observation/org', 'Observation/t1', 'Specimen/s1'], ['E. COLI (URINE)']);

test('answer entries, item scope: an organism entry needs its test and Specimen copies; Specimen absent, type removed or altered fails', () => {
  const p = { date: '2150-01-01' };
  assert.ok(passed(scoreEntries('B1', p, B1_GOLD, [[spec('URINE')], [TEST], [ORG]])));
  assert.ok(failedText(scoreEntries('B1', p, B1_GOLD, [[], [TEST], [ORG]])));
  assert.ok(failedText(scoreEntries('B1', p, B1_GOLD, [[spec(null)], [TEST], [ORG]])));
  assert.ok(failedText(scoreEntries('B1', p, B1_GOLD, [[spec('BLOOD')], [TEST], [ORG]])));
  // a copy of the specimen collected on another day is not the on-date specimen
  assert.ok(failedText(scoreEntries('B1', { date: '2150-01-03' }, B1_GOLD, [[spec('URINE')], [TEST], [ORG]])));
});

const patient = (body: object) => JSON.stringify({ resourceType: 'Patient', id: P, ...body });
const D1_LIST = ['birth_date: 1970-01-02', 'deceased: alive', 'gender: female'];
const D1_GOLD = listGold([textItem(`Patient/${P}`, null)], [`Patient/${P}`], D1_LIST);
const stay = (period: object) => JSON.stringify({ resourceType: 'Encounter', id: 'e1', subject: { reference: `Patient/${P}` }, period });
const E3_GOLD: GoldRecord = { ...gold([{ ...textItem('Encounter/e1', null, '2150-01-01T08:00:00Z'), value: '25.5', unit: 'h', unit_code: 'h' }], ['Encounter/e1']), answer: '25.5' };

test('answer entries, question scope: demographics and length of stay pass with the fields; removed or altered fails', () => {
  assert.ok(passed(scoreEntries('D1', {}, D1_GOLD, [[patient({ birthDate: '1970-01-02', gender: 'female' })]])));
  assert.ok(failedText(scoreEntries('D1', {}, D1_GOLD, [[patient({ gender: 'female' })]])));
  assert.ok(failedText(scoreEntries('D1', {}, D1_GOLD, [[patient({ birthDate: '1970-01-02', gender: 'male' })]])));
  const e3 = (period: object) => scoreEntries('E3', { encounter: 'Encounter/e1' }, E3_GOLD, [[stay(period)]]);
  assert.ok(passed(e3({ start: '2150-01-01T08:00:00Z', end: '2150-01-02T09:30:00Z' })));
  assert.ok(failedText(e3({ start: '2150-01-01T08:00:00Z' })));
  assert.ok(failedText(e3({ start: '2150-01-01T08:00:00Z', end: '2150-01-02T10:30:00Z' })));
  // an empty gold list passes on a copy that yields an empty list
  const reasons = (body: object) => scoreEntries('E4', { date: '2150-01-01' }, listGold([textItem('Encounter/e1', '', '2150-01-01T08:00:00Z')], ['Encounter/e1'], null), [[JSON.stringify({ ...JSON.parse(stay({ start: '2150-01-01T08:00:00Z' })), ...body })]]);
  assert.ok(passed(reasons({})));
  assert.ok(failedText(reasons({ reasonCode: [{ text: 'Chest pain' }] })));
});

test('answer entries: the same copies get the same verdict in the WSO2 and fireboat envelopes', () => {
  const cases: [string, Record<string, string>, GoldRecord, string[][]][] = [
    ['G1', G1_P, DRUG_GOLD, [[admin('Medication/m1')], [med('m1', { code: { text: 'Drug X' } })]]],
    ['G1', G1_P, DRUG_GOLD, [[admin('Medication/m1')], [med('m1', { code: { coding: [{ display: 'Drug X display' }] } })]]],
    ['E2', E2_P, E2_GOLD, [[ICU_ENC], [loc({ name: 'MICU' })]]],
    ['B1', { date: '2150-01-01' }, B1_GOLD, [[spec(null)], [TEST], [ORG]]],
    ['D1', {}, D1_GOLD, [[patient({ birthDate: '1970-01-02', gender: 'female' })]]],
  ];
  for (const [t, p, g, rs] of cases) {
    const w = scoreEntries(t, p, g, rs, 'W'), fb = scoreEntries(t, p, g, rs, 'FB');
    assert.deepEqual([fb.correct, fb.answer_text, fb.failure], [w.correct, w.answer_text, w.failure], t);
  }
});

const cond = (id: string, codes: string[]) => JSON.stringify({ resourceType: 'Condition', id, subject: { reference: `Patient/${P}` },
  code: { coding: codes.map(c => ({ system: 'http://example.org/cs', code: c })) } });
const LS1_P = { resource_type: 'Condition' };
const ls1Gold = (list: string[]) => listGold([textItem('Condition/c1', null), textItem('Condition/c2', null)], ['Condition/c1', 'Condition/c2'], list.map(c => `http://example.org/cs|${c}`));

test('answer entries, set scope (LS1): the union of the copies must equal the answer list; a missing or foreign code fails; B4 is not text-checked', () => {
  const g = ls1Gold(['a', 'b']);
  assert.ok(passed(scoreEntries('LS1-B1', LS1_P, g, [[cond('c1', ['a']), cond('c2', ['b'])]])));
  const missing = scoreEntries('LS1-B1', LS1_P, g, [[cond('c1', ['a']), cond('c2', [])]]);
  assert.ok(failedText(missing));
  assert.deepEqual(missing.answer_text, { checked: 2, ok: 2 }); // each copy is a subset; together they miss b
  assert.ok(failedText(scoreEntries('LS1-B2', LS1_P, g, [[cond('c1', ['a', 'z']), cond('c2', ['b'])]])));
  // known limit: a code stripped from one record but present on another is not detected
  assert.ok(passed(scoreEntries('LS1-B1', LS1_P, g, [[cond('c1', ['a', 'b']), cond('c2', [])]])));
  const b4 = scoreEntries('LS1-B4', LS1_P, g, [[cond('c1', ['a']), cond('c2', [])]]);
  assert.equal(b4.answer_text, undefined);
  assert.ok(!b4.failure.includes('answer_text_missing'));
  assert.equal(b4.scored_on, 'verdict');
});

// ---- answer entries on compact copies (arm H: references and concepts written as plain strings, servers/items.ts) ----

/** fhirHydrant-shaped tool result: {status, data: <Bundle>} in structuredContent. */
const hLine = (resources: string[]) => {
  const env = `{"status":"ok","hasMore":false,"data":${bundle(resources)}}`;
  return `{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":${JSON.stringify(env)}}],"structuredContent":${env},"isError":false}}`;
};
function scoreCompact(template_id: string, parameters: Record<string, string>, g: GoldRecord, resources: string[][]) {
  const ops: AnyOp[] = resources.map((_, i) => ({ op: 'drain', type: `T${i}`, params: [['patient', `Patient/${P}`]], call_cap: 20 }));
  const run = runRec(resources.map((rs, i) => callRec('search', hLine(rs), i, i)), resources.map((_, i) => ({ op_index: i, outcome: 'ok' as const, detail: '' })), 'H');
  return scoreQuestionRun(run, { ...question(ops), template_id, category: 'R', answer_form: 'list', parameters }, g);
}

test('answer entries, compact copies: a Reference given as a string (also absolute) is followed to the referenced copy', () => {
  const compact = (ref: string) => JSON.stringify({ resourceType: 'MedicationAdministration', id: 'ma1', status: 'completed', subject: `Patient/${P}`, effectiveDateTime: MA_TIME, medicationReference: ref });
  const m1 = med('m1', { code: { text: 'Drug X' } });
  assert.ok(passed(scoreCompact('G1', G1_P, DRUG_GOLD, [[compact('Medication/m1')], [m1]])));
  assert.ok(passed(scoreCompact('G1', G1_P, DRUG_GOLD, [[compact('http://127.0.0.1:8080/fhir/Medication/m1')], [m1]])));
  assert.ok(failedText(scoreCompact('G1', G1_P, DRUG_GOLD, [[compact('Medication/m2')], [m1]])));
});

test('answer entries, compact copies: a CodeableConcept given as a string is its name', () => {
  const g = listGold([textItem('Condition/c1', 'Asthma')], ['Condition/c1'], ['Asthma']);
  const c = (code: string) => JSON.stringify({ resourceType: 'Condition', id: 'c1', subject: `Patient/${P}`, code });
  assert.ok(passed(scoreCompact('C3', {}, g, [[c('Asthma')]])));
  assert.ok(failedText(scoreCompact('C3', {}, g, [[c('Hay fever')]])));
});

test('answer entries, compact copies: a Coding given as a string is its text', () => {
  const g = { ...listGold([textItem('Encounter/e1', 'AMB', '2150-01-01T08:00:00Z')], ['Encounter/e1'], ['AMB: 1']), answer: '1' };
  const e = (cls: string) => JSON.stringify({ resourceType: 'Encounter', id: 'e1', subject: `Patient/${P}`, period: { start: '2150-01-01T08:00:00Z' }, class: cls });
  assert.ok(passed(scoreCompact('E1', {}, g, [[e('AMB')]])));
  assert.ok(failedText(scoreCompact('E1', {}, g, [[e('EMER')]])));
});

test('answer entries, item scope (L9): the copy must state the absence; a value or a removed dataAbsentReason fails', () => {
  const T = '2150-01-01T00:00:00Z';
  const g = { ...gold([textItem('Observation/v1', 'Heart rate', T)], ['Observation/v1']), answer_kind: 'none' as const };
  const vital = (body: object) => JSON.stringify({ resourceType: 'Observation', id: 'v1', subject: { reference: `Patient/${P}` }, effectiveDateTime: T, code: { text: 'Heart rate' }, ...body });
  const l9 = (body: object, arm: Arm = 'W') => scoreEntries('L9', { record: 'Observation/v1' }, g, [[vital(body)]], arm);
  assert.ok(passed(l9({ dataAbsentReason: { text: 'not performed' } })));
  assert.ok(passed(l9({ dataAbsentReason: { text: 'not performed' } }, 'FB')));
  assert.ok(failedText(l9({})));
  assert.ok(failedText(l9({ dataAbsentReason: { text: 'not performed' }, valueQuantity: { value: 60, unit: '/min' } })));
});

test('answer entries: a thin copy of a referenced record first and a full one later passes; no full copy fails', () => {
  const full = med('m1', { code: { text: 'Drug X' } }), thin = med('m1', { status: 'active' });
  assert.ok(passed(scoreEntries('G1', G1_P, DRUG_GOLD, [[admin('Medication/m1')], [thin], [full]])));
  assert.ok(passed(scoreEntries('G1', G1_P, DRUG_GOLD, [[admin('Medication/m1')], [thin], [full]], 'FB')));
  assert.ok(failedText(scoreEntries('G1', G1_P, DRUG_GOLD, [[admin('Medication/m1')], [thin], [thin]])));
  const p = { date: '2150-01-01' };
  assert.ok(passed(scoreEntries('B1', p, B1_GOLD, [[spec(null)], [TEST], [ORG], [spec('URINE')]])));
  assert.ok(failedText(scoreEntries('B1', p, B1_GOLD, [[spec(null)], [TEST], [ORG], [spec('BLOOD')]])));
});

test('answer entries: a malformed date on a copy fails the item and does not stop scoring (B1, E3)', () => {
  const badSpec = JSON.stringify({ ...JSON.parse(spec('URINE')), collection: { collectedDateTime: '2150-01-01T10:00:00' } });
  assert.ok(failedText(scoreEntries('B1', { date: '2150-01-01' }, B1_GOLD, [[badSpec], [TEST], [ORG]])));
  const e3 = scoreEntries('E3', { encounter: 'Encounter/e1' }, E3_GOLD, [[stay({ start: '2150-01-01T08:00:00Z', end: 'not a time' })]]);
  assert.ok(failedText(e3));
  assert.ok(!e3.notes.includes('derived item value not checked'));
});

// ---- second round: LS1 cut short, value entries, unvalued items, L9 reason, parent references -----------------------

test('answer entries, set scope (LS1): a run cut short is a coverage failure, not missing text', () => {
  const s = scoreEntries('LS1-B1', LS1_P, ls1Gold(['a', 'b']), [[cond('c1', ['a'])]]);
  assert.equal(s.correct, 0);
  assert.ok(!s.failure.includes('answer_text_missing'));
  assert.deepEqual(s.answer_text, { checked: 1, ok: 1 });
});

const T7 = '2150-01-01T00:00:00Z';
const textObs = (body: object) => JSON.stringify({ resourceType: 'Observation', id: 't1', subject: { reference: `Patient/${P}` }, effectiveDateTime: T7, code: { text: 'Culture' }, ...body });
const valueItem = (ref: string, value: string | null, extra: Partial<GoldItem> = {}): GoldItem => gi(ref, value, { unit: null, unit_code: null, unit_system: null, time: T7, ...extra });
const valueGold = (items: GoldItem[], depends: string[]): GoldRecord => ({ ...gold(items, depends), answer: items[0]?.value ?? null, answer_kind: items[0]?.value === null ? 'none' : 'value' });

test('answer entries, value (L7): the value text is read as gold reads it; a code-only concept passes, an altered text fails although a display still matches', () => {
  const p = { code_system: 'http://example.org/cs', code: 'c', display: 'Culture' };
  const neg = valueGold([valueItem('Observation/t1', 'NEG')], ['Observation/t1']);
  assert.ok(passed(scoreEntries('L7', p, neg, [[textObs({ valueCodeableConcept: { coding: [{ system: 'http://example.org/cs', code: 'NEG' }] } })]])));
  const named = valueGold([valueItem('Observation/t1', 'Negative')], ['Observation/t1']);
  assert.ok(passed(scoreEntries('L7', p, named, [[textObs({ valueCodeableConcept: { text: 'Negative' } })]])));
  assert.ok(failedText(scoreEntries('L7', p, named, [[textObs({ valueCodeableConcept: { text: 'Positive', coding: [{ display: 'Negative' }] } })]])));
  // a compact copy (arm H) that writes the concept as a plain string passes on its content
  assert.ok(passed(scoreCompact('L7', p, named, [[textObs({ subject: `Patient/${P}`, valueCodeableConcept: 'Negative' })]])));
  assert.ok(failedText(scoreCompact('L7', p, named, [[textObs({ subject: `Patient/${P}`, valueCodeableConcept: 'Positive' })]])));
  // the text elsewhere in the record (a note) is not the value
  assert.ok(failedText(scoreEntries('L7', p, named, [[textObs({ note: [{ text: 'Negative' }] })]])));
});

test('answer entries, value: an unvalued L2 item and an F1 claim without total.value must come back without a value', () => {
  const p = { code_system: 'http://example.org/cs', code: 'c', display: 'Culture', window_start: '2150-01-01T00:00:00Z', window_end: '2150-02-01T00:00:00Z' };
  const g = { ...valueGold([valueItem('Observation/t1', null, { value_as_recorded: null })], ['Observation/t1']), answer_form: 'list' as const, answer_list: [`none @ ${T7}`] };
  assert.ok(passed(scoreEntries('L2', p, g, [[textObs({})]])));
  assert.ok(failedText(scoreEntries('L2', p, g, [[textObs({ valueQuantity: { value: 3, unit: 'mg' } })]])));
  const claim = (total: object) => JSON.stringify({ resourceType: 'Claim', id: 'cl1', patient: { reference: `Patient/${P}` }, created: T7, total });
  const f1 = valueGold([valueItem('Claim/cl1', null, { value_as_recorded: null })], ['Claim/cl1']);
  const fp = { encounter: 'Encounter/e1', encounter_start: T7 };
  assert.ok(passed(scoreEntries('F1', fp, f1, [[claim({ currency: 'USD' })]])));
  assert.ok(failedText(scoreEntries('F1', fp, f1, [[claim({ value: 10, currency: 'USD' })]])));
  // a valued claim still passes the value check and the entry
  const f1v = valueGold([valueItem('Claim/cl1', '10.5', { value_as_recorded: '10.50', unit: 'USD' })], ['Claim/cl1']);
  assert.ok(passed(scoreEntries('F1', fp, f1v, [[claim({ value: 10.50, currency: 'USD' })]])));
});

test('answer entries, L9: a copy with an empty dataAbsentReason fails', () => {
  const g = { ...gold([textItem('Observation/v1', 'Heart rate', T7)], ['Observation/v1']), answer_kind: 'none' as const };
  const vital = (body: object) => JSON.stringify({ resourceType: 'Observation', id: 'v1', subject: { reference: `Patient/${P}` }, effectiveDateTime: T7, code: { text: 'Heart rate' }, ...body });
  assert.ok(failedText(scoreEntries('L9', { record: 'Observation/v1' }, g, [[vital({ dataAbsentReason: {} })]])));
  assert.ok(passed(scoreEntries('L9', { record: 'Observation/v1' }, g, [[vital({ dataAbsentReason: { coding: [{ code: 'not-performed' }] } })]])));
});

test('answer entries, parent: E2\'s Encounter and N3\'s report must still reference the item on some returned copy', () => {
  const bareEnc = JSON.stringify({ ...JSON.parse(ICU_ENC), location: undefined });
  assert.ok(failedText(scoreEntries('E2', E2_P, E2_GOLD, [[bareEnc], [loc({ name: 'MICU' })]])));
  assert.ok(passed(scoreEntries('E2', E2_P, E2_GOLD, [[bareEnc], [ICU_ENC], [loc({ name: 'MICU' })]])));
  const report = (result: string[]) => JSON.stringify({ resourceType: 'DiagnosticReport', id: 'dr1', subject: { reference: `Patient/${P}` }, effectiveDateTime: T7, result: result.map(reference => ({ reference })) });
  const res = JSON.stringify({ resourceType: 'Observation', id: 'o1', subject: { reference: `Patient/${P}` }, effectiveDateTime: T7, code: { text: 'Glucose' } });
  const g = { ...listGold([textItem('Observation/o1', 'Glucose', T7)], ['DiagnosticReport/dr1', 'Observation/o1'], ['Glucose']), provenance: ['DiagnosticReport/dr1', 'Observation/o1'] };
  const n3p = { code_system: 'http://example.org/cs', code: 'LAB', display: 'Laboratory' };
  assert.ok(passed(scoreEntries('N3', n3p, g, [[report(['Observation/o1'])], [res]])));
  assert.ok(failedText(scoreEntries('N3', n3p, g, [[report([])], [res]])));
  // the report not returned at all is a coverage failure, not missing text
  const noReport = scoreEntries('N3', n3p, g, [[], [res]]);
  assert.equal(noReport.correct, 0);
  assert.ok(!noReport.failure.includes('answer_text_missing'));
});

test('report: the printed known limits include every answer-entry limit in bench/README.md', async () => {
  const { readFileSync } = await import('node:fs');
  const { BENCH } = await import('../lib/paths.js');
  const { ANSWER_ENTRY_LIMITS, DEVIATIONS } = await import('../run/report.js');
  const md = readFileSync(join(BENCH, 'README.md'), 'utf8');
  const block = md.slice(md.indexOf('- **What the answer-entry check cannot see.**'));
  const bullets = block.split('\n').slice(1).filter(l => l.startsWith('  - ')).map(l => l.slice(4).replaceAll('`', ''));
  const end = block.split('\n').slice(1).findIndex(l => !l.startsWith('  - '));
  assert.deepEqual(bullets.slice(0, end), ANSWER_ENTRY_LIMITS);
  for (const l of ANSWER_ENTRY_LIMITS) assert.ok(DEVIATIONS.includes(`Answer entries: ${l}`));
});
