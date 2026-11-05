import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { TASKS, USABILITY_TASKS, canonicalJson, exitCodeForReport, parseM3bTaskFile, runEvals } from '../packages/evals/src/index.js';
import { collectEvidence, evaluateCheck, responseInvariants } from '../packages/evals/src/runner.js';
import type { GatewayEnvelope } from '../packages/core/src/index.js';

// S5 review fix (evals review, finding 4): the whole M3b task corpus is content-pinned, not just the five
// pending tasks, so that loosening or deleting any expectation is a deliberate, visible pin update.
const CORPUS_PINS = {
  // S6: query-date-instant searches the instant record's own code, query-cross-page-sort binds q1 to every page, and
  // query-ignore-sort-proven, query-cross-page-sort-generic and query-empty-page-with-next-proven were added (28 tasks, 43 checks).
  'packages/evals/data/m3b-query-tasks.json': { tasks: 28, checks: 43, sha256: 'ce7c9440fac53024ae0cb8454406e014fc6e12216f334ad05faae837a66252ee' },
  // S7a auxiliary usability tasks; the qualified query corpus and primary identities are unchanged.
  'packages/evals/data/s7a-usability-tasks.json': { tasks: 6, checks: 31, sha256: '61d56336a75b39386becc925e750d40dcc405b003de698718e5897ea9295f93b' },
  'packages/evals/data/m3b-projection-tasks.json': { tasks: 5, checks: 29, sha256: '89c0d901f4ca5cafc573714093343491b55671d8418aa3e48ca0f34ebd65067f' },
} as const;

test('M3b task corpus content is pinned; an expectation change must update the pin deliberately', () => {
  for (const [file, pin] of Object.entries(CORPUS_PINS)) {
    const tasks = parseM3bTaskFile(readFileSync(join(process.cwd(), file), 'utf8'));
    const sha256 = createHash('sha256').update(canonicalJson(tasks)).digest('hex');
    assert.equal(tasks.length, pin.tasks, `${file}: task count`);
    assert.equal(tasks.reduce((sum, task) => sum + task.checks.length, 0), pin.checks, `${file}: check count`);
    assert.equal(sha256, pin.sha256, `${file}: corpus content changed; if intended, record why in the commit and update CORPUS_PINS`);
  }
});

const envelope = (extra: Record<string, unknown>): GatewayEnvelope => ({ data: {}, transform: { withheld_payloads: [], omitted_fields: [] }, warnings: [], ...extra } as unknown as GatewayEnvelope);

test('envelopePath and dataPath with equals null require the path to be present (absent is not null)', () => {
  const nullCheck = { kind: 'envelopePath', id: 'has-more-null', path: 'pagination.has_more', equals: null } as const;
  assert.equal(evaluateCheck(nullCheck, 'fhir', collectEvidence([envelope({ pagination: { has_more: null } })])).status, 'pass');
  assert.equal(evaluateCheck(nullCheck, 'fhir', collectEvidence([envelope({ pagination: {} })])).status, 'fail', 'absent has_more must not satisfy equals null');
  assert.equal(evaluateCheck(nullCheck, 'fhir', collectEvidence([envelope({})])).status, 'fail', 'absent pagination must not satisfy equals null');
  const dataCheck = { kind: 'dataPath', id: 'total-null', path: 'total', equals: null } as const;
  assert.equal(evaluateCheck(dataCheck, 'fhir', collectEvidence([envelope({ data: { total: null } })])).status, 'pass');
  assert.equal(evaluateCheck(dataCheck, 'fhir', collectEvidence([envelope({ data: {} })])).status, 'fail');
});

