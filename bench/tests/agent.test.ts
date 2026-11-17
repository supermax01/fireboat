// Agent track: invocation, prompt, schema, stream parsing, grading, cap and budget guard, and one host run against
// the loopback mock Messages API (no model, no cost). All records here are synthetic.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { acquireBatchLock, checkRunCap, estimateBatch, SMOKE_RUN_CAP, WORST_CASE_PER_RUN_USD } from '../agent/budget.js';
import { runCost } from '../agent/cost.js';
import { canonicalDecimal, gradeAnswer, instantEqual, precisionRecall, refsSeen, scoreRun, valueInOutputs } from '../agent/grade.js';
import { buildInvocation, HOST, isRequestedModel, PINNED_ENV } from '../agent/host.js';
import { startMockApi } from '../agent/mock-api.js';
import { ANSWER_SCHEMA_PATH, loadPromptFiles, renderPrompt } from '../agent/prompt.js';
import { mcpExchanges, parseStream, validateAnswer } from '../agent/stream.js';
import { sha256Hex } from '../lib/hash.js';
import { parseNumbersAsStrings } from '../lib/json.js';
import { tmpDir } from '../lib/paths.js';
import type { AgentAnswer, AgentRunRecord, GoldRecord } from '../lib/types.js';

const ANSWER: AgentAnswer = {
  answer_kind: 'value', answer: '12.340', answer_list: null, value_as_recorded: '12.3400', unit: 'mg/dL',
  timestamp: '2150-03-01T06:00:00-05:00', resource_ids: ['Observation/obs-1'], completeness: 'all_retrieved', abstained: false, explanation: 'x',
};
const GOLD: GoldRecord = {
  schema: 'fbbench.gold/1', question_id: 'mimic.L1.000000000000', dataset: 'mimic', patient_id: 'pat-1', implementation: 'reconciled',
  answer_form: 'value', answer_kind: 'value', answer: '12.34', answer_list: null, value_as_recorded: '12.3400', unit: 'mg/dL',
  timestamp: '2150-03-01T06:00:00-05:00', items: [], provenance: ['Observation/obs-1'], depends_on: ['Observation/obs-1', 'Observation/obs-2'],
  completeness: { size: 2, pages_at_100: 1 }, lexeme_eligible: true, rule_notes: [],
};

test('host invocation: exact flags, pinned environment, prompt and schema hashed in the record', () => {
  const inv = buildInvocation({
    workDir: '/w', homeDir: '/h', configDir: '/c', prompt: 'P', promptSha256: 'a'.repeat(64), schemaText: '{}', schemaSha256: 'b'.repeat(64),
    mcpConfigPath: '/m.json', apiKey: 'k',
  });
  assert.equal(inv.command, HOST.path);
  assert.deepEqual(inv.args, ['-p', 'P', '--bare', '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '/m.json',
    '--tools', '', '--allowedTools', 'mcp__ehr__*', '--permission-mode', 'dontAsk', '--model', 'claude-opus-5-5', '--effort', 'high',
    '--max-turns', '30', '--max-budget-usd', '2', '--output-format', 'stream-json', '--verbose', '--json-schema', '{}',
    '--no-session-persistence', '--exclude-dynamic-system-prompt-sections']);
  assert.deepEqual(inv.env, { PATH: '/usr/bin:/bin', HOME: '/h', ANTHROPIC_API_KEY: 'k', CLAUDE_CONFIG_DIR: '/c', ...PINNED_ENV });
  assert.deepEqual(PINNED_ENV, { DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', MAX_MCP_OUTPUT_TOKENS: '25000',
    DISABLE_AUTO_COMPACT: '1', ENABLE_TOOL_SEARCH: 'false', MCP_TIMEOUT: '120000', MCP_TOOL_TIMEOUT: '120000' });
  assert.ok(!inv.recordedArgv.includes('P') && inv.recordedArgv.includes(`sha256:${'a'.repeat(64)}`));
  assert.ok(!JSON.stringify(inv.envNames).includes('"k"'));
  assert.throws(() => buildInvocation({ workDir: '/w', homeDir: '/h', configDir: '/c', prompt: 'P', promptSha256: '', schemaText: '', schemaSha256: '', mcpConfigPath: '', apiKey: '', mockBaseUrl: 'https://api.example' }));
});

