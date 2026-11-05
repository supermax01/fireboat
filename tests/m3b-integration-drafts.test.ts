// D01–D14 live conversion. Keep this file until S7 (A7).
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { withGateway, withSdk, lab, hba1c, output, patient, context, sourceAlias, type Rec } from './s57-sdk-helpers.js';
import { scanObservedCodes } from '../examples/observed-code-scan.js';

const eras = ['modern','legacy'] as const;
const noMatches = 'No matches were delivered for this executed query; this does not establish absence of the clinical concept.';
const suffix = ' Filter execution is not verified.';
const search = { resource_type: 'Observation', params: hba1c, output };
const warning = (e: Rec) => e.warnings.find((w: Rec) => w.code === 'NO_MATCHES');
const success = (e: Rec) => assert.equal(e.error, undefined);

for (const [id, profile] of [['D01',true], ['D02',false]] as const) test(`${id} live filtered exhausted zero and exact NO_MATCHES through both SDK eras`, async () => {
  for (const era of eras) await withGateway({ pages: [[]], profile }, g => withSdk(g, era, async s => {
    const { e } = await s.call('fhir_search', search); success(e);
    assert.equal(e.coverage.state, profile ? 'complete_for_query' : 'unknown');
    assert.equal(e.coverage.query_exhausted, true); assert.equal(e.pagination.has_more, false);
    assert.equal(warning(e)?.message, noMatches + (profile ? '' : suffix));
    assert.deepEqual(warning(e).repair, { action: 'inspect_observed_codes', tool: 'fhir_search', resource_type: 'Observation', fields: ['code'], page_size: 100, max_pages: 3, max_calls: 4 });
    assert.equal(e.warnings.some((w: Rec) => w.code === 'TEST_QUERY_EVIDENCE'), profile);
  }));
});
test('D03 live unfiltered empty search has no NO_MATCHES in both SDK eras', async () => {
  for (const era of eras) await withGateway({ pages: [[]] }, g => withSdk(g, era, async s => {
    const { e } = await s.call('fhir_search', { resource_type: 'Observation', output }); success(e);
    assert.equal(e.coverage.query_exhausted, true); assert.equal(warning(e), undefined);
  }));
});
test('D04 live intermediate empty page preserves a cursor without NO_MATCHES in both SDK eras', async () => {
  for (const era of eras) await withGateway({ pages: [[],[lab()]] }, g => withSdk(g, era, async s => {
    const { e } = await s.call('fhir_search', search); success(e);
    assert.equal(e.coverage.query_exhausted, false); assert.equal(e.pagination.has_more, true);
    assert.equal(warning(e), undefined);
    const page = await s.call('fhir_page', { cursor: e.pagination.next_cursor, output }); success(page.e);
    assert.equal(page.e.data.resources.length, 1); assert.equal(warning(page.e), undefined);
  }));
});
test('D05 live zero page after earlier delivery never emits NO_MATCHES in both SDK eras', async () => {
  for (const era of eras) await withGateway({ pages: [[lab()],[]] }, g => withSdk(g, era, async s => {
    const first = await s.call('fhir_search', search); success(first.e);
    assert.equal(first.e.data.resources.length, 1);
    const { e } = await s.call('fhir_page', { cursor: first.e.pagination.next_cursor, output }); success(e);
    assert.equal(e.data.resources.length, 0); assert.equal(warning(e), undefined);
    const replay = await s.call('fhir_page', { cursor: first.e.pagination.next_cursor, output });
    assert.equal(warning(replay.e), undefined); assert.equal(replay.e.coverage.pages_observed, 2);
  }));
});
test('D06 live observed-code scan has independent page/call/byte/work bounds in both SDK eras', async () => {
  const rows = Array.from({ length: 320 }, (_, i) => lab(`synthetic-${i}`));
  for (const era of eras) await withGateway({ pages: [rows] }, (g, requests) => withSdk(g, era, async s => {
    const calls: {name:string;arguments:Rec}[] = [], results: Rec[] = [];
    // This isolated source has no auth, retry, metadata races or prefetch:
    // one metadata request and at most one clinical request per MCP call.
    // Enforce that smaller driver bound at the same pre-send stats edge.
    const transport = (g as any).transport, get = transport.get.bind(transport);
    let callWork = 0;
    transport.get = (url: URL, stats: {calls:number}, budget: unknown) => get(url, {
      get calls() { return stats.calls; }, set calls(n: number) { assert.ok(++callWork <= 2, 'driver refuses before a third request'); stats.calls = n; },
    }, budget);
    const report = await scanObservedCodes({ upstreamWork: { maxPerCall: 2, total: () => requests.length },
      callTool: async (request, {signal}) => { assert.equal(signal.aborted, false); callWork = 0; calls.push(request); const r = await s.call(request.name as never, request.arguments); results.push(r.e); return r.result as never; } },
    { resourceType: 'Observation', trustedBinding: { source: sourceAlias, contextHandle: context, selector: { name: 'subject', value: `Patient/${patient}` } }, dateWindow: hba1c.filter(p => p.name === 'date') });
    assert.equal(report.status, 'partial'); assert.equal(report.code, 'SCAN_LIMIT_REACHED');
    assert.ok(report.clinicalPages > 0 && report.clinicalPages <= 3); assert.equal(report.mcpCalls, report.clinicalPages + 1); assert.ok(report.mcpCalls <= 4); assert.ok(report.bytes <= 73728); assert.ok(report.upstreamCalls <= 20);
    assert.equal(report.upstreamCalls, requests.length); assert.ok(report.observed.length > 0);
    assert.equal(results.at(-1)!.pagination.has_more, true); assert.ok(results.at(-1)!.pagination.next_cursor);
    assert.deepEqual(calls.map(c => c.name), ['fhir_capabilities','fhir_search', ...Array(report.clinicalPages - 1).fill('fhir_page')]);
    assert.equal(requests.filter(u => !u.pathname.endsWith('/metadata')).length, 1, 'local remainders drain without hidden upstream work');
    for (const url of requests.filter(u => !u.pathname.endsWith('/metadata'))) {
      assert.deepEqual(url.searchParams.getAll('date'), hba1c.filter(p => p.name === 'date').map(p => p.value));
      assert.ok(url.searchParams.getAll('subject').every(v => v === `Patient/${patient}`));
      assert.equal(url.searchParams.has('code'), false); assert.equal(url.searchParams.get('_count'), '100');
    }
    assert.ok(!requests.some(u => /ValueSet|CodeSystem|\$expand|\$lookup/.test(u.pathname)));
  }));
});

