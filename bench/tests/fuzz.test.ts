// Fuzz corpus, schema-driven mutations, case execution through real adapters with a fake server, and classification.
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLossless, LosslessNumber } from '../lib/json.js';
import type { ToolCall } from '../lib/types.js';
import { makeAdapter } from '../servers/adapters.js';
import type { CallOutcome } from '../servers/arms.js';
import { parserFor } from '../servers/parsers.js';
import { CATEGORIES, fill, loadCorpus, type FuzzCase } from '../fuzz/corpus.js';
import { executeCase, mutateCall, transformHandle, type Caller } from '../fuzz/execute.js';
import { matchNumbers, numberBundle, numberObservation } from '../fuzz/mock.js';
import { classify, summarise, type FuzzRunRecord } from '../fuzz/score.js';

const corpus = loadCorpus();
const VARS = { patient: 'pat-1', other_patient: 'pat-2', canary_port: 18227, proxy: 'http://127.0.0.1:18217/fhir', case: 'F000' };

test('corpus: 100 cases, every category, malformed-input cases flagged, the adversarial numbers present', () => {
  assert.equal(corpus.cases.length, 100);
  for (const c of CATEGORIES) assert.ok(corpus.cases.some(k => k.category === c), c);
  const mal = corpus.cases.filter(k => k.kind === 'mutate' && k.malformed_mcp);
  assert.ok(mal.length >= 15 && mal.every(k => k.category === 'malformed_input' && k.expect === 'error'));
  const lexemes = corpus.cases.flatMap(k => (k.kind === 'number' ? [k.lexeme] : []));
  for (const l of ['1e-3', '9007199254740993', '-0.0', '0.10000000000000000001']) assert.ok(lexemes.includes(l), l);
  assert.ok(corpus.cases.some(k => k.kind === 'op' && 'page_size' in k && (k.page_size ?? 0) < 0));
  assert.match(corpus.label, /not natural prevalence/);
});

test('templates: repeat, canary URL, patient ids', () => {
  const k = fill({ a: '{{repeat:A:10240}}', b: '{{canary}}', c: ['patient', 'Patient/{{patient}},Patient/{{other_patient}}'] }, { ...VARS, case: 'F083' });
  assert.equal(k.a.length, 10240);
  assert.equal(k.b, 'http://127.0.0.1:18227/fbfuzz-canary/F083');
  assert.deepEqual(k.c, ['patient', 'Patient/pat-1,Patient/pat-2']);
});

test('mutations follow the tool schema', () => {
  const schema = { type: 'object', required: ['resource_type', 'id'], properties: { resource_type: { type: 'string' }, id: { type: 'string' } } };
  const tc: ToolCall = { tool: 'read', arguments: { resource_type: 'Patient', id: 'x', extra: { k: 'v' } } };
  assert.deepEqual(mutateCall(tc, schema, 'drop_all_required', 'c'), { tool: 'read', arguments: { extra: { k: 'v' } } });
  assert.deepEqual(mutateCall(tc, schema, 'drop_first_required', 'c'), { tool: 'read', arguments: { id: 'x', extra: { k: 'v' } } });
  assert.deepEqual(mutateCall(tc, schema, 'required_string_to_number', 'c'), { tool: 'read', arguments: { resource_type: 12345, id: 'x', extra: { k: 'v' } } });
  assert.deepEqual(mutateCall(tc, schema, 'required_string_to_array', 'c'), { tool: 'read', arguments: { resource_type: ['Patient'], id: 'x', extra: { k: 'v' } } });
  assert.deepEqual(mutateCall(tc, schema, 'container_to_string', 'c'), { tool: 'read', arguments: { resource_type: 'Patient', id: 'x', extra: 'fbfuzz' } });
  assert.deepEqual(mutateCall(tc, schema, 'nested_leaf_to_number', 'c'), { tool: 'read', arguments: { resource_type: 'Patient', id: 'x', extra: { k: 12345 } } });
  assert.deepEqual(mutateCall(tc, schema, 'all_strings_to_canary', 'c'), { tool: 'read', arguments: { resource_type: 'c', id: 'c', extra: { k: 'c' } } });
  assert.ok('not_applicable' in mutateCall(tc, {}, 'drop_all_required', 'c'));
  assert.ok('not_applicable' in mutateCall({ tool: 't', arguments: { request: { path: '/x' } } }, { required: ['request'] }, 'required_string_to_null', 'c'));
  assert.deepEqual(tc.arguments, { resource_type: 'Patient', id: 'x', extra: { k: 'v' } }, 'the original call is not changed');
});

test('real page handle transforms', () => {
  assert.equal(transformHandle('abcdef', 'truncate', 18217), 'abc');
  assert.equal(transformHandle('abcdef', 'flip', 18217), 'abceef');
  assert.equal(transformHandle('http://127.0.0.1:18217/fhir?_getpages=x', 'reorigin_backend', 18217), 'http://127.0.0.1:18190/fhir?_getpages=x');
  assert.ok(typeof transformHandle('opaque', 'reorigin_backend', 18217) !== 'string');
});