test('prompt renders the template text, with optional lines', async () => {
  const { template } = await loadPromptFiles();
  const plain = renderPrompt(template, { patient_id: 'p1', question: 'Q?', mimic_subject_id: null, reference_time: null });
  assert.equal(plain, [
    'You are answering a question about one patient\'s health record. Use only the tools provided.',
    'The patient\'s FHIR resource id is Patient/p1.',
    'Answer only from what the records show. If you cannot determine the answer, set abstained to true.',
    'If the records show that the thing asked about is absent, answer "none".',
    'Say whether you retrieved every record the answer depends on.', '', 'Question: Q?'].join('\n'));
  const full = renderPrompt(template, { patient_id: 'p1', question: 'Q?', mimic_subject_id: '100', reference_time: '2150-01-01T00:00:00-05:00' });
  assert.match(full, /Patient\/p1\. This patient's MIMIC subject_id is 100\.\nAssume the current time is 2150-01-01T00:00:00-05:00\.\nAnswer only/);
});

test('hand-written validator agrees with answer.schema.json', () => {
  const schema = parseNumbersAsStrings(readFileSync(ANSWER_SCHEMA_PATH, 'utf8')) as { required: string[]; properties: Record<string, unknown>; additionalProperties: boolean };
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(Object.keys(schema.properties).sort(), [...schema.required].sort());
  assert.deepEqual(validateAnswer(ANSWER), []);
  assert.deepEqual(Object.keys(ANSWER).sort(), [...schema.required].sort());
  assert.ok(validateAnswer({ ...ANSWER, answer: 14 }).length > 0);
  assert.ok(validateAnswer({ ...ANSWER, extra: 1 }).length > 0);
  assert.ok(validateAnswer({ ...ANSWER, resource_ids: ['obs-1'] }).length > 0);
  assert.ok(validateAnswer({ ...ANSWER, completeness: 'yes' }).length > 0);
});

const line = (o: unknown, at = 0) => ({ text: JSON.stringify(o), at_ms: at });

test('stream parser: init, models, tool exchanges, flags, usage, structured output lexemes', () => {
  const lines = [
    line({ type: 'system', subtype: 'init', tools: ['mcp__ehr__search', 'StructuredOutput'], mcp_servers: [{ name: 'ehr', status: 'connected' }], model: 'claude-opus-5-5', claude_code_version: '2.1.322' }, 1000),
    line({ type: 'assistant', message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 't1', name: 'mcp__ehr__search', input: { type: 'Observation' } }] } }),
    { text: '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":[{"type":"text","text":"{\\"valueQuantity\\":{\\"value\\":12.3400}} [OUTPUT TRUNCATED - exceeded 25000 token limit]"}]}]}}', at_ms: 0 },
    line({ type: 'assistant', message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: {} }] } }),
    line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: '<tool_use_error>No such tool available: Bash</tool_use_error>' }] } }),
    line({ type: 'assistant', message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 't3', name: 'StructuredOutput', input: ANSWER }] } }),
    { text: `{"type":"result","subtype":"success","is_error":false,"num_turns":4,"total_cost_usd":0.1230,"usage":{"input_tokens":10,"output_tokens":5,"cache_creation_input_tokens":2,"cache_read_input_tokens":3},"structured_output":${JSON.stringify(ANSWER)}}`, at_ms: 4000 },
  ];
  const p = parseStream(lines, { requestedModel: 'claude-opus-5-5', expectServer: true });
  assert.equal(p.init?.tools.length, 2);
  assert.equal(p.flags.server_connect_failed, false);
  assert.equal(p.flags.f4_host, true);
  assert.equal(p.flags.wrong_model, false);
  assert.equal(p.total_cost_usd, '0.1230');
  assert.equal(p.num_turns, 4);
  assert.deepEqual(p.usage, { input: 10, output: 5, cache_write: 2, cache_read: 3 });
  assert.equal(p.result_at_ms! - p.init_at_ms!, 3000);
  assert.deepEqual(p.structured_output, ANSWER);
  assert.equal(p.tools.filter(t => t.invalid).map(t => t.name).join(), 'Bash');
  const ex = mcpExchanges(p);
  assert.equal(ex.length, 1);
  assert.match(ex[0]!.result_text!, /"value\\?":12\.3400/);

  const bad = parseStream([
    line({ type: 'system', subtype: 'init', tools: [], mcp_servers: [{ name: 'ehr', status: 'failed' }], model: 'claude-opus-5-5' }),
    line({ type: 'assistant', message: { model: 'claude-other-1', content: [] } }),
    line({ type: 'system', subtype: 'compact_boundary' }),
    line({ type: 'result', subtype: 'error_max_turns', structured_output: { answer: 1 } }),
  ], { requestedModel: 'claude-opus-5-5', expectServer: true });
  assert.equal(bad.flags.server_connect_failed, true);
  assert.equal(bad.flags.wrong_model, true);
  assert.equal(bad.flags.host_altered_context, true);
  assert.equal(bad.structured_output, null);
  assert.ok(bad.structured_output_errors.length > 0);
  assert.ok(isRequestedModel('claude-opus-5-5-20261001') && !isRequestedModel('claude-opus-5-5x'));
});