const corpus = JSON.parse(readFileSync(new URL('./fixtures/s5-projection-v2.json', import.meta.url), 'utf8')) as Rec;
const paths = ['resourceType','id','meta.versionId','meta.profile','meta.security','meta.tag','status','_status','code','valueQuantity','effectiveDateTime','_effectiveDateTime','referenceRange','component'];
const at = (value: Rec, path: string) => path.split('.').reduce((node, key) => node?.[key], value);
const formats = ['fhir','compact','selected'] as const;
const raw = (body: string) => body.replace(/"value":7(?=[,}])/g, '"value":7.0').replace(/"value":120(?=[,}])/g, '"value":120.00');
for (const [id, tool] of [['D07','fhir_read'],['D08','fhir_search'],['D09','fhir_page'],['D10','fhir_result']] as const) test(`${id} live critical tuples via ${tool} in every format and both SDK eras`, async () => {
  for (const era of eras) for (const format of formats) await withGateway({ pages: [[lab()],[lab('synthetic-page')]], raw }, g => withSdk(g, era, async s => {
    const o = { ...output, format: format === 'compact' ? 'compact' : 'fhir', ...(format === 'selected' ? { fields: corpus.selectedFields } : {}) };
    let e: Rec, wire: Rec;
    const actions = tool === 'fhir_result' ? ['project','page'] : [undefined];
    for (const action of actions) {
      let args: Rec = { resource_type: 'Observation', output: o };
      if (tool === 'fhir_read') args.id = 'synthetic-lab';
      if (tool === 'fhir_page' || tool === 'fhir_result') {
        const initial = await s.call('fhir_search', { resource_type: 'Observation', output }); success(initial.e);
        args = tool === 'fhir_page' ? { cursor: initial.e.pagination.next_cursor, output: o } : { handle: initial.e.result.handle, action, output: o };
      }
      ({e,wire} = await s.call(tool, args)); success(e);
      const wanted = lab(tool === 'fhir_page' ? 'synthetic-page' : 'synthetic-lab');
      const delivered = JSON.parse(JSON.stringify(e.data.resources[0]));
      for (const path of paths) assert.deepEqual(at(delivered,path), at(wanted,path), `critical ${path} retained`);
      assert.equal(e.provenance.length, 1); assert.equal(e.provenance[0].resource_index, 0);
      assert.equal(delivered.meta.versionId, '7'); assert.equal(e.source.alias, sourceAlias);
      const text = JSON.stringify(wire.structuredContent.data.resources[0]);
      assert.match(text, /"value":7\.0[,}]/); assert.match(text, /"value":120\.00[,}]/);
      if (tool === 'fhir_result') { assert.equal(e.coverage.scope, 'retained'); assert.equal(e.coverage.query_exhausted, null); }
    }
  }));
});
test('D11 live structural records retain the full sanitized view across tools/formats and both SDK eras', async () => {
  const structural = lab('synthetic-structural', { modifierExtension: [{ url: 'http://example.test/negation', valueBoolean: true }] });
  for (const era of eras) for (const format of formats) await withGateway({ pages: [[structural],[structural]] }, g => withSdk(g, era, async s => {
    const o = { ...output, format: format === 'compact' ? 'compact' : 'fhir', ...(format === 'selected' ? { fields: ['valueQuantity'] } : {}) };
    const first = await s.call('fhir_search', { resource_type: 'Observation', output: o }); success(first.e);
    const calls = [first, await s.call('fhir_read', { resource_type: 'Observation', id: structural.id, output: o }),
      await s.call('fhir_page', { cursor: first.e.pagination.next_cursor, output: o }),
      await s.call('fhir_result', { handle: first.e.result.handle, action: 'project', output: o }), await s.call('fhir_result', { handle: first.e.result.handle, action: 'page', output: o })];
    for (const {e} of calls) {
      success(e); assert.deepEqual(JSON.parse(JSON.stringify(e.data.resources)), [structural]);
      assert.deepEqual(e.transform.structural_resource_indices, [0]); assert.deepEqual(e.transform.recipe_ids, []);
      assert.ok(e.warnings.some((w: Rec) => w.code === 'UNINTERPRETED_MODIFIER'));
    }
  }));
});
for (const [id,era] of [['D12','modern'],['D13','legacy']] as const) test(`${id} live slim SDK evidence with complete structured content and exact bytes`, async () => {
  await withGateway({ structured: true }, g => withSdk(g, era, async s => {
    const {e,result,wire} = await s.call('fhir_read', { resource_type: 'Observation', id: 'synthetic-lab', output: {format:'fhir',max_bytes:8192} }); success(e);
    assert.equal(e.transform.delivery_profile, 'structured-evidence-v1');
    assert.match((result.content as Rec[])[0]!.text, /^delivery_profile: "structured-evidence-v1"\n/);
    assert.deepEqual(JSON.parse(JSON.stringify(e.data.resources)), [lab()]);
    assert.equal(e.provenance.length, 1); assert.equal(wire.resultType, era === 'modern' ? 'complete' : undefined);
    assert.ok(e.warnings.some((w: Rec) => w.code === 'UNVERIFIED_DELIVERY_PROFILE'));
  }));
});
test('D14 live whole-result full-text fallback labelled before fitting in both SDK eras', async () => {
  for (const era of eras) await withGateway({ structured: true }, g => withSdk(g, era, async s => {
    for (const topic of ['context','server','resource','schema','search_parameter','support']) {
      const {e,result} = await s.call('fhir_capabilities', { topic, ...(['resource','schema','search_parameter'].includes(topic) ? {resource_type:'Observation'} : {}), output: {max_bytes:topic === 'context' ? 4096 : 24576} }); success(e);
      assert.equal(e.transform.delivery_profile, 'full-text-v1');
      assert.match((result.content as Rec[])[0]!.text, /^delivery_profile: "full-text-v1"\n/);
      assert.match((result.content as Rec[])[0]!.text, /"delivery_profile":"full-text-v1"/);
    }
  }));
});