const FB_TOOLS = [
  { name: 'fhir_read', inputSchema: { type: 'object', required: ['resource_type', 'id'], properties: { resource_type: { type: 'string' }, id: { type: 'string' } } } },
  { name: 'fhir_search', inputSchema: { type: 'object', required: ['resource_type'], properties: { resource_type: { type: 'string' }, params: { type: 'array' }, page_size: { type: 'integer' } } } },
  { name: 'fhir_page', inputSchema: { type: 'object', required: ['cursor'], properties: { cursor: { type: 'string' } } } },
  { name: 'fhir_capabilities', inputSchema: { type: 'object', properties: { topic: { type: 'string' } } } },
];
const W_TOOLS = [
  { name: 'read', inputSchema: { type: 'object', required: ['type', 'id'], properties: { type: { type: 'string' }, id: { type: 'string' } } } },
  { name: 'search', inputSchema: { type: 'object', required: ['type', 'searchParam'], properties: { type: { type: 'string' }, searchParam: { type: 'object' } } } },
];

function fakeServer(reply: (tc: ToolCall) => string): Caller & { sent: ToolCall[] } {
  const sent: ToolCall[] = [];
  return {
    sent,
    async call(tc) {
      sent.push(tc);
      const line = `{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":${JSON.stringify(reply(tc))}}]}}`;
      return { tool: tc.tool, arguments: tc.arguments, started_at: '', latency_ms: 1, response_raw: line, is_error: false, bytes: null, error: null } satisfies CallOutcome;
    },
  };
}

const exec = (arm: 'FB0' | 'W', s: Caller, k: FuzzCase) => executeCase(s, {
  adapter: makeAdapter(arm, arm === 'W' ? W_TOOLS : FB_TOOLS, { cell: 'default', patientId: 'pat-1' }), parser: parserFor(arm),
  tools: arm === 'W' ? W_TOOLS : FB_TOOLS, pageSize: 100, patientId: 'pat-1', canary: 'http://127.0.0.1:18227/fbfuzz-canary/x', proxyPort: 18217,
  setupSearch: fill(corpus.setup_search, VARS),
}, k);

test('cases go through each arm\'s adapter: an empty cursor reaches fireboat verbatim; WSO2 has no paging tool', async () => {
  const fb = fakeServer(() => '{"error":{"code":"INVALID_CURSOR","safe_message":"bad"}}');
  const empty = corpus.cases.find(k => k.kind === 'cursor' && k.cursor === '')!;
  const r = await exec('FB0', fb, fill(empty, VARS));
  assert.equal(r.not_expressible, null);
  assert.deepEqual(fb.sent[0], { tool: 'fhir_page', arguments: { cursor: '' } });
  const w = await exec('W', fakeServer(() => '{}'), fill(empty, VARS));
  assert.match(w.not_expressible ?? '', /paging/);
  // A schema-driven mutation of WSO2's search: the first required string argument becomes a number.
  const ws = fakeServer(() => '{}');
  const m = corpus.cases.find(k => k.kind === 'mutate' && k.mutation === 'required_string_to_number' && k.base.op === 'search')!;
  await exec('W', ws, fill(m, VARS));
  assert.equal(ws.sent[0]!.arguments.type, 12345);
  // fireboat drops the bound patient; the page size override reaches the tool call.
  const ps = corpus.cases.find(k => k.kind === 'op' && 'page_size' in k && k.page_size === -1)!;
  const fs = fakeServer(() => '{}');
  await exec('FB0', fs, fill(ps, VARS));
  assert.deepEqual(fs.sent[0]!.arguments, { resource_type: 'Observation', params: [], page_size: -1 });
});

function record(over: Partial<FuzzRunRecord> & { reply?: string; isError?: boolean; rpcError?: boolean }): FuzzRunRecord {
  const line = over.rpcError ? '{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"Invalid params"}}'
    : `{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":${JSON.stringify(over.reply ?? '{}')}}]${over.isError ? ',"isError":true' : ''}}}`;
  return {
    schema: 'fbbench.fuzz-run/1', campaign: 'c', run_id: 'W__fuzz__synthea-dev__F001', arm: 'W', dataset: 'synthea-dev', case_id: 'F001', category: 'malformed_input',
    kind: 'mutate', expect: 'error', malformed_mcp: true, lexeme: null, number_id: null, slot: 7, patient_id: 'pat-1', other_patient_id: 'pat-2', started_at: '', wall_ms: 0,
    server: { pid: 1, cold_start_ms: 1, protocol_version: null, exit: null, stderr_path: '', egress_sandbox: 'none', start_error: null },
    not_expressible: null, tool_call: { tool: 'search', arguments: {} }, setup_calls: [],
    call: { tool: 'search', arguments: {}, started_at: '', latency_ms: 1, response_raw: line, is_error: over.isError ?? false, bytes: null, error: over.rpcError ? { kind: 'protocol', message: 'x' } : null },
    responsive_after: true, upstream: [], canary_hits: [], versions: {}, ...over,
  };
}

