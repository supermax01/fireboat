import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { WARNING_MESSAGES, REFUSAL_MESSAGES } from '../packages/core/src/catalog.js';
import { FhirPrecisionFault } from '../packages/core/src/decimal.js';
import { withGateway, withSdk, lab, output, hba1c, type FixtureOptions, type Rec } from './s57-sdk-helpers.js';

// Independent, literal copy of the agreed vocabulary. Never generated during
// tests; changing the producer table cannot move this equality oracle.
const literals = JSON.parse(readFileSync(new URL('./fixtures/s57-canonical-messages.json', import.meta.url), 'utf8')) as {
  WARNING_MESSAGES: Record<string,string>; REFUSAL_MESSAGES: Record<string,string>;
  MODIFIER_NO_CLINICAL_MESSAGE: string; NO_MATCHES_UNVERIFIED_SUFFIX: string;
};
for (const era of ['modern','legacy'] as const) test(`G-16 ${era} every canonical warning, NO_MATCHES variant and refusal equals its literal over the actual SDK`, async () => {
  const seen = new Set<string>(), refusals = new Set<string>();
  const check = (e: Rec) => {
    for (const warning of e.warnings) {
      assert.ok(Object.hasOwn(literals.WARNING_MESSAGES,warning.code));
      const suffix = warning.code === 'NO_MATCHES' && e.warnings.some((w: Rec) => w.code === 'FILTER_EXECUTION_UNVERIFIED') ? literals.NO_MATCHES_UNVERIFIED_SUFFIX : '';
      assert.equal(warning.message,literals.WARNING_MESSAGES[warning.code] + suffix, `literal ${warning.code}`);
      seen.add(warning.code + (suffix ? ':uncertain' : ''));
    }
  };
  const run = (options: FixtureOptions, tool: 'fhir_search'|'fhir_read', args: Rec) => withGateway(options, g => withSdk(g,era,async sdk => {
    const {e} = await sdk.call(tool,{...args,output:args.output ?? output}); assert.equal(e.error,undefined); check(e);
    if (e.pagination?.next_cursor) { const page = await sdk.call('fhir_page',{cursor:e.pagination.next_cursor,output}); assert.equal(page.e.error,undefined); check(page.e); }
  }));
  await run({pages:[[lab()],[lab('synthetic-page')]]},'fhir_search',{resource_type:'Observation',params:hba1c});
  await run({},'fhir_read',{resource_type:'Observation',id:'synthetic-lab',output:{...output,fields:['valueQuantity','missingSyntheticField']}});
  await run({pages:[[{resourceType:'Organization',id:'synthetic-directory',active:true,name:'Synthetic directory'}]]},'fhir_search',{resource_type:'Organization',output:{...output,format:'compact'}});
  await run({limits:{retentionBytes:256}},'fhir_read',{resource_type:'Observation',id:'synthetic-lab'});
  await run({outcome:{resourceType:'OperationOutcome',issue:[{severity:'information',code:'informational'}]}},'fhir_search',{resource_type:'Observation'});
  await run({outcome:{resourceType:'OperationOutcome',issue:[{severity:'warning',code:'incomplete'}]}},'fhir_search',{resource_type:'Observation'});
  await run({pages:[[lab('synthetic-structural',{modifierExtension:[{url:'http://example.test/modifier',valueBoolean:true}]})]]},'fhir_search',{resource_type:'Observation',output:{...output,format:'compact'}});
  // Supported Node preserves even 1e400. Inject the parser's explicit loss
  // marker after a real HTTP response to exercise the refusal vocabulary.
  await withGateway({},g=>withSdk(g,era,async sdk=>{
    const transport=(g as any).transport, get=transport.get.bind(transport);
    transport.get=async(...args: unknown[])=>{const body=await get(...args); if(body.resourceType==='Bundle') body.entry[0].resource.valueQuantity.value=new FhirPrecisionFault(); return body;};
    const {e}=await sdk.call('fhir_search',{resource_type:'Observation',output}); assert.equal(e.error,undefined); check(e);
  }));
  await run({structured:true},'fhir_read',{resource_type:'Observation',id:'synthetic-lab'});
  await run({corruptor:()=>undefined},'fhir_read',{resource_type:'Observation',id:'synthetic-lab'});
  for (const profile of [false,true]) await run({pages:[[]],profile},'fhir_search',{resource_type:'Observation',params:hba1c});
  await withGateway({},(g,requests)=>withSdk(g,era,async sdk=>{
    const cases: [string, 'fhir_capabilities'|'fhir_read'|'fhir_result', Rec][] = [
      ['invalid_topic','fhir_capabilities',{topic:'canary-invalid-topic'}],
      ['invalid_format','fhir_read',{resource_type:'Observation',id:'synthetic-lab',output:{format:'canary-invalid-format'}}],
      ['invalid_interaction','fhir_read',{resource_type:'Observation',id:'synthetic-lab',interaction:'history'}],
      ['invalid_action','fhir_result',{handle:'res_synthetic_missing',action:'canary-invalid-action'}],
      ['expired_result','fhir_result',{handle:'res_synthetic_missing',action:'inspect'}],
    ];
    for (const [kind,tool,args] of cases) {
      const before=requests.length; const {e}=await sdk.call(tool,args);
      assert.equal(e.error.safe_message,literals.REFUSAL_MESSAGES[kind]); assert.equal(requests.length,before); assert.equal(e.budget.upstream_calls,0);
      refusals.add(kind);
    }
    let before=requests.length;
    const cold=await sdk.call('fhir_search',{resource_type:'Observation',params:[{name:'code:text',value:'synthetic'}],output});
    assert.equal(cold.e.error.safe_message,literals.MODIFIER_NO_CLINICAL_MESSAGE);
    assert.equal(requests.length-before,1); assert.ok(requests.at(-1)!.pathname.endsWith('/metadata')); assert.equal(cold.e.budget.upstream_calls,1);
    before=requests.length;
    const warm=await sdk.call('fhir_search',{resource_type:'Observation',params:[{name:'code:text',value:'synthetic'}],output});
    assert.equal(warm.e.error.safe_message,literals.REFUSAL_MESSAGES.unsupported_modifier); assert.equal(requests.length,before); assert.equal(warm.e.budget.upstream_calls,0);
    refusals.add('unsupported_modifier');
  }));
  await withGateway({},g=>withSdk(g,era,async sdk=>{
    const {e}=await sdk.call('fhir_capabilities',{topic:'support',limit:25,output:{max_bytes:6000}}); assert.equal(e.error,undefined); check(e);
  }));
  assert.deepEqual([...seen].sort(),[...Object.keys(literals.WARNING_MESSAGES),'NO_MATCHES:uncertain'].sort(),'every canonical warning was actually delivered');
  assert.deepEqual([...refusals].sort(),Object.keys(literals.REFUSAL_MESSAGES).sort(),'all six refusal literals were actually delivered');
  assert.deepEqual(WARNING_MESSAGES,literals.WARNING_MESSAGES); assert.deepEqual(REFUSAL_MESSAGES,literals.REFUSAL_MESSAGES);
});
