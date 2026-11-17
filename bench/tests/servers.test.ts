// Arm registry, adapters, parsers and byte accounting. Fixtures are hand-written, synthetic, minimal.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import type { CallRecord, Cell, LaunchContext } from '../lib/types.js';
import { BENCH, REPO, type DatasetId } from '../lib/paths.js';
import { makeAdapter, pageSizeFor, searchParamMap } from '../servers/adapters.js';
import {
  ARMS, DEFAULT_ARMS, ENV_BIN, FB0_COMMIT, FB_COMMIT, INSTALL_DIRS, armVersions, availableArms, fb0Availability, mcpConfig, PATIENT_IDENTIFIER_SYSTEMS,
  resolveFireboatSource, SANDBOX_EXEC, SCRIPTED_ARMS, type ArmSpec, type GitRunner,
} from '../servers/arms.js';
import { bytesOf } from '../servers/launch.js';
import { fireboatParser, hydrantParser, momentumParser, PARSERS, wso2Parser } from '../servers/parsers.js';

const P = 'pat-1';
const obs = (id: string, value: string, patient = P) =>
  `{"resourceType":"Observation","id":"${id}","subject":{"reference":"Patient/${patient}"},"effectiveDateTime":"2150-01-01T00:00:00-05:00","code":{"text":"X"},"valueQuantity":{"value":${value},"unit":"mg/dL","system":"http://unitsofmeasure.org","code":"mg/dL"}}`;
const line = (result: string) => `{"jsonrpc":"2.0","id":3,"result":${result}}`;
const structured = (payload: string, isError = false) =>
  line(`{"content":[{"type":"text","text":${JSON.stringify(payload)}}],"structuredContent":${payload},"isError":${isError}}`);
const textOnly = (...texts: string[]) => line(`{"content":[${texts.map(t => `{"type":"text","text":${JSON.stringify(t)}}`).join(',')}],"isError":false}`);
const call = (response_raw: string, op: CallRecord['op'] = 'search'): CallRecord => ({
  seq: 0, op_index: 0, op, tool: 't', arguments: {}, started_at: '', latency_ms: 0, response_raw, is_error: false, bytes: null, error: null,
});

test('bytesOf separates text, structured content, result and line', () => {
  const l = structured('{"a":1.50}');
  const b = bytesOf(l);
  assert.equal(b.content_text, Buffer.byteLength('{"a":1.50}'));
  assert.equal(b.structured_content, Buffer.byteLength('{"a":1.50}'));
  assert.equal(b.line, Buffer.byteLength(l));
  assert.ok(b.result > b.content_text + b.structured_content);
});

test('fireboat parser: items keep lexemes; cursor, has_more and MORE_PAGES counted; blanket and evidence reasons not counted', () => {
  const env = `{"schema_version":"0.3","data":{"resources":[${obs('o1', '12.3400')},${obs('o2', '7.0')}]},` +
    `"coverage":{"state":"partial","scope":"page","reasons":["CLINICAL_RECORD_COMPLETENESS_UNKNOWN","MORE_PAGES","FILTER_EXECUTION_UNVERIFIED"],"authorization_limited":true,"query_exhausted":false,"pages_observed":1,"query_evidence":"exact_id_and_subject_linkage"},` +
    `"pagination":{"has_more":true,"returned_matches":2,"returned_includes":0,"next_cursor":"cur_x","total":{"precision":"unknown"}}}`;
  const p = fireboatParser.parse(call(structured(env)));
  assert.deepEqual(p.items.map(i => i.value), ['12.3400', '7.0']);
  assert.equal(p.items[0]!.patient, P);
  assert.equal(p.page_handle, 'cur_x');
  assert.deepEqual(p.signals.map(s => s.kind).sort(), ['cursor', 'has_more', 'more_pages_reason']);
  assert.ok(p.blanket.includes('CLINICAL_RECORD_COMPLETENESS_UNKNOWN'));
  assert.ok(p.blanket.includes('FILTER_EXECUTION_UNVERIFIED'));
  assert.equal(p.explicit_complete, false);
  assert.equal(p.refused, null);
});

