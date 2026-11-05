import assert from 'node:assert/strict';
import test from 'node:test';
import { withSource, gate, callerReasonPage } from './s53-r2-helpers.js';

for (const reason of ['MORE_PAGES', 'CONTINUATION_QUERY_UNVERIFIED', 'NON_CONTINUABLE_UPSTREAM_LINK', 'RETAINED_PAGE_IS_NOT_THE_ENTIRE_QUERY', 'UNRESOLVED_FIELDS', 'INVALID_RESOURCE_VERSION', 'X_UNKNOWN']) {
  test(`N-07 caller reason ${reason} prevents completeness and NO_MATCHES`, async () => {
    await withSource({ pages: 1, perPage: [0], profile: true }, async (g, c) => {
      const r = await g.execute('fhir_search', { resource_type: 'Observation', params: [{ name: 'code', value: 'http://loinc.org|4548-4' }] });
      assert.equal(r.error, undefined);
      const x = gate(c, 'fhir_search', c.last(), { tool: 'fhir_search', deliveredCount: 0, reasons: [reason] }, [], callerReasonPage(reason));
      assert.equal(x.r.coverage.state, 'partial');
      assert.equal(x.r.coverage.query_exhausted, null);
      assert.equal(x.r.warnings.some((w: { code: string }) => w.code === 'NO_MATCHES'), false);
      assert.deepEqual(x.result, { ok: true });
    });
  });
}
test('N-11 source-incomplete single page names source incompleteness without continuation uncertainty', async () => {
  await withSource({ pages: 1, outcome: () => ({ resourceType: 'OperationOutcome', issue: [{ severity: 'warning', code: 'incomplete' }] }) }, async (g, c) => {
    const r = await g.execute('fhir_search', { resource_type: 'Observation', output: { format: 'fhir' } });
    const x = gate(c, 'fhir_search', c.last(), { tool: 'fhir_search', deliveredCount: 1 }, r.data.resources as unknown[], { has_more: false });
    assert.equal(x.r.coverage.query_exhausted, null);
    assert.ok(x.r.coverage.reasons.includes('SOURCE_REPORTED_INCOMPLETE'));
    assert.ok(!x.r.coverage.reasons.includes('CONTINUATION_QUERY_UNVERIFIED'));
    assert.deepEqual(x.result, { ok: true });
  });
});

for (const tool of ['fhir_search','fhir_page'] as const) {
  for (const reason of ['NON_CONTINUABLE_UPSTREAM_LINK','CONTINUATION_QUERY_UNVERIFIED','SOURCE_REPORTED_INCOMPLETE']) {
    for (const more of [false,null] as const) test(`S56 R11 N05 narrowed ${tool} ${reason} has_more=${more}`,async()=>{
      await withSource({pages:1,perPage:[0],profile:true},async(g,c)=>{
        await g.execute('fhir_search',{resource_type:'Observation',params:[{name:'code',value:'http://loinc.org|4548-4'}]});
        const x=gate(c,tool,c.last(),{tool,deliveredCount:0,reasons:[reason]},[],{has_more:more});
        assert.equal(x.env.coverage.query_exhausted,null);
        assert.deepEqual(x.result,reason==='NON_CONTINUABLE_UPSTREAM_LINK' && more===false ? {ok:false,reason:'INVALID_CROSS_FIELDS'} : {ok:true});
      });
    });
  }
}
