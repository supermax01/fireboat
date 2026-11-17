// Strata scoring and reporting: LS2 on the answer with the verdict beside it, B4 on
// the verdict, strata rows never pooled with the main set. Fixtures are synthetic, WSO2-shaped tool results.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { CallRecord, GoldItem, GoldRecord, QuestionRecord, RunRecord, ScoreRecord } from '../lib/types.js';
import { scoreQuestionRun, strataScoring, stratumOf } from '../run/score-lib.js';
import { summarise } from '../run/summary.js';
import { strataSection } from '../run/report.js';

const P = 'pat-1';
const obs = (id: string, value: string) =>
  `{"resourceType":"Observation","id":"${id}","subject":{"reference":"Patient/${P}"},"effectiveDateTime":"2150-01-01T00:00:00-05:00","code":{"text":"X"},"valueQuantity":{"unit":"u","value":${value}}}`;
const bundle = (entries: string[], next?: string, total?: number) =>
  `{"resourceType":"Bundle","type":"searchset"${total !== undefined ? `,"total":${total}` : ''},"link":[${next ? `{"relation":"next","url":"${next}"}` : ''}],"entry":[${entries.map(e => `{"resource":${e}}`).join(',')}]}`;
const wLine = (body: string) => `{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":${JSON.stringify(`{"result":${body}}`)}}],"structuredContent":{"result":${body}},"isError":false}}`;
const callRec = (raw: string): CallRecord => ({ seq: 0, op_index: 0, op: 'search', tool: 'search', arguments: {}, started_at: '', latency_ms: 1, response_raw: raw, is_error: false,
  bytes: { content_text: 1, structured_content: 1, result: 2, line: 3 }, error: null });
const gi = (ref: string, value: string): GoldItem => ({ ref, value, value_as_recorded: value, unit: 'u', unit_code: null, unit_system: null, time: '2150-01-01T00:00:00-05:00', display: null });
const drain = { op: 'drain' as const, type: 'Observation', params: [['patient', `Patient/${P}`]] as [string, string][], call_cap: 20 };
const question = (template_id: string): QuestionRecord => ({
  schema: 'fbbench.question/1', id: `synthea-dev.${template_id}.abc`, dataset: 'synthea-dev', patient_id: P, template_id, group: 'g', category: 'C',
  encounter_scoped: false, phrasing: 'concept', question: 'q', reference_time: null, mimic_subject_id: null, parameters: {}, operations: [drain],
  answer_form: template_id.startsWith('LS2') ? 'value' : 'list', seed: { kind: 'dev', hex: '0'.repeat(64), purpose: 'saq' }, rank_hash: 'a'.repeat(64), candidate_key: 'k',
});
const DEPENDS = ['Observation/o1', 'Observation/o2', 'Observation/o3'];
const gold = (q: QuestionRecord, items: GoldItem[]): GoldRecord => ({
  schema: 'fbbench.gold/1', question_id: q.id, dataset: 'synthea-dev', patient_id: P, implementation: 'reconciled', answer_form: q.answer_form,
  answer_kind: 'value', answer: null, answer_list: null, value_as_recorded: null, unit: null, timestamp: null, items, provenance: items.map(i => i.ref),
  depends_on: DEPENDS, completeness: { size: 3, pages_at_100: 1 }, lexeme_eligible: false, rule_notes: [],
});
const run = (raw: string, outcome: RunRecord['op_outcomes'][number]['outcome'] = 'ok', arm: RunRecord['arm'] = 'W'): RunRecord => ({
  schema: 'fbbench.run/1', campaign: 't', run_id: `${arm}__default__p1__x`, pass: 1, arm, cell: 'default', dataset: 'synthea-dev', question_id: 'x', patient_id: P,
  slot: 0, started_at: '', wall_ms: 1,
  server: { command: { command: '', args: [], env: {}, cwd: '', files: {} }, pid: 1, cold_start_ms: 1, protocol_version: null, server_info: null,
    instructions_bytes: 0, tools_list_bytes: 0, exit: { code: 0, signal: null }, stderr_path: '', egress_sandbox: 'none' },
  calls: [callRec(raw)], op_outcomes: [{ op_index: 0, outcome, detail: '' }], flags: [],
  upstream: { proxy_log: '', requests: 1, blocked_writes: 0, first_seq: 0, last_seq: 0 }, versions: { bench_commit: '', bench_dirty: false, arm_pin: '' },
});
const firstPage = (next?: string, total?: number) => wLine(bundle([obs('o1', '3'), obs('o2', '9.0')], next, total));
const whole = wLine(bundle([obs('o1', '3'), obs('o2', '9.0'), obs('o3', '5')]));