test('fireboat parser: only complete_for_query or an accurate total equal to |R| is a completeness claim', () => {
  const env = (state: string, pg: string) => `{"schema_version":"0.3","data":{"resources":[${obs('o1', '1')}]},` +
    `"coverage":{"state":"${state}","scope":"query","reasons":[],"authorization_limited":false,"query_exhausted":true,"pages_observed":1,"query_evidence":"none"},"pagination":${pg}}`;
  const parse = (state: string, pg: string) => fireboatParser.parse(call(structured(env(state, pg)))).explicit_complete;
  assert.equal(parse('unknown', '{"has_more":false,"returned_matches":1,"total":{"value":1,"precision":"unknown"}}'), false);
  assert.equal(parse('unknown', '{"has_more":false,"returned_matches":1,"total":{"value":1,"precision":"estimate"}}'), false);
  assert.equal(parse('unknown', '{"has_more":false,"returned_matches":1,"total":{"value":1,"precision":"accurate"}}'), true);
  assert.equal(parse('complete_for_query', '{"has_more":false,"returned_matches":1}'), true);
});

test('fireboat parser: withheld-by-policy reasons on a partial final page are counted omissions', () => {
  for (const reason of ['RECORDS_WITHHELD_BY_POLICY', 'SHARED_RECORDS_WITHHELD_BY_POLICY']) {
    const env = `{"schema_version":"0.3","data":{"resources":[${obs('o1', '1')}]},` +
      `"coverage":{"state":"partial","scope":"page","reasons":["CLINICAL_RECORD_COMPLETENESS_UNKNOWN","FILTER_EXECUTION_UNVERIFIED","${reason}"],"authorization_limited":true,"query_exhausted":null,"pages_observed":1,"query_evidence":"none"},` +
      `"pagination":{"has_more":false,"returned_matches":1,"total":{"precision":"unknown"}}}`;
    const p = fireboatParser.parse(call(structured(env)));
    assert.deepEqual(p.signals.map(s => [s.kind, s.detail]), [['coverage_partial', reason]]);
    assert.equal(p.explicit_complete, false);
  }
});

test('fireboat parser: error envelope is a refusal', () => {
  const env = '{"schema_version":"0.3","data":{},"coverage":{"state":"unknown","scope":"query","reasons":[],"authorization_limited":false,"query_exhausted":null,"pages_observed":0,"query_evidence":"none"},"error":{"code":"POLICY_DENIED","safe_message":"no","retryable":false}}';
  const p = fireboatParser.parse(call(structured(env, true)));
  assert.equal(p.refused?.code, 'POLICY_DENIED');
  assert.equal(p.is_error, true);
});

test('WSO2 parser: Bundle under result, next link and total counted, total == |R| is explicit', () => {
  const bundle = `{"resourceType":"Bundle","total":3,"link":[{"relation":"next","url":"http://h/fhir?_getpages=a"}],"entry":[{"resource":${obs('o1', '1.1')}}]}`;
  const p = wso2Parser.parse(call(structured(`{"result":${bundle}}`)));
  assert.equal(p.items[0]!.value, '1.1');
  assert.equal(p.page_handle, 'http://h/fhir?_getpages=a');
  assert.deepEqual(p.signals.map(s => s.kind).sort(), ['next_link', 'total_gt_returned']);
  const q = wso2Parser.parse(call(structured(`{"result":{"resourceType":"Bundle","total":1,"entry":[{"resource":${obs('o1', '1')}}]}}`)));
  assert.equal(q.explicit_complete, true);
});

test('WSO2 parser: bare issue list in text blocks is a refusal', () => {
  const p = wso2Parser.parse(call(textOnly('{"severity":"error","code":"processing","diagnostics":"bad"}')));
  assert.deepEqual(p.refused, { code: 'processing', message: 'bad' });
});

test('momentum parser: error_message and wrapped response', () => {
  assert.equal(momentumParser.parse(call(structured('{"result":{"error_message":"401: Invalid client credentials"}}'))).refused?.code, 'error_message');
  const ok = momentumParser.parse(call(structured(`{"result":{"method":"GET","path":"x","body":null,"response":{"resourceType":"Bundle","entry":[{"resource":${obs('o1', '2', 'other')}}]}}}`)));
  assert.equal(ok.items[0]!.patient, 'other');
});