test('classification: structured errors, success-shaped failures, refusal before upstream, numbers, other patients', () => {
  assert.equal(classify(record({ isError: true, reply: 'validation error' })).outcome, 'is_error');
  const rpc = classify(record({ rpcError: true }));
  assert.equal(rpc.outcome, 'jsonrpc_error');
  assert.equal(rpc.refused_before_upstream, true);
  const oo = classify(record({ reply: '{"resourceType":"OperationOutcome","issue":[{"severity":"error","code":"processing","diagnostics":"HAPI-0524"}]}', upstream: [{ seq: 1, method: 'GET', path: '/fhir/Observation', status: 400, blocked: false }] }));
  assert.equal(oo.outcome, 'operation_outcome');
  assert.equal(oo.refused_before_upstream, false, 'it went upstream first');
  const meta = classify(record({ isError: true, upstream: [{ seq: 1, method: 'GET', path: '/fhir/metadata', status: 200, blocked: false }] }));
  assert.equal(meta.refused_before_upstream, true, 'a CapabilityStatement fetch is not the malformed request');
  const ssf = classify(record({ malformed_mcp: false, reply: '{"resourceType":"Bundle","type":"searchset","entry":[]}', upstream: [{ seq: 1, method: 'GET', path: '/fhir/Observation', status: 200, blocked: false }] }));
  assert.equal(ssf.success_shaped_failure, true);
  assert.equal(ssf.backend_accepted, true);
  assert.equal(ssf.acceptable, false);
  const obs = (v: string) => `{"resourceType":"Observation","id":"fbfuzz-num-1","subject":{"reference":"Patient/pat-1"},"valueQuantity":{"value":${v}}}`;
  const num = (v: string) => classify(record({ expect: 'value', malformed_mcp: false, lexeme: '1e-3', number_id: 'fbfuzz-num-1', reply: obs(v) }));
  assert.equal(num('1e-3').number_outcome, 'preserved');
  assert.equal(num('0.001').number_outcome, 'silently_altered');
  assert.equal(classify(record({ expect: 'value', lexeme: '1e-3', number_id: 'fbfuzz-num-1', reply: '{}', malformed_mcp: false })).number_outcome, 'dropped');
  const other = classify(record({ expect: 'either', malformed_mcp: false, reply: '{"resourceType":"Bundle","type":"searchset","entry":[{"resource":{"resourceType":"Observation","id":"o","subject":{"reference":"Patient/pat-2"}}}]}' }));
  assert.deepEqual(other.other_patient.refs, ['Observation/o']);
  const leak = classify(record({ isError: true, reply: 'Traceback (most recent call last):\n  File "/home/x/venv/lib/python3.12/site-packages/a.py", line 3' }));
  assert.deepEqual(leak.leaks, { stack_trace: true, file_path: true, secret: false });
  const timeout = classify(record({ call: { tool: 't', arguments: {}, started_at: '', latency_ms: 30000, response_raw: null, is_error: null, bytes: null, error: { kind: 'timeout', message: 'Request timed out' } } }));
  assert.equal(timeout.outcome, 'timeout');
  const ne = classify(record({ not_expressible: 'no paging tool', call: null }));
  assert.equal(ne.expressible, false);
  assert.equal(ne.acceptable, null);
  const s = summarise([rpc, oo, ssf, ne], 'synthea-dev')[0]!;
  assert.equal(s.expressible, 3);
  assert.equal(s.expect_error.success_shaped_failures, 1);
});

test('mock backend: fuzz Observations carry the exact lexeme; reads and _id searches are matched, nothing else', () => {
  const fx = new Map([['fbfuzz-num-2', { id: 'fbfuzz-num-2', lexeme: '9007199254740993' }]]);
  const text = numberObservation(fx.get('fbfuzz-num-2')!, 'pat-1');
  const v = parseLossless(text) as { valueQuantity: { value: LosslessNumber } };
  assert.equal(v.valueQuantity.value.lexeme, '9007199254740993');
  assert.equal(matchNumbers('GET', '/fhir/Observation/fbfuzz-num-2/', null, fx)?.kind, 'read');
  assert.equal(matchNumbers('GET', '/fhir/Observation?patient=Patient/pat-1&_id=fbfuzz-num-2&_count=100', null, fx)?.kind, 'search');
  assert.equal(matchNumbers('POST', '/fhir/Observation/_search', '_id=fbfuzz-num-2', fx)?.kind, 'search');
  assert.equal(matchNumbers('GET', '/fhir/Observation/other', null, fx), null);
  assert.equal(matchNumbers('GET', '/fhir/metadata', null, fx), null);
  const b = parseLossless(numberBundle([...fx.values()], 'pat-1', 'http://127.0.0.1:18217', 'http://127.0.0.1:18217/fhir/Observation?_id=x')) as { total: LosslessNumber; entry: unknown[] };
  assert.equal(b.total.lexeme, '1');
  assert.equal(b.entry.length, 1);
});
