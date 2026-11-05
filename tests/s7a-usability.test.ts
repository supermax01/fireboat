import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import r4 from '../packages/core/src/generated/r4-index.json' with { type: 'json' };
import { FhirGateway } from '../packages/core/src/index.js';
import { TOOL_NAMES, noMatchesEligible, toolEnvelopeV2Schemas, validateCrossField02, validateDeliverable02, validateListedOutput, type GatewayConfig, type ValidationContext02 } from '../packages/core/src/contracts.js';
import { coverageForSnapshot } from '../packages/core/src/query.js';
import { withGateway, withSdk, lab, patient, type Rec } from './s57-sdk-helpers.js';

const warning = { code: 'METADATA_BYTE_LIMIT', message: 'Metadata rows were reduced to fit the byte budget; follow the returned continuation.' };
const types = Object.entries(r4.definitions).filter(([name, d]) => d.kind === 'resource' && name !== 'DomainResource').map(([name]) => name);
// Independent expected policy intersection, transcribed from the reviewed support manifest.
const executable = new Set(['Patient','Observation','Condition','AllergyIntolerance','MedicationRequest','MedicationStatement','Encounter','DocumentReference','DiagnosticReport','Immunization','Procedure','Coverage','ExplanationOfBenefit','ServiceRequest','Claim','Medication','Organization','Location','Practitioner','CodeSystem','ValueSet']);
const ordered = ['Patient','Observation','DiagnosticReport', ...types.filter(t => executable.has(t) && !['Patient','Observation','DiagnosticReport'].includes(t)).sort(), ...types.filter(t => !executable.has(t)).sort()];
function freeze<T>(v: T): T { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; }
type MetadataOptions = { structured?: boolean; types?: string[]; discovery?: GatewayConfig['discovery']; corruptor?: (e: any, phase: string) => void };
async function metadataFixture<T>(options: MetadataOptions, fn: (g: FhirGateway, c: any, requests: string[], replace: (types: string[]) => void) => Promise<T>) {
  let advertised = options.types ?? [...types].reverse();
  const requests: string[] = [];
  const source = createServer((req, res) => {
    requests.push(req.url!); res.setHeader('content-type', 'application/fhir+json');
    if (req.url !== '/fhir/metadata') { res.statusCode = 404; res.end('{}'); return; }
    res.end(JSON.stringify({ resourceType: 'CapabilityStatement', id: 'foreign-source-id', patient_id: 'foreign-source-id',
      description: 'foreign-source-prose', fhirVersion: '4.0.1', rest: [{ mode: 'server', resource: advertised.map(type => ({ type,
        interaction: [{code:'read'},{code:'search-type'}], searchParam: ['subject','patient','code','date','status'].map(name => ({ name,
          type: ['subject','patient'].includes(name) ? 'reference' : name === 'date' ? 'date' : 'token' })) })) }] }));
  });
  await new Promise<void>(r => source.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${(source.address() as {port:number}).port}/fhir`;
  const registry = { profileId: 's7a-fixture', entries: ['modern','legacy'].map(era => ({ id:'s7a-fixture', version:'1',
    host:{ name:'synthetic',version:'1',client_stack:'synthetic',client_stack_version:'1' }, era, transport:'stdio', workflow:'recent-labs-v1', delivery_profile:'structured-evidence-v1', verification:'fixture_only' })) };
  const g = new FhirGateway({ mode:'synthetic', source:{alias:'s7a',baseUrl}, patientId:patient, contextId:'ctx_s7a', discovery:options.discovery,
    ...(options.structured ? {delivery:{profile:'structured-evidence-v1',hostProfileId:'s7a-fixture'}} : {}) },
  { ...(options.structured ? {testDeliveryRegistryOverride:registry as never} : {}), ...(options.corruptor ? {testEnvelopeCorruptor:options.corruptor as never} : {}) });
  try { return await fn(g, g as any, requests, value => { advertised = value; }); }
  finally { g.close(); source.closeAllConnections(); await new Promise<void>(r => source.close(() => r())); }
}

for (const era of ['modern','legacy'] as const) for (const structured of [false,true]) {
  test(`S7a errors use none through normal and emergency SDK paths ${era}/${structured}`, async () => {
    for (const emergency of [false,true]) await withGateway({structured, ...(emergency ? {corruptor:(e,phase) => { if (phase === 'error') e.coverage.query_evidence = 'metadata_snapshot'; }} : {})}, g => withSdk(g,era,async sdk => {
      for (const tool of TOOL_NAMES) {
        const {e,capture} = await sdk.call(tool, {invalidSyntheticArgument:true});
        assert.equal(e.schema_version,'0.3'); assert.equal(e.error.code,emergency ? 'INTERNAL_ERROR' : 'INVALID_ARGUMENTS');
        assert.equal(e.coverage.query_evidence,'none'); assert.deepEqual(e.data,{}); assert.deepEqual(e.warnings,[]);
        assert.equal(e.coverage.query_exhausted,null); assert.equal(e.provenance,undefined); assert.equal(e.pagination,undefined); assert.equal(e.result,undefined);
        for (const stale of ['metadata_snapshot','unverified_continuation']) {
          const bad = structuredClone(e); bad.coverage.query_evidence = stale;
          assert.equal(validateCrossField02(tool,bad,capture).ok,false,`${tool} error rejects ${stale}`);
        }
      }
      for (const [tool,args,code] of [ ['fhir_read',{resource_type:'Observation',id:'missing'},'NOT_FOUND'],
        ['fhir_result',{handle:'res_absent'},'RESULT_EXPIRED'], ['fhir_page',{cursor:'cur_absent'},'RESULT_EXPIRED'],
        ['fhir_capabilities',{topic:'server',cursor:'cur_absent'},'DISCOVERY_EXPIRED'] ] as const) {
        const {e} = await sdk.call(tool,args); assert.equal(e.error.code,emergency ? 'INTERNAL_ERROR' : code); assert.equal(e.coverage.query_evidence,'none');
      }
    }));
  });

  test(`S7a success never carries none ${era}/${structured}`, async () => {
    await withGateway({structured,pages:[[lab('a')],[lab('b')]]},g=>withSdk(g,era,async sdk=>{
      const search = await sdk.call('fhir_search',{resource_type:'Observation',page_size:1});
      const calls = [await sdk.call('fhir_capabilities',{}),search,await sdk.call('fhir_read',{resource_type:'Observation',id:'a'}),
        await sdk.call('fhir_page',{cursor:search.e.pagination.next_cursor}),await sdk.call('fhir_result',{handle:search.e.result.handle,action:'page'})];
      for (const [i,{e,capture}] of calls.entries()) {
        assert.equal(e.error,undefined); const bad=structuredClone(e); bad.coverage.query_evidence='none';
        assert.equal(validateCrossField02(TOOL_NAMES[i]!,bad,capture).ok,false);
        assert.equal(toolEnvelopeV2Schemas[TOOL_NAMES[i]!].safeParse({...e,schema_version:'0.2'}).success,false);
        assert.equal(validateListedOutput({...e,schema_version:'0.2'}),true);
      }
      const empty = await sdk.call('fhir_search',{resource_type:'Observation',params:[{name:'_id',value:'missing'}]});
      const bad=structuredClone(empty.e); bad.coverage.query_evidence='none'; assert.equal(validateCrossField02('fhir_search',bad,empty.capture).ok,false);
    }));
  });

  test(`S7a inherited size drains local upstream loaded replay without changing count ${era}/${structured}`,async()=>{
    await withGateway({structured,pages:[[lab('a'),lab('b'),lab('c')],[lab('d'),lab('e'),lab('f')]]},(g,requests)=>withSdk(g,era,async sdk=>{
      const transport=(g as any).transport, get=transport.get.bind(transport);
      transport.get=async(...args:unknown[])=>{const body=await get(...args); if(body.resourceType==='Bundle') for(const link of body.link ?? []) if(link.relation==='next') {const url=new URL(link.url);url.searchParams.set('_count','7');link.url=url.href;} return body;};
      const first=await sdk.call('fhir_search',{resource_type:'Observation',page_size:1}); const ids:string[]=[];
      let current=first, fetchedReplay:string|undefined;
      for(let i=0;i<6;i++) {
        assert.equal(current.e.error,undefined); assert.equal(current.e.pagination.requested_page_size,1); assert.equal(current.e.data.resources.length,1);
        ids.push(current.e.data.resources[0].id);
        const bad=structuredClone(current.e); bad.pagination.requested_page_size=100;
        assert.equal(validateCrossField02(i ? 'fhir_page':'fhir_search',bad,current.capture).ok,false,'reported size bound to trusted original');
        assert.equal(validateCrossField02(i ? 'fhir_page':'fhir_search',current.e,freeze({...current.capture,requestedPageSize:undefined})).ok,false);
        if(i<2) assert.equal(requests.filter(u=>!u.pathname.endsWith('/metadata')).length,1,'local rows drain before fetch');
        if(i===2) fetchedReplay=current.e.pagination.next_cursor;
        if(i<5) current=await sdk.call('fhir_page',{cursor:current.e.pagination.next_cursor});
      }
      assert.deepEqual(ids,['a','b','c','d','e','f']);
      const before=requests.length, replay=await sdk.call('fhir_page',{cursor:fetchedReplay});
      assert.equal(replay.e.data.resources[0].id,'d'); assert.equal(replay.e.pagination.requested_page_size,1); assert.equal(requests.length,before);
      assert.equal(replay.e.result.expires_at,current.e.result.expires_at);
      assert.deepEqual(requests.filter(u=>!u.pathname.endsWith('/metadata')).map(u=>u.searchParams.get('_count')),['1','7'],'source continuation URL retains its different count while local deliveries inherit one');
      assert.equal((await sdk.call('fhir_page',{cursor:fetchedReplay,page_size:2})).e.error.code,'INVALID_ARGUMENTS');
      assert.equal(current.e.pagination.has_more,null); assert.equal(current.e.coverage.query_exhausted,null);
      const falseStop=structuredClone(current.e); falseStop.pagination.has_more=false;
      assert.equal(validateCrossField02('fhir_page',falseStop,current.capture).ok,false,'terminal unverified false/null refused');
    }));
  });

  test(`S7a server drains 146 advertised types with priority freshness binding and exact rows ${era}/${structured}`,async()=>{
    assert.equal(types.length,146);
    await metadataFixture({structured},(g,c,requests)=>withSdk(g,era,async sdk=>{
      const first=await sdk.call('fhir_capabilities',{}); assert.equal(first.e.error,undefined); assert.equal(first.e.data.resources.length,20);
      assert.equal(first.e.data.patient_id,patient); assert.equal(first.e.data.resource_count,146);
      assert.deepEqual(first.e.data.resources.slice(0,3).map((r:Rec)=>r.type),['Patient','Observation','DiagnosticReport']);
      const context=await sdk.call('fhir_capabilities',{topic:'context'}); assert.equal(context.e.data.patient_id,first.e.data.patient_id);
      const all:Rec[]=[]; let current=first;
      for(let i=0;i<20;i++) {
        assert.equal(current.e.error,undefined); all.push(...current.e.data.resources);
        assert.equal(current.e.data.snapshot_revision,first.e.data.snapshot_revision); assert.equal(current.e.data.captured_at,first.e.data.captured_at); assert.equal(current.e.data.expires_at,first.e.data.expires_at);
        if(!current.e.data.next_cursor) { assert.equal(current.e.coverage.query_exhausted,true); assert.equal(current.e.coverage.state,'complete_for_query'); break; }
        assert.equal(current.e.coverage.query_exhausted,false); assert.ok(current.e.coverage.reasons.includes('CAPABILITY_SUMMARY_LIMIT'));
        current=await sdk.call('fhir_capabilities',{topic:'server',cursor:current.e.data.next_cursor,limit:20});
      }
      assert.deepEqual(all.map(r=>r.type),ordered); assert.equal(new Set(all.map(r=>r.type)).size,146);
      assert.ok(all.filter(r=>!executable.has(r.type)).every(r=>r.implemented_interactions.length===0));
      const replay=await sdk.call('fhir_capabilities',{topic:'server',cursor:first.e.data.next_cursor});
      assert.deepEqual(replay.e.data.resources,all.slice(20,40)); assert.equal(replay.e.data.expires_at,first.e.data.expires_at); assert.equal(requests.length,1);
      for(const snapshot of [...c.discoveryStore.blobs.values()].map((b:any)=>b.value)) assert.ok(!JSON.stringify(snapshot).includes(patient),'metadata snapshots never retain patient_id');
      for(const state of [[...c.capabilities.values()],g.auditEvents]) assert.ok(!JSON.stringify(state).includes(patient),'binding absent from metadata cache and audit');
      assert.ok(!JSON.stringify(all).includes('foreign-source'));
      const byteRows:string[]=[]; let cursor:string|undefined;
      for(let i=0;i<200;i++) {
        const page=await sdk.call('fhir_capabilities',{topic:'server',...(cursor?{cursor}:{}),limit:50,output:{max_bytes:8192}});
        assert.equal(page.e.error,undefined);byteRows.push(...page.e.data.resources.map((r:Rec)=>r.type));cursor=page.e.data.next_cursor;
        if(!cursor) break;
      }
      assert.deepEqual(byteRows,ordered,'byte-limited pages drain every advertised row exactly once');
      for(const corrupt of [(e:Rec)=>{e.data.resources.shift();},(e:Rec)=>{e.data.resources[1]=e.data.resources[0];},
        (e:Rec)=>{e.data.next_cursor=undefined;e.coverage.state='complete_for_query';e.coverage.query_exhausted=true;e.coverage.reasons=['DECLARED_CAPABILITIES_NOT_PRODUCTION_VERIFICATION'];},
        (e:Rec)=>{e.data.patient_id='foreign-output';},(e:Rec)=>{e.data.captured_at='2020-01-01T00:00:00Z';},(e:Rec)=>{e.data.snapshot_revision='foreign-revision';}]) {
        const bad=structuredClone(first.e); corrupt(bad); assert.equal(validateCrossField02('fhir_capabilities',bad,first.capture).ok,false);
      }
      assert.equal(validateCrossField02('fhir_capabilities',first.e,freeze({...first.capture,metadata:{...first.capture!.metadata!,nextOffset:21}}) as ValidationContext02).ok,false,'cursor stored advancement bound to delivered rows');
      for(const patientId of [undefined,'foreign-binding']) assert.equal(validateDeliverable02('fhir_capabilities',first.e,freeze({...first.capture,patientId})).ok,false);
      assert.equal(validateCrossField02('fhir_capabilities',first.e,freeze({...first.capture,metadata:undefined})).ok,false);
    }));
  });

  test(`S7a metadata warning iff byte shrink with exact advancing controls ${era}/${structured}`,async()=>{
    await metadataFixture({structured},g=>withSdk(g,era,async sdk=>{
      for(const topic of ['server','search_parameter','support','schema']) for(const max_bytes of [4096,24576]) {
        const args={topic,...(['schema','search_parameter'].includes(topic)?{resource_type:topic==='schema'?'Patient':'Observation'}:{}),limit:50,output:{max_bytes}};
        const {e,capture}=await sdk.call('fhir_capabilities',args);
        if(e.error) { assert.equal(e.error.code,'OUTPUT_LIMIT'); assert.deepEqual(e.warnings,[]); continue; }
        const m=capture!.metadata!; assert.ok(m); assert.equal(e.budget.limit_reached,m.byteLimited);
        assert.deepEqual(e.warnings.filter((w:Rec)=>w.code==='METADATA_BYTE_LIMIT'),m.byteLimited?[warning]:[]);
        const rowKey=topic==='server'?'resources':topic==='support'?'rows':topic==='schema'?'elements':'search_parameters';
        assert.equal(e.data[rowKey].length,m.deliveredCount);
        if(m.byteLimited) {
          assert.ok(e.data.next_cursor || e.data.next_offset); const bad=structuredClone(e); bad.warnings=bad.warnings.filter((w:Rec)=>w.code!==warning.code);
          assert.equal(validateCrossField02('fhir_capabilities',bad,capture).ok,false,'byte warning cannot be dropped');
          if(e.data.next_cursor) {
            const next=await sdk.call('fhir_capabilities',{topic,cursor:e.data.next_cursor,limit:1,output:{max_bytes:24576}});
            assert.deepEqual(next.e.data[rowKey][0],m.rows[m.start+m.deliveredCount],'byte fitting never skips a row');
          }
        } else {
          const bad=structuredClone(e); bad.warnings.push(warning); bad.budget.limit_reached=true;
          assert.equal(validateCrossField02('fhir_capabilities',bad,capture).ok,false,'natural/caller-limited pages cannot assert byte warning');
        }
        const bad=structuredClone(e); bad.budget.limit_reached=!m.byteLimited;
        assert.equal(validateCrossField02('fhir_capabilities',bad,capture).ok,false,'byte flag bound to trusted packer outcome');
      }
      for(const topic of ['server','support','search_parameter','schema']) {
        const {e}=await sdk.call('fhir_capabilities',{topic,...(['search_parameter','schema'].includes(topic)?{resource_type:'Patient'}:{}),limit:1});
        assert.equal(e.error,undefined); assert.ok(!e.warnings.some((w:Rec)=>w.code===warning.code)); assert.equal(e.budget.limit_reached,false);
      }
    }));
  });
}

test('S7a server cursor rejects binding topic revision store expiry and selector changes',async()=>{
  await metadataFixture({},async(g,c,requests,replace)=>{
    await g.execute('fhir_capabilities',{topic:'context'});
    c.metadataExpiresAt=Date.now()+60000; // A partly aged source snapshot: allocation must not renew it.
    const first=await g.execute('fhir_capabilities',{limit:1}), cursor=(first.data as Rec).next_cursor;
    assert.ok(cursor); const before=requests.length;
    for(const [tool,args,code] of [ ['fhir_capabilities',{topic:'support',cursor},'DISCOVERY_EXPIRED'],
      ['fhir_capabilities',{topic:'server',cursor,context_handle:'forged'},'DISCOVERY_EXPIRED'],
      ['fhir_page',{cursor},'RESULT_EXPIRED'], ['fhir_result',{handle:cursor},'RESULT_EXPIRED'],
      ['fhir_capabilities',{topic:'server',cursor,resource_type:'Patient'},'INVALID_ARGUMENTS'] ] as const) {
      assert.equal((await g.execute(tool,args)).error?.code,code);
    }
    assert.equal(requests.length,before);
    const original=c.discoveryStore.get(cursor), publishedExpiry=(first.data as Rec).expires_at, saved=c.discoveryBindingV2.bind(c);
    assert.equal(original.expires_at,publishedExpiry,'stored server cursor preserves the published absolute snapshot expiry');
    for(const field of ['sourceAlias','contextHandle','policyRevision','sourceRevision','authEpoch']) {
      c.discoveryBindingV2=()=>({...saved(),[field]:field==='authEpoch'?999:'foreign'});
      assert.equal((await g.execute('fhir_capabilities',{topic:'server',cursor})).error?.code,'DISCOVERY_EXPIRED',field);
    }
    c.discoveryBindingV2=saved;
    const now=c.discoveryStore.now; try { c.discoveryStore.now=()=>Date.parse(publishedExpiry); assert.equal((await g.execute('fhir_capabilities',{topic:'server',cursor})).error?.code,'DISCOVERY_EXPIRED'); }
    finally { c.discoveryStore.now=now; }
    assert.equal(requests.length,before,'expired snapshot never refreshes');
    const fresh=await g.execute('fhir_capabilities',{limit:1}); const old=(fresh.data as Rec).next_cursor;
    replace(['Patient','Observation']); c.metadataExpiresAt=0;
    assert.equal((await g.execute('fhir_capabilities',{})).error,undefined);
    assert.equal((await g.execute('fhir_capabilities',{topic:'server',cursor:old})).error?.code,'DISCOVERY_EXPIRED');
  });
});

test('S7a server never invents absent required types and retains no failed cursor reservation',async()=>{
  await metadataFixture({types:['Account','Organization']},async(g)=>{
    const e=await g.execute('fhir_capabilities',{}); assert.equal(e.error,undefined);
    assert.deepEqual((e.data as Rec).resources.map((r:Rec)=>r.type),['Organization','Account']);
  });
  let corrupt = false;
  await metadataFixture({discovery:{maxHandles:1},corruptor:(e,phase)=>{if(corrupt && phase==='success') e.data.patient_id='foreign';}},async(g,c)=>{
    const first=await g.execute('fhir_capabilities',{limit:1}), handle=(first.data as Rec).next_cursor;
    const before=c.discoveryStore.usedBytes(); corrupt=true;
    const e=await g.execute('fhir_capabilities',{limit:1}); assert.equal(e.error?.code,'INTERNAL_ERROR');
    assert.equal(c.discoveryStore.usedBytes(),before); assert.equal(c.discoveryStore.size,1);
    assert.ok(c.discoveryStore.get(handle),'a failed reservation restores prior evictions');
    corrupt=false; assert.equal((await g.execute('fhir_capabilities',{topic:'server',cursor:handle,limit:1})).error,undefined);
  });
  await metadataFixture({discovery:{snapshotBytes:4096}},async(g)=>{
    const e=await g.execute('fhir_capabilities',{limit:1}); assert.equal(e.error?.code,'RETENTION_LIMIT'); assert.deepEqual(e.data,{});
  });
});

test('S7a none cannot become successful query-helper evidence or NO_MATCHES',()=>{
  assert.equal(noMatchesEligible({query_evidence:'none',query_exhausted:true,reasons:[]},0,true),false);
  assert.throws(()=>coverageForSnapshot({constraints:[],materialFilterProved:true,evidenceKind:'none'} as never,{} as never));
});


test('S7a byte warning is included in every shrunken fit and bound to eligible rows',async()=>{
  await metadataFixture({},async(g,c)=>{
    const bytes=c.bytesV2.bind(c); let shrunkMeasurements=0;
    c.bytesV2=(e:Rec,d:unknown)=>{
      if(e.budget.limit_reached && !e.error && Object.keys(e.data).length) {
        shrunkMeasurements++; assert.ok(e.warnings.some((w:Rec)=>w.code===warning.code),'warning reserved during fitting');
      }
      return bytes(e,d);
    };
    await withSdk(g,'modern',async sdk=>{
      const {e,capture}=await sdk.call('fhir_capabilities',{topic:'server',limit:50,output:{max_bytes:4096}});
      assert.equal(e.error,undefined); assert.ok(shrunkMeasurements>0); assert.ok(capture!.metadata!.byteLimited);
      const bad=structuredClone(e); bad.warnings=bad.warnings.filter((w:Rec)=>w.code!==warning.code); bad.budget.limit_reached=false;
      const forged=freeze({...capture,metadata:{...capture!.metadata!,byteLimited:false}}) as ValidationContext02;
      assert.equal(validateCrossField02('fhir_capabilities',bad,forged).ok,false,'trusted byte flag must also agree with eligible-row reduction');
      const wrong=structuredClone(e); wrong.warnings[0].message='foreign-warning'; assert.equal(validateCrossField02('fhir_capabilities',wrong,capture).ok,false);
    });
  });
});

test('S7a invalid original count refuses and empty success rejects none',async()=>{
  await withGateway({pages:[[]]},g=>withSdk(g,'modern',async sdk=>{
    const {e,capture}=await sdk.call('fhir_search',{resource_type:'Observation',page_size:1}); assert.equal(e.data.resources.length,0); assert.equal(e.error,undefined);
    const bad=structuredClone(e);bad.coverage.query_evidence='none';assert.equal(validateCrossField02('fhir_search',bad,capture).ok,false);
    const c=g as any;
    for(const query of [[],[{name:'_count',value:'0'}],[{name:'_count',value:'101'}],[{name:'_count',value:'1.0'}]]) assert.throws(()=>c.requestedPageSizeV2({query}),(fault:any)=>fault.code==='UNVERIFIED_CONTINUATION');
  }));
});