test('fhirHydrant parser: compact references and codings, hasMore and continuation counted', () => {
  const env = '{"status":"ok","responseMode":"compact","truncated":false,"hasMore":true,"bundle":{"entries":1,"total":9},"continuation":{"url":"http://h/fhir?_getpages=b"},' +
    '"data":{"resourceType":"Bundle","entry":[{"resource":{"resourceType":"Observation","id":"o1","subject":"Patient/pat-1","code":{"coding":[{"code":"1","display":"D"}]},"valueQuantity":{"value":5,"unit":"%"}}}]}}';
  const p = hydrantParser.parse(call(structured(env)));
  assert.deepEqual(p.items[0], { ref: 'Observation/o1', patient: P, value: '5', comparator: null, unit: '%', unit_code: null, unit_system: null, time: null, display: 'D' });
  assert.equal(p.page_handle, 'http://h/fhir?_getpages=b');
  assert.deepEqual(p.signals.map(s => s.kind).sort(), ['has_more', 'next_link', 'total_gt_returned']);
});

test('transport failure parses as an error with no items', () => {
  const c = call('', 'search');
  c.response_raw = null; c.error = { kind: 'timeout', message: 't' };
  assert.equal(wso2Parser.parse(c).refused?.code, 'timeout');
});

const tools = (names: string[], props: Record<string, string[]> = {}) =>
  names.map(name => ({ name, inputSchema: { type: 'object', properties: Object.fromEntries((props[name] ?? []).map(p => [p, { type: 'string' }])) } }));

test('fireboat adapter omits the bound patient and maps _count to page_size', () => {
  const a = makeAdapter('FB0', tools(['fhir_search', 'fhir_page', 'fhir_read', 'fhir_capabilities']), { cell: 'default', patientId: P });
  const r = a.search('Observation', [['patient', `Patient/${P}`], ['code', 's|1'], ['_count', '10']], 100);
  assert.ok('call' in r);
  assert.deepEqual(r.call.arguments, { resource_type: 'Observation', params: [{ name: 'code', value: 's|1' }], page_size: 10 });
  assert.deepEqual(a.next({ items: [], signals: [], blanket: [], explicit_complete: false, page_handle: 'cur_1', refused: null, is_error: false }),
    { tool: 'fhir_page', arguments: { cursor: 'cur_1' } });
});

test('WSO2 adapter: repeated params become arrays, _count added, next cannot continue by default', () => {
  assert.deepEqual(searchParamMap([['date', 'ge1'], ['date', 'lt2'], ['code', 'c']]), { date: ['ge1', 'lt2'], code: 'c' });
  const a = makeAdapter('W', tools(['search', 'read', 'get_capabilities']), { cell: 'default', patientId: P });
  const r = a.search('Observation', [['patient', `Patient/${P}`]], 200);
  assert.ok('call' in r);
  assert.deepEqual(r.call.arguments, { type: 'Observation', searchParam: { patient: `Patient/${P}`, _count: '200' } });
  assert.ok('refused' in a.capabilities(null));
  assert.ok('cannot_continue' in a.next({ items: [], signals: [], blanket: [], explicit_complete: false, page_handle: 'http://h/fhir?_getpages=a', refused: null, is_error: false }));
  const replay = makeAdapter('W', tools(['search']), { cell: 'default', patientId: P, replay: true });
  replay.search('Observation', [], 200);
  assert.deepEqual(replay.next({ items: [], signals: [], blanket: [], explicit_complete: false, page_handle: 'http://h/fhir?_getpages=a&_getpagesoffset=200', refused: null, is_error: false }),
    { tool: 'search', arguments: { type: 'Observation', searchParam: { _getpages: 'a', _getpagesoffset: '200' } } });
});

test('momentum adapter builds relative GET paths; replay strips the base path', () => {
  const a = makeAdapter('M', tools(['request_generic_resource']), { cell: 'default', patientId: P, replay: true });
  const r = a.search('Observation', [['patient', `Patient/${P}`], ['code', 's|1']], 200);
  assert.ok('call' in r);
  assert.deepEqual(r.call.arguments, { request: { method: 'GET', path: `/Observation?patient=Patient%2F${P}&code=s%7C1&_count=200` } });
  assert.deepEqual(a.next({ items: [], signals: [], blanket: [], explicit_complete: false, page_handle: 'http://127.0.0.1:18230/fhir?_getpages=a', refused: null, is_error: false }),
    { tool: 'request_generic_resource', arguments: { request: { method: 'GET', path: '?_getpages=a' } } });
});