test('grading: decimals, instants, units, none, abstention, lists', () => {
  assert.equal(canonicalDecimal('12.3400'), canonicalDecimal('12.34'));
  assert.equal(canonicalDecimal('1.5e1'), canonicalDecimal('15.0'));
  assert.notEqual(canonicalDecimal('0.10000000000000000001'), canonicalDecimal('0.1'));
  assert.equal(canonicalDecimal('abc'), null);
  assert.ok(instantEqual('2150-03-01T11:00:00Z', '2150-03-01T06:00:00-05:00'));
  assert.ok(!instantEqual('2150-03-01T11:00:01Z', '2150-03-01T06:00:00-05:00'));
  assert.ok(instantEqual('2150-03-01T06:00:00', '2150-03-01T06:00:00-05:00'));
  assert.ok(instantEqual('2150-03-01T23:00:00Z', '2150-03-01'));
  assert.ok(!instantEqual('2150-03', '2150-03-01'));
  assert.equal(gradeAnswer(ANSWER, GOLD).correct, true);
  const unit = gradeAnswer({ ...ANSWER, unit: 'mmol/L' }, GOLD);
  assert.ok(!unit.correct && unit.value_right && unit.unit_or_time_wrong);
  assert.equal(gradeAnswer({ ...ANSWER, timestamp: null }, GOLD).correct, true);
  assert.equal(gradeAnswer({ ...ANSWER, abstained: true }, GOLD).correct, false);
  assert.equal(gradeAnswer(null, GOLD).correct, false);
  const none: GoldRecord = { ...GOLD, answer_kind: 'none', answer: null };
  assert.equal(gradeAnswer({ ...ANSWER, answer_kind: 'none', answer: null }, none).correct, true);
  assert.equal(gradeAnswer({ ...ANSWER, answer_kind: 'none', answer: null, abstained: true }, none).correct, false);
  const list: GoldRecord = { ...GOLD, answer_form: 'list', answer_kind: 'list', answer: null, answer_list: ['Aspirin 81 MG', 'Heparin'] };
  assert.equal(gradeAnswer({ ...ANSWER, answer_kind: 'list', answer_list: ['heparin', ' aspirin  81 mg'] }, list).correct, true);
  assert.equal(gradeAnswer({ ...ANSWER, answer_kind: 'list', answer_list: ['heparin'] }, list).correct, false);
  const count: GoldRecord = { ...GOLD, answer_form: 'count', answer: '3' };
  assert.equal(gradeAnswer({ ...ANSWER, answer: '3', unit: null }, count).correct, true);
  assert.equal(gradeAnswer({ ...ANSWER, answer: '3.0' }, count).correct, false);
});