test('upstreamWork checks use fixture-counted work for the bound step, independent of budget.upstream_calls', () => {
  const check = { kind: 'upstreamWork', id: 'no-clinical', clinical: 0 } as const;
  const env = envelope({ budget: { upstream_calls: 1 } });
  assert.equal(evaluateCheck(check, 'fhir', collectEvidence([env], [], { work: [{ metadata: 1, auth: 0, clinical: 0 }] })).status, 'pass');
  const leaked = evaluateCheck(check, 'fhir', collectEvidence([env], [], { work: [{ metadata: 0, auth: 0, clinical: 1 }] }));
  assert.equal(leaked.status, 'fail');
  assert.equal(leaked.cause, 'upstream_work_mismatch');
  const unknown = evaluateCheck(check, 'fhir', collectEvidence([env]));
  assert.equal(unknown.status, 'fail');
  assert.equal(unknown.cause, 'harness_error', 'missing work counts never pass vacuously');
  const metadata = { kind: 'upstreamWork', id: 'one-metadata', metadata: 1 } as const;
  assert.equal(evaluateCheck(metadata, 'fhir', collectEvidence([env], [], { work: [{ metadata: 2, auth: 0, clinical: 0 }] })).status, 'fail');
});

test('independent byte accounting gates the exit code', async () => {
  const report = await runEvals({ tasks: [TASKS[0]!], arms: ['fhir'] });
  assert.equal(exitCodeForReport(report), 0);
  assert.deepEqual([report.summary.byte_accounting.under_reported_calls, report.summary.byte_accounting.over_reported_calls], [0, 0]);
  const under = structuredClone(report); under.summary.byte_accounting.under_reported_calls = 1;
  assert.equal(exitCodeForReport(under), 1, 'a gateway that under-reports its final bytes fails the run');
  const over = structuredClone(report); over.summary.byte_accounting.over_reported_calls = 1;
  assert.equal(exitCodeForReport(over), 1, 'a gateway that over-reports its final bytes fails the run');
});


test('S7a discovery placeholders reject missing and forward response references',()=>{
  const task={id:'s7a-reference',category:'usability',question:'Metadata continuation.',steps:[{tool:'fhir_capabilities',input:{topic:'server',cursor:'{{discovery_cursor:0}}'}}],checks:[],budget:{maxBytes:10000,maxToolCalls:2,maxUpstreamCalls:1}};
  assert.throws(()=>parseM3bTaskFile(JSON.stringify({schema_version:'m3b-tasks/1',tasks:[task]})),/forward or missing/);
  task.steps.unshift({tool:'fhir_capabilities',input:{topic:'server'} as any});
  assert.equal(parseM3bTaskFile(JSON.stringify({schema_version:'m3b-tasks/1',tasks:[task]})).length,1);
});

test('S7a independent error evidence oracle runs before the error return',()=>{
  const base={schema_version:'0.3',request_id:'test',source:{alias:'eval-fixture',fhir_version:'4.0.1',capability_revision:'x'},context:{handle:'ctx_test',mode:'patient-bound',policy_revision:'x'},data:{},
    coverage:{state:'unknown',scope:'query',reasons:['CLINICAL_RECORD_COMPLETENESS_UNKNOWN','INVALID_ARGUMENTS'],authorization_limited:true,query_exhausted:null,pages_observed:0,query_evidence:'none'},
    transform:{format:'fhir',projected:false,withheld_payloads:[],omitted_fields:[],unresolved_fields:[],narrative_omitted:false,recipe_ids:[],structural_resource_indices:[],delivery_profile:'full-text-v1'},warnings:[],
    budget:{bytes_returned:2000,byte_limit:4096,limit_reached:false,upstream_calls:0,elapsed_ms:0},error:{code:'INVALID_ARGUMENTS',safe_message:'Invalid arguments.',retryable:false}};
  const record={tool:'fhir_read',step:0,envelope:base,metrics:{wire_result_bytes:2000,requested_max_bytes:4096}};
  assert.deepEqual(responseInvariants(record as never),[]);
  for(const query_evidence of ['metadata_snapshot','unverified_continuation']) assert.ok(responseInvariants({...record,envelope:{...base,coverage:{...base.coverage,query_evidence}}} as never).some(f=>f.cause==='coverage_invalid'));
});

test('S7a auxiliary tasks do not alter primary or external qualification task identities',()=>{
  assert.equal(USABILITY_TASKS.length,6); assert.ok(USABILITY_TASKS.every(t=>t.corpus==='usability'));
  assert.equal(TASKS.length,77); assert.ok(TASKS.every(t=>t.corpus!=='usability'));
});