test('fhirHydrant adapter: own tool per type, equivalents, dropped params flagged, _count only when listed', () => {
  const a = makeAdapter('H', tools(['observation', 'paginate', 'capabilities'], { observation: ['action', 'patient', 'subject', 'code', 'date', '_id'] }), { cell: 'default', patientId: P });
  const r = a.search('Observation', [['subject', `Patient/${P}`], ['code', 's|1'], ['date', 'ge1'], ['date', 'lt2'], ['value-quantity', 'gt5']], 200);
  assert.ok('call' in r);
  assert.deepEqual(r.call.arguments, { action: 'search', subject: `Patient/${P}`, code: 's|1', date: 'ge1' });
  assert.deepEqual(r.flags, ['param_dropped:date', 'param_dropped:value-quantity']);
  assert.ok('refused' in a.read('Condition', 'c1'));
  assert.deepEqual(a.read('Observation', 'o1'), { tool: 'observation', arguments: { action: 'read', _id: 'o1' } });
});

test('mcpConfig runs the server under env -i with only its declared environment, inside the egress sandbox', () => {
  const cmd = { command: '/x/server', args: ['--a'], env: { PATH: '/usr/bin', HOME: '/run', FOO: 'a=b' }, cwd: '/run', files: {} };
  const c = mcpConfig(cmd).mcpServers.ehr!;
  assert.equal(c.command, SANDBOX_EXEC);
  const i = c.args.indexOf(ENV_BIN);
  assert.ok(i > 0);
  assert.deepEqual(c.args.slice(i), [ENV_BIN, '-i', 'PATH=/usr/bin', 'HOME=/run', 'FOO=a=b', '/x/server', '--a']);
  assert.deepEqual(mcpConfig(cmd, { sandbox: false }).mcpServers.ehr!.args, ['-i', 'PATH=/usr/bin', 'HOME=/run', 'FOO=a=b', '/x/server', '--a']);
  assert.deepEqual(mcpConfig(null), { mcpServers: {} });
});

const fireboatConfig = (arm: 'FB' | 'FBd' | 'FBt', dataset: DatasetId, cell: Cell): Record<string, unknown> => {
  const ctx: LaunchContext = { arm, dataset, patientId: P, slot: 5, cell, fhirBaseUrl: 'http://127.0.0.1:18215/fhir', runDir: '/nonexistent/run', runTmp: '/nonexistent/tmp' };
  const cmd = ARMS[arm].command!(ctx);
  return JSON.parse(cmd.files['fireboat.json']!) as Record<string, unknown>;
};

test('FBd: FB\'s build and config without the shared lists; patient identifier systems kept', () => {
  assert.equal(ARMS.FBd.status, ARMS.FB.status);
  assert.deepEqual(ARMS.FBd.pin, ARMS.FB.pin);
  assert.equal(ARMS.FBd.installDir, ARMS.FB.installDir);
  assert.equal(INSTALL_DIRS.FBd, INSTALL_DIRS.FB);
  assert.ok(SCRIPTED_ARMS.includes('FBd'));
  assert.equal(PARSERS.FBd, PARSERS.FB);
  assert.equal(pageSizeFor('FBd'), pageSizeFor('FB'));
  for (const dataset of ['mimic', 'synthea-dev'] as const) {
    for (const cell of ['default', 'best_effort'] as const) {
      const fb = fireboatConfig('FB', dataset, cell);
      const fbd = fireboatConfig('FBd', dataset, cell);
      const privacy = fbd.privacy as Record<string, unknown>;
      assert.deepEqual(Object.keys(privacy), ['patientIdentifierSystems'], `${dataset} ${cell}`);
      assert.deepEqual(privacy.patientIdentifierSystems, PATIENT_IDENTIFIER_SYSTEMS[dataset]);
      if (cell === 'best_effort') assert.deepEqual(fbd.limits, fb.limits);
      else assert.equal(fbd.limits, undefined);
      const { sharedIdentifierSystems: _a, sharedProfiles: _b, ...fbPrivacy } = fb.privacy as Record<string, unknown>;
      assert.deepEqual(fbd, { ...fb, privacy: fbPrivacy }, `${dataset} ${cell}: only the shared lists differ`);
    }
  }
  // FB itself carries the lists where the dataset has them, so the comparison above is not vacuous.
  assert.ok('sharedIdentifierSystems' in (fireboatConfig('FB', 'mimic', 'default').privacy as object));
  assert.ok('sharedProfiles' in (fireboatConfig('FB', 'synthea-dev', 'default').privacy as object));
  const fbCmd = ARMS.FB.command!({ arm: 'FB', dataset: 'mimic', patientId: P, slot: 5, fhirBaseUrl: 'x', runDir: '/r', runTmp: '/t' });
  const fbdCmd = ARMS.FBd.command!({ arm: 'FBd', dataset: 'mimic', patientId: P, slot: 5, fhirBaseUrl: 'x', runDir: '/r', runTmp: '/t' });
  assert.deepEqual({ ...fbdCmd, files: {} }, { ...fbCmd, files: {} });
});