test('grading traps: yes/no none, composite lists, derived units, recorded text "NONE."', () => {
  const yesNo: GoldRecord = { ...GOLD, answer_form: 'yes_no', answer_kind: 'value', answer: 'no', value_as_recorded: null, unit: null, timestamp: null };
  assert.equal(gradeAnswer({ ...ANSWER, answer_kind: 'none', answer: null, unit: null }, yesNo).correct, true);
  assert.equal(gradeAnswer({ ...ANSWER, answer_kind: 'none', answer: null, unit: null }, { ...yesNo, answer: 'yes' }).correct, false);
  const window: GoldRecord = { ...GOLD, answer_form: 'list', answer_kind: 'list', answer: null, answer_list: ['14 mg/dL @ 2150-03-01T06:00:00-05:00', '9.5 mg/dL @ 2150-03-02T06:00:00-05:00'] };
  assert.equal(gradeAnswer({ ...ANSWER, answer_kind: 'list', answer_list: ['14.0 mg/dL at 2150-03-01T11:00:00Z', '9.50 mg/dL (2150-03-02T06:00:00-05:00)'] }, window).correct, true);
  assert.equal(gradeAnswer({ ...ANSWER, answer_kind: 'list', answer_list: ['14.0 mg/dL at 2150-03-01T11:00:00Z', '9.6 mg/dL (2150-03-02T06:00:00-05:00)'] }, window).correct, false);
  const pairs: GoldRecord = { ...window, answer_list: ['CT | Chest', 'birth_date: 2050-01-02', 'Escherichia coli (Urine)'] };
  assert.equal(gradeAnswer({ ...ANSWER, answer_kind: 'list', answer_list: ['chest CT', 'born 2050-01-02', 'E. coli'] }, pairs).correct, false);
  assert.equal(gradeAnswer({ ...ANSWER, answer_kind: 'list', answer_list: ['CT, chest', '2050-01-02', 'Escherichia coli from urine'] }, pairs).correct, true);
  const derived: GoldRecord = { ...GOLD, answer: '36', value_as_recorded: null, unit: 'h', timestamp: null };
  assert.equal(gradeAnswer({ ...ANSWER, answer: '36', unit: 'hours', timestamp: null }, derived).correct, true);
  assert.equal(gradeAnswer({ ...ANSWER, answer: '36', unit: null, timestamp: null }, derived).correct, true);
  assert.equal(gradeAnswer({ ...ANSWER, answer: '36', unit: 'days', timestamp: null }, derived).correct, false);
  assert.equal(gradeAnswer({ ...ANSWER, answer: '12.340', unit: 'mg' }, GOLD).correct, false); // recorded values keep the exact unit check
  const text: GoldRecord = { ...GOLD, answer: 'NONE.', value_as_recorded: 'NONE.', unit: null, timestamp: null };
  assert.equal(gradeAnswer({ ...ANSWER, answer_kind: 'none', answer: null, unit: null }, text).correct, true);
  assert.equal(gradeAnswer({ ...ANSWER, answer_kind: 'value', answer: 'None', unit: null }, text).correct, true);
  assert.equal(gradeAnswer({ ...ANSWER, answer_kind: 'value', answer: 'Positive', unit: null }, text).correct, false);
  const bp: GoldRecord = { ...GOLD, answer: '120/80', value_as_recorded: null, unit: 'mm[Hg]', timestamp: null };
  assert.equal(gradeAnswer({ ...ANSWER, answer: '120/80', unit: 'mm[Hg]', timestamp: null }, bp).correct, true);
});

test('evidence helpers and failure codes', () => {
  assert.deepEqual([...refsSeen(['Observation/obs-1', 'Observation/obs-2'], ['id obs-1, obs-22'])], ['Observation/obs-1']);
  assert.deepEqual(precisionRecall([], []), { precision: 1, recall: 1 });
  assert.deepEqual(precisionRecall(['A/1', 'A/2'], ['A/1']), { precision: 0.5, recall: 1 });
  assert.ok(valueInOutputs('12.340', ['"value":12.3400']));
  assert.ok(!valueInOutputs('12.35', ['"value":12.3400']));

  const run = {
    run_id: 'W__agent__r1__mimic.L1.000000000000', arm: 'W', question_id: GOLD.question_id, patient_id: 'pat-1', terminal_status: 'success',
    structured_output: { ...ANSWER, answer: '99', completeness: 'all_retrieved' },
    flags: { f4_host: false, host_altered_context: false, wrong_model: false, server_connect_failed: false },
  } as unknown as AgentRunRecord;
  const s = scoreRun({ run, gold: GOLD, exchanges: [{ id: 't', name: 'mcp__ehr__x', arguments: {}, result_text: 'obs-1 value 12.3400', result_bytes: 1, is_error: false, invalid: false }], citedPatients: new Map([['Observation/obs-1', 'pat-2']]) });
  assert.equal(s.correct, 0);
  assert.equal(s.all_retrieved_from_log, false);
  for (const f of ['F5', 'F6', 'F11']) assert.ok(s.failure.includes(f), f);
  assert.equal(s.lexeme_match, true);
});

