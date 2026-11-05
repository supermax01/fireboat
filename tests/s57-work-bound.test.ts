import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { FhirGateway } from '../packages/core/src/index.js';
import { withGateway, withSdk, output, lab } from './s57-sdk-helpers.js';

for (const era of ['modern','legacy'] as const) test(`S57b ${era} gateway stops the twenty-first actual upstream attempt and resets per call`, async () => {
  await withGateway({},(g,requests)=>withSdk(g,era,async sdk=>{
    const transport = (g as any).transport, get = transport.get.bind(transport);
    // Diagnostic repeated-attempt driver: each iteration is the real HTTP
    // transport. The gateway must stop the socket edge, not merely detect an
    // overrun from a client-reported count after twenty-one requests.
    transport.get = async (url: URL, stats: {calls:number}, budget: unknown) => {
      let result;
      for (let i=0; i<(url.pathname.endsWith('/metadata') ? 1 : 21); i++) result = await get(url,stats,budget);
      return result;
    };
    const {e} = await sdk.call('fhir_read',{resource_type:'Observation',id:'synthetic-lab',output});
    assert.equal(e.error?.code,'NOT_FOUND'); assert.equal(requests.length,20); assert.equal(e.budget.upstream_calls,20);
    assert.equal(requests.filter(u=>u.pathname.endsWith('/metadata')).length,1);
    assert.deepEqual(e.data,{}); assert.equal(e.result,undefined);
    transport.get = get;
    const next = await sdk.call('fhir_read',{resource_type:'Observation',id:'synthetic-lab',output});
    assert.equal(next.e.error,undefined); assert.equal(next.e.budget.upstream_calls,1); assert.equal(requests.length,21);
  }));
});

for (const era of ['modern','legacy'] as const) test(`S57b ${era} the same twenty-request gateway meter includes real token refresh work`, async () => {
  const counts = {auth:0,metadata:0,clinical:0};
  const source=createServer((req,res)=>{
    res.setHeader('content-type','application/json');
    if (req.url==='/token') { counts.auth++; req.resume(); res.end(JSON.stringify({access_token:'offline-synthetic-token',token_type:'Bearer',expires_in:3600})); return; }
    if (req.url==='/fhir/metadata') { counts.metadata++; res.end(JSON.stringify({resourceType:'CapabilityStatement',fhirVersion:'4.0.1',rest:[{mode:'server',resource:[{type:'Observation',interaction:[{code:'read'}],searchParam:[{name:'subject',type:'reference'}]}]}]})); return; }
    counts.clinical++; res.end(JSON.stringify(lab()));
  });
  await new Promise<void>(r=>source.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${(source.address() as {port:number}).port}`;
  const previous=process.env.S57B_SYNTHETIC_SECRET; process.env.S57B_SYNTHETIC_SECRET='offline-synthetic-secret';
  const g=new FhirGateway({mode:'synthetic',source:{alias:'s57b',baseUrl:`${base}/fhir`,auth:{type:'client_credentials',tokenUrl:`${base}/token`,clientId:'offline-synthetic',clientSecretEnv:'S57B_SYNTHETIC_SECRET'}},patientId:'synthetic-a',contextId:'ctx_s57b'});
  try { await withSdk(g,era,async sdk=>{
    const transport=(g as any).transport, credentials=(g as any).credentials, get=transport.get.bind(transport);
    transport.get=async(url:URL,stats:{calls:number},budget:unknown)=>{
      if (url.pathname.endsWith('/metadata')) return get(url,stats,budget);
      let result;
      for(let i=0;i<21;i++) { credentials.invalidate(); result=await get(url,stats,budget); }
      return result;
    };
    const {e}=await sdk.call('fhir_read',{resource_type:'Observation',id:'synthetic-lab',output});
    assert.equal(e.error?.code,'NOT_FOUND'); assert.equal(counts.auth+counts.metadata+counts.clinical,20);
    assert.equal(counts.auth,10); assert.equal(counts.metadata,1); assert.equal(counts.clinical,9);
    assert.equal(e.budget.upstream_calls,20); assert.equal(e.result,undefined);
  }); } finally { g.close(); if(previous===undefined) delete process.env.S57B_SYNTHETIC_SECRET; else process.env.S57B_SYNTHETIC_SECRET=previous;
    source.closeAllConnections(); await new Promise<void>(r=>source.close(()=>r())); }
});