test('stratum membership and scoring mode follow the template id', () => {
  assert.deepEqual(['LS1-B1', 'LS2-B3', 'LS1-B4', 'DEC-F3', 'L1', 'L3'].map(stratumOf), ['B1', 'B3', 'B4', 'decimal', null, null]);
  assert.deepEqual(['LS1-B3', 'LS2-B2', 'LS2-B4', 'LS1-B4', 'DEC-L6', 'L5'].map(strataScoring), [null, 'answer', 'verdict', 'verdict', null, null]);
});

test('LS2 in B1-B3: correct on the answer; the depends_on verdict is reported beside it, not folded in', () => {
  const q = question('LS2-B3');
  const g = gold(q, [gi('Observation/o2', '9.0')]); // the maximum is on the first page
  const s = scoreQuestionRun(run(firstPage('http://h/fhir?_getpages=x'), 'cannot_continue'), q, g);
  assert.deepEqual([s.correct, s.verdict, s.scored_on], [1, 'signalled_partial', 'answer']);
  // The same run under the ordinary list rule (LS1) is incorrect: depends_on is not covered.
  const q1 = question('LS1-B3');
  assert.deepEqual([scoreQuestionRun(run(firstPage('http://h/fhir?_getpages=x'), 'cannot_continue'), q1, gold(q1, [gi('Observation/o2', '9.0')])).correct], [0]);
  // When the maximum is on page 2, the first page alone is incorrect and the whole set is correct.
  const g3 = gold(q, [gi('Observation/o3', '5')]);
  assert.equal(scoreQuestionRun(run(firstPage()), q, g3).correct, 0);
  assert.equal(scoreQuestionRun(run(whole), q, g3).correct, 1);
});

test('B4: scored on the verdict; signalled partial passes, complete only with the whole set, ST, FC and no result fail', () => {
  for (const id of ['LS1-B4', 'LS2-B4']) {
    const q = question(id);
    const g = gold(q, id === 'LS1-B4' ? DEPENDS.map(r => gi(r, '1')) : [gi('Observation/o3', '5')]);
    const score = (r: RunRecord) => { const s = scoreQuestionRun(r, q, g); assert.equal(s.scored_on, 'verdict'); return [s.verdict, s.correct]; };
    assert.deepEqual(score(run(firstPage('http://h/fhir?_getpages=x'), 'cannot_continue')), ['signalled_partial', 1]);
    assert.deepEqual(score(run(firstPage())), ['silent_truncation', 0]);
    assert.deepEqual(score(run(firstPage(undefined, 2))), ['false_completeness', 0]);
    assert.deepEqual(score(run(whole)), ['complete', 1]);
    assert.deepEqual(score(run(wLine('{"resourceType":"OperationOutcome"}'), 'tool_error')), [null, 0]);
  }
});

test('main-set questions are scored exactly as before (no scored_on field)', () => {
  const q = { ...question('L5'), answer_form: 'list' as const };
  const s = scoreQuestionRun(run(firstPage('http://h/fhir?_getpages=x'), 'cannot_continue'), q, gold(q, [gi('Observation/o2', '9.0')]));
  assert.equal(s.correct, 0);
  assert.equal('scored_on' in s, false);
});