test('run cap and budget guard refuse before launch', () => {
  assert.equal(SMOKE_RUN_CAP, 6);
  assert.ok(checkRunCap(0, 6).ok);
  assert.ok(!checkRunCap(1, 6).ok);
  assert.ok(!checkRunCap(6, 1).ok);
  assert.equal(estimateBatch(6, 15).ok, true); // 6 x 2.2 = 13.2
  assert.equal(estimateBatch(6, 13).ok, false);
  assert.equal(estimateBatch(6, 13).estimated_usd, Math.round(6 * WORST_CASE_PER_RUN_USD * 100) / 100);
  assert.equal(estimateBatch(6, 3, 0.5).ok, true);
  const c = runCost({ model_requested: 'claude-opus-5-5', total_cost_usd: '0.5', usage: { input: 1e6, output: 1e6, cache_read: 1e6, cache_write: 1e6 } });
  assert.deepEqual(c, { cli_usd: 0.5, recomputed_usd: 29.2, uncached_equivalent_usd: 32 });
});

test('host against the loopback mock API: only StructuredOutput listed with an empty MCP config, answer survives', { skip: !existsSync(HOST.path) }, async () => {
  const root = tmpDir('agent-test');
  await mkdir(root, { recursive: true });
  const base = await mkdtemp(join(root, 'run-'));
  const work = join(base, 'work'), cfg = join(base, 'cfg'), home = join(base, 'home');
  await mkdir(work); await mkdir(cfg); await mkdir(home);
  const api = await startMockApi({ calls: [], answer: ANSWER as unknown as Record<string, unknown> });
  try {
    const { template, schemaText, schemaSha256 } = await loadPromptFiles();
    const prompt = renderPrompt(template, { patient_id: 'p1', question: 'Q?', mimic_subject_id: null, reference_time: null });
    const mcp = join(base, 'mcp.json');
    await writeFile(mcp, '{"mcpServers":{}}');
    const inv = buildInvocation({ workDir: work, homeDir: home, configDir: cfg, prompt, promptSha256: sha256Hex(prompt), schemaText, schemaSha256, mcpConfigPath: mcp, apiKey: 'mock-not-a-key', mockBaseUrl: api.baseUrl });
    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn(inv.command, inv.args, { cwd: inv.cwd, env: inv.env, stdio: ['ignore', 'pipe', 'ignore'] });
      let s = '';
      child.stdout.on('data', d => (s += d));
      const t = setTimeout(() => child.kill('SIGKILL'), 60000);
      child.once('error', reject);
      child.once('close', () => { clearTimeout(t); resolve(s); });
    });
    const p = parseStream(out.split('\n').map(text => ({ text, at_ms: 0 })), { requestedModel: 'claude-opus-5-5', expectServer: false });
    assert.equal(p.init?.claude_code_version, HOST.version);
    assert.deepEqual(p.init?.tools, ['StructuredOutput']);
    assert.equal(p.terminal_status, 'success');
    assert.deepEqual(p.structured_output, ANSWER);
    assert.deepEqual(api.requests.map(r => r.tool_names), [['StructuredOutput']]);
  } finally {
    await api.close();
    await rm(base, { recursive: true, force: true });
  }
});

test('smoke batch lock: exclusive while held, stale lock of a dead process taken over', async () => {
  const dir = tmpDir('test-smoke-lock');
  await rm(dir, { recursive: true, force: true });
  try {
    const release = acquireBatchLock(dir);
    assert.throws(() => acquireBatchLock(dir), /another smoke batch holds/);
    release();
    await writeFile(join(dir, '.lock'), '999999\n'); // no such process
    const again = acquireBatchLock(dir);
    assert.equal((await readFile(join(dir, '.lock'), 'utf8')).trim(), String(process.pid));
    again();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