const MIX = 'http://mimic.mit.edu/fhir/mimic/identifier/medication-mix';

test('FB lists only general shared systems; FBt is FB plus the MIMIC medication-mix system, Synthea unchanged', () => {
  assert.deepEqual(ARMS.FBt.pin, ARMS.FB.pin);
  assert.equal(ARMS.FBt.installDir, ARMS.FB.installDir);
  assert.ok(SCRIPTED_ARMS.includes('FBt'));
  assert.equal(PARSERS.FBt, PARSERS.FB);
  for (const cell of ['default', 'best_effort'] as const) {
    const fbMimic = fireboatConfig('FB', 'mimic', cell).privacy as Record<string, string[]>;
    const fbtMimic = fireboatConfig('FBt', 'mimic', cell).privacy as Record<string, string[]>;
    assert.ok(!fbMimic.sharedIdentifierSystems!.includes(MIX), 'FB has no medication-mix listing');
    assert.ok(fbMimic.sharedIdentifierSystems!.length > 0, 'FB keeps its other systems');
    assert.deepEqual(fbtMimic.sharedIdentifierSystems, [...fbMimic.sharedIdentifierSystems!, MIX]);
    const { privacy: _p, ...fbRest } = fireboatConfig('FB', 'mimic', cell);
    const { privacy: _q, ...fbtRest } = fireboatConfig('FBt', 'mimic', cell);
    assert.deepEqual(fbtRest, fbRest);
    assert.deepEqual(fbtMimic.sharedProfiles, fbMimic.sharedProfiles);
    assert.deepEqual(fireboatConfig('FBt', 'synthea-dev', cell), fireboatConfig('FB', 'synthea-dev', cell));
  }
});

// ---- Which fireboat the arms build --------------------------------------------------------------------------------

const H1 = '1'.repeat(40), H2 = '2'.repeat(40);
/** A fake git: answers from a table keyed by the joined arguments, throws for anything else (as git exits non-zero). */
const fakeGit = (answers: Record<string, string>): GitRunner & { calls: string[] } => {
  const calls: string[] = [];
  const run = ((args: readonly string[]) => {
    const k = args.join(' ');
    calls.push(k);
    if (!(k in answers)) throw new Error(`git ${k}: fails`);
    return answers[k]!;
  }) as GitRunner & { calls: string[] };
  run.calls = calls;
  return run;
};

test('fireboat source: the checkout at HEAD by default, with its dirty flag and package version', () => {
  const clean = resolveFireboatSource({}, fakeGit({ 'rev-parse --verify HEAD^{commit}': H1, 'status --porcelain': '', [`show ${H1}:package.json`]: '{"version":"9.9.9-test"}' }));
  assert.deepEqual(clean, { commit: H1, commitFrom: 'HEAD', treeDirty: false, version: '9.9.9-test' });
  const dirty = resolveFireboatSource({}, fakeGit({ 'rev-parse --verify HEAD^{commit}': H1, 'status --porcelain': ' M README.md' }));
  assert.deepEqual(dirty, { commit: H1, commitFrom: 'HEAD', treeDirty: true, version: 'unknown' });
});