test('summary and report: strata rows stay apart from the main set and render per band with the base rate', () => {
  const mk = (template_id: string, arm: RunRecord['arm'], correct: 0 | 1, verdict: ScoreRecord['verdict'], scored_on?: 'answer' | 'verdict'): ScoreRecord => ({
    schema: 'fbbench.score/1', campaign: 't', run_id: `${arm}${template_id}`, arm, cell: 'default', pass: 1, dataset: 'synthea-dev', question_id: template_id, template_id,
    category: 'C', correct, items: { gold: 1, returned: 1, matched: 1, value_ok: 1, unit_ok: 1, time_ok: 1, identity_ok: 1, unit_code_kept: 0, unit_code_eligible: 0 },
    other_patient_refs: [], verdict, first_page_coverage: 1, recall: verdict ? 1 : null, precision: verdict ? 1 : null, lexeme: { eligible: 1, exact: correct },
    calls: 1, bytes: { content_text: 1, structured_content: 1, result: 1, line: 1 }, latency_ms: 1, signals: [], failure: [], notes: [], ...(scored_on ? { scored_on } : {}),
  });
  const main = [mk('L3', 'W', 1, 'complete')];
  const plain = summarise(main, [], new Map());
  assert.equal('by_stratum' in plain, false); // old campaigns keep their summary shape
  const sm = summarise([...main, mk('LS1-B3', 'W', 0, 'signalled_partial'), mk('LS2-B3', 'W', 1, 'signalled_partial', 'answer'), mk('LS1-B4', 'FB', 1, 'signalled_partial', 'verdict'), mk('DEC-F3', 'W', 1, null)], [], new Map());
  assert.deepEqual(sm.by_category.map(r => [r.group, r.n]), [['C', 1]]); // never pooled
  assert.deepEqual(sm.by_template.map(r => r.group), ['L3']);
  assert.deepEqual(sm.by_stratum!.map(r => [r.group, r.stratum, r.scored_on]), [['DEC-F3', 'decimal', 'standard'], ['LS1-B3', 'B3', 'standard'], ['LS1-B4', 'B4', 'verdict'], ['LS2-B3', 'B3', 'answer']]);
  const md = strataSection(sm.by_stratum!, { numbers: 1000, float_changing: 54 }).join('\n');
  assert.match(md, /\| B3 201-1000 \(main\) \| LS1 \| items and depends_on \| W \| 1 \| 0\/1 \(0%\) \| 0\/1\/0\/0\/0 \|/);
  assert.match(md, /\| B3 201-1000 \(main\) \| LS2 \| answer \(verdict beside it\) \| W \| 1 \| 1\/1 \(100%\) \| 0\/1\/0\/0\/0 \|/);
  assert.match(md, /\| B4 4001-10000 \(partial expected\) \| LS1 \| verdict \| FB \|/);
  assert.match(md, /Base rate: 54 of 1000 JSON numbers \(5\.4%\)/);
  assert.ok(md.indexOf('| B3') < md.indexOf('| B4'));
  assert.deepEqual(strataSection([], null), []);
});

test('bench:scripted --strata reads stratum questions; recorded stratum digests are checked like the main inputs', async () => {
  const { mkdir, rm, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpDir } = await import('../lib/paths.js');
  const { loadUnits } = await import('../run/scripted.js');
  const { inputMismatches, strataInputs } = await import('../run/inputs.js');
  const dir = join(tmpDir('strata-score-test'), 'draft');
  await rm(dir, { recursive: true, force: true });
  await mkdir(join(dir, 'synthea-dev'), { recursive: true });
  const q = question('LS1-B3');
  await writeFile(join(dir, 'synthea-dev', 'questions.jsonl'), JSON.stringify({ ...q, operations: [{ ...drain, call_cap: '20' }] }) + '\n');
  await writeFile(join(dir, 'synthea-dev', 'gold.jsonl'), JSON.stringify(gold(q, [])) + '\n');
  const units = await loadUnits('synthea-dev', 'questions', dir);
  assert.deepEqual(units.map(u => [u.id, u.patient_id, (u.operations[0] as { call_cap: unknown }).call_cap]), [[q.id, P, 20]]);
  const rec = await strataInputs(dir, 'synthea-dev');
  assert.match(rec.questions ?? '', /^[0-9a-f]{64}$/);
  assert.deepEqual(await inputMismatches({ datasets: {}, manifests: [], missing: [], strata: { 'synthea-dev': rec } }), []);
  await writeFile(join(dir, 'synthea-dev', 'gold.jsonl'), '\n');
  assert.deepEqual((await inputMismatches({ datasets: {}, manifests: [], missing: [], strata: { 'synthea-dev': rec } })).map(m => m.split(':')[0]), ['synthea-dev.strata.gold']);
  await rm(tmpDir('strata-score-test'), { recursive: true, force: true });
});