test('fireboat source: FB_COMMIT names another commit of this repository; an unknown one makes the arms unavailable', () => {
  const git = fakeGit({ 'rev-parse --verify --quiet v1^{commit}': H2, [`show ${H2}:package.json`]: '{"version":"1.0.0"}' });
  assert.deepEqual(resolveFireboatSource({ FB_COMMIT: ' v1 ' }, git), { commit: H2, commitFrom: 'FB_COMMIT', treeDirty: false, version: '1.0.0' });
  assert.ok(!git.calls.includes('status --porcelain'), 'a named commit is built as committed; the working tree is not consulted');
  const missing = resolveFireboatSource({ FB_COMMIT: 'nope' }, fakeGit({}));
  assert.ok('unavailable' in missing && /FB_COMMIT=nope is not a commit/.test(missing.unavailable));
  const noRepo = resolveFireboatSource({}, fakeGit({}));
  assert.ok('unavailable' in noRepo && /git checkout/.test(noRepo.unavailable));
});

test('fireboat arms in this checkout build HEAD unless FB_COMMIT is set, and share one pin and install', () => {
  const head = execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (!process.env.FB_COMMIT) {
    assert.equal(FB_COMMIT, head);
    assert.equal(ARMS.FB.pin!.commitFrom, 'HEAD');
    assert.equal(typeof ARMS.FB.pin!.treeDirty, 'boolean');
  }
  for (const a of ['FBd', 'FBt', 'FBh', 'FBdh'] as const) {
    assert.deepEqual(ARMS[a].pin, ARMS.FB.pin, a);
    assert.equal(INSTALL_DIRS[a], INSTALL_DIRS.FB, a);
  }
  assert.ok(INSTALL_DIRS.FB.endsWith(`fb-${FB_COMMIT.slice(0, 12)}`));
  assert.deepEqual(armVersions('FB'), { arm_pin: FB_COMMIT, arm_tree_dirty: ARMS.FB.pin!.treeDirty });
  assert.deepEqual(armVersions('W'), { arm_pin: ARMS.W.pin!.commit });
});

test('FB0 is skipped with one message when its commit is not in the repository', () => {
  assert.equal(fb0Availability(fakeGit({ [`cat-file -e ${FB0_COMMIT}^{commit}`]: '' })), null);
  const why = fb0Availability(fakeGit({}));
  assert.match(why!, /^FB0 builds fireboat as first published \(commit ad7f9f2\), which is not in this repository; skipping FB0$/);
  const registry = { ...ARMS, FB0: { id: 'FB0', status: 'unavailable', unavailable: why!, pin: null, installDir: null, command: null } as ArmSpec };
  const lines: string[] = [];
  assert.deepEqual(availableArms(['FB0', 'W', 'FB'], l => lines.push(l), registry), ['W', 'FB']);
  assert.deepEqual(lines, [`FB0: ${why}`]);
  assert.deepEqual(availableArms(['W', 'H'], l => lines.push(l), registry), ['W', 'H']);
  assert.equal(lines.length, 1);
  // FB0 keeps its definition: the commit it builds and its install directory.
  assert.ok(INSTALL_DIRS.FB0.endsWith('fb0-ad7f9f2'));
  if (ARMS.FB0.status === 'active') assert.equal(ARMS.FB0.pin!.commit, FB0_COMMIT);
  else assert.match(ARMS.FB0.unavailable!, /skipping FB0/);
});

test('default arms: FB and W, never FB0, the same in the shell drivers', () => {
  assert.deepEqual(DEFAULT_ARMS, ['FB', 'W']);
  assert.ok(!DEFAULT_ARMS.includes('FB0'));
  for (const a of DEFAULT_ARMS) assert.ok(SCRIPTED_ARMS.includes(a) && ARMS[a].status !== 'deferred', a);
  const baseline = readFileSync(join(BENCH, 'run/baseline.sh'), 'utf8');
  assert.equal(/ARMS="\$\{3:-([^}]*)\}"/.exec(baseline)?.[1], DEFAULT_ARMS.join(' '));
  const setup = readFileSync(join(BENCH, 'run/setup.sh'), 'utf8');
  assert.match(setup, new RegExp(`bench:install -- --arm ${DEFAULT_ARMS.join(',')}(\\s|$)`));
  for (const f of ['servers/install.ts', 'servers/check.ts', 'run/scripted.ts', 'fuzz/run.ts', 'latency/run.ts']) {
    const src = readFileSync(join(BENCH, f), 'utf8');
    assert.doesNotMatch(src, /values\.arm \?\? '/, `${f}: a literal default instead of DEFAULT_ARMS`);
    assert.match(src, /values\.arm \?\? DEFAULT_ARMS\.join/, f);
  }
});
