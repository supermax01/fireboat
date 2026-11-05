import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { stripTypeScriptTypes } from 'node:module';
import type { GatewayEnvelope } from '../packages/core/src/index.js';
import type { Check } from '../packages/evals/src/check-contracts.js';
import { boundStep, collectEvidence, evaluateCheck, evaluateStepCheck, rawMember, type OracleCall } from '../packages/evals/src/evidence-oracle.js';
import * as kernel from '../packages/evals/src/evidence-oracle.js';
import * as runner from '../packages/evals/src/runner.js';
import { DYNAMIC } from '../scripts/quickstart/check-helper-boundary.js';
import { observedGraph } from '../scripts/quickstart/module-graph.js';

type Rec = Record<string, unknown>;
const P = 'Patient/qs-natural';
/** A corrected HbA1c shaped like the quickstart edge: trailing-zero value, unit, comparator, status and date. */
const hba1c = (id: string, extra: Rec = {}): Rec => ({ resourceType: 'Observation', id, meta: { versionId: '1' }, status: 'corrected',
  code: { coding: [{ system: 'http://loinc.org', code: '4548-4' }] }, subject: { reference: P }, effectiveDateTime: '2025-11-03T08:30:00Z',
  valueQuantity: { value: 7, comparator: '<', unit: '%' }, ...extra });
/** A gateway envelope delivering `resources`, with provenance for each index unless `provenance` overrides it (indexes or whole entries). */
const envelope = (resources: Rec[], provenance: (number | Rec)[] = resources.map((_, i) => i), extra: Rec = {}): GatewayEnvelope => ({
  schema_version: '0.3', request_id: 'r', source: { alias: 'qs-hapi', fhir_version: '4.0.1', capability_revision: 'x' },
  context: { handle: 'ctx', mode: 'patient-bound', policy_revision: 'synthetic-v1' }, data: { resources },
  provenance: provenance.map(p => typeof p === 'number' ? { resource_index: p, retrieved_at: '2025-11-04T00:00:00Z' } : p),
  coverage: { state: 'unknown', scope: 'page', reasons: [] }, transform: { format: 'fhir', projected: false, withheld_payloads: [] }, warnings: [],
  budget: { bytes_returned: 10, byte_limit: 24576, limit_reached: false, upstream_calls: 1, elapsed_ms: 1 }, ...extra,
}) as unknown as GatewayEnvelope;
/** The server's raw result text, with numbers spelled exactly as given (`@7.00@` becomes the token 7.00). */
const raw = (resources: Rec[]) => JSON.stringify({ structuredContent: { data: { resources } } }).replace(/"@([-0-9.eE+]+)@"/g, '$1');
const call = (step: number, resources: Rec[], extra: Partial<OracleCall> = {}): OracleCall => ({ step, envelope: envelope(resources), rawText: raw(resources), work: { metadata: 0, auth: 0, clinical: 1 }, ...extra });
const run = (check: Check, calls: OracleCall[], stepCount = 2) => evaluateStepCheck(check, 'fhir', calls, { stepCount, requests: [] });
const fact = (path: string, equals: unknown, extra: Partial<Check> = {}): Check => ({ kind: 'fact', id: `f-${path}`, step: 1, resource: 'qs-edge-hba1c-corrected', path, equals, ...extra } as Check);

test('package oracle kernel: alone in an empty directory, the emitted kernel loads and its imports are node:crypto and the vocabulary only', () => {
  // Emit both modules with type-only imports erased (as the build's verbatimModuleSyntax does), then load them in a fresh process with nothing
  // else beside them: any runtime import, re-export or side-effect import of another module fails to resolve.
  const dir = mkdtempSync(join(tmpdir(), 'package-oracle-'));
  try {
    const emitted = (file: string) => stripTypeScriptTypes(readFileSync(new URL(`../packages/evals/src/${file}.ts`, import.meta.url), 'utf8'));
    const kernelCode = emitted('evidence-oracle'), vocabularyCode = emitted('check-contracts');
    writeFileSync(join(dir, 'evidence-oracle.mjs'), kernelCode.replaceAll("'./check-contracts.js'", "'./check-contracts.mjs'"));
    writeFileSync(join(dir, 'check-contracts.mjs'), vocabularyCode);
    // Every import and re-export as Node resolves it (whatever comments or spellings hide it from a text scan); any latent dynamic or computed load refuses.
    const graph = observedGraph(dir, ['evidence-oracle.mjs']);
    assert.deepEqual([...new Set(graph.imports.get('evidence-oracle.mjs'))].sort(), ['./check-contracts.mjs', 'node:crypto']);
    assert.equal(graph.imports.get('check-contracts.mjs'), undefined); assert.ok(graph.loaded.has('check-contracts.mjs'));
    assert.ok(!DYNAMIC.test(kernelCode) && !DYNAMIC.test(vocabularyCode), 'no dynamic or computed module load');
    const out = execFileSync(process.execPath, ['--input-type=module', '-e',
      "const k = await import('./evidence-oracle.mjs'); process.stdout.write(String(k.boundStep({ kind: 'fact', id: 'x', step: 1 }, 2)) + ' ' + typeof k.evaluateStepCheck);"],
      { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
    assert.equal(out, '1 function');
  } finally { rmSync(dir, { recursive: true, force: true }); }
  for (const name of ['collectEvidence', 'evaluateCheck', 'evaluateBoundCheck', 'resolvePath', 'resolveQueryChain', 'boundStep', 'evaluateStepCheck'] as const)
    assert.equal(runner[name], kernel[name], `the runner re-exports the kernel's ${name}`);
});

test('package oracle: a check binds to its own step; another step\'s identical response never satisfies it', () => {
  assert.equal(boundStep({ kind: 'totalWithheldWhileMore', id: 'x' }, 1), 0, 'single-step tasks bind implicitly');
  assert.equal(boundStep({ kind: 'totalWithheldWhileMore', id: 'x' }, 2), undefined, 'multi-step tasks need an explicit step');
  for (const step of [2, -1, 0.5]) assert.equal(boundStep({ kind: 'totalWithheldWhileMore', id: 'x', step }, 2), undefined, String(step));
  assert.equal(boundStep({ kind: 'totalWithheldWhileMore', id: 'x', step: 1 }, 2), 1);
  const earlier = [call(0, [hba1c('qs-edge-hba1c-corrected')]), call(1, [])];
  assert.equal(run(fact('status', 'corrected'), earlier).status, 'fail', 'a fact read at step 0 cannot answer step 1');
  assert.equal(run(fact('status', 'corrected', { step: 0 }), earlier).status, 'pass');
  assert.deepEqual(run(fact('status', 'corrected'), earlier), { check_id: 'f-status', kind: 'fact', step: 1, status: 'fail', cause: 'expected_fact_missing', detail: 'resource qs-edge-hba1c-corrected not returned by the bound response' });
  const outcome: OracleCall = { step: 0, outcome: { class: 'application_error', code: 'NOT_FOUND' } };
  const notFound: Check = { kind: 'callOutcome', id: 'nf', step: 1, outcome: 'application_error', code: 'NOT_FOUND' };
  assert.equal(run(notFound, [outcome, call(1, [])]).status, 'fail', 'an outcome recorded at step 0 is not step 1\'s');
  assert.equal(run({ ...notFound, step: 0 }, [outcome, call(1, [])]).status, 'pass');
  const work: Check = { kind: 'upstreamWork', id: 'w', step: 1, clinical: 0 };
  assert.equal(run(work, [call(0, []), call(1, [], { work: { metadata: 1, auth: 0, clinical: 0 } })]).status, 'pass');
  assert.equal(run(work, [call(0, []), call(1, [], { work: undefined })]).status, 'fail', 'unknown work never passes as zero');
});

test('package oracle: response index, provenance and version bind the fact to one delivered occurrence', () => {
  const two = [call(1, [hba1c('qs-edge-hba1c-corrected')]), call(1, [hba1c('qs-edge-hba1c-corrected', { status: 'final' })])];
  const status = (equals: string, response_index?: number | 'all') => run({ ...fact('status', equals), kind: 'fact', ...(response_index !== undefined ? { response_index } : {}) } as Check, two).status;
  assert.equal(status('corrected'), 'pass', 'legacy kinds read every response of the step');
  assert.equal(status('final', 1), 'pass');
  assert.equal(status('corrected', 1), 'fail', 'response 1 cannot borrow response 0\'s value');
  assert.equal(status('corrected', 'all'), 'fail', "'all' needs the fact in every response");
  const versioned = fact('status', 'corrected', { version: '2' } as Partial<Check>);
  assert.equal(run(versioned, [call(1, [hba1c('qs-edge-hba1c-corrected')])]).cause, 'version_mismatch');
  assert.equal(run(versioned, [call(1, [hba1c('qs-edge-hba1c-corrected', { meta: { versionId: '2' } })])]).status, 'pass');
  const unprovenanced = { ...call(1, []), envelope: envelope([hba1c('qs-edge-hba1c-corrected', { meta: { versionId: '2' } })], []) };
  assert.equal(run(versioned, [unprovenanced]).cause, 'version_mismatch', 'a version without provenance for its own index is not a cited version');
  const citation = (version: string | null): Check => ({ kind: 'citationTuple', id: 'c', step: 1, resource_type: 'Observation', id_value: 'qs-edge-hba1c-corrected', source: 'qs-hapi', version });
  assert.equal(run(citation('1'), [call(1, [hba1c('qs-edge-hba1c-corrected')])]).status, 'pass');
  assert.equal(run(citation('2'), [call(1, [hba1c('qs-edge-hba1c-corrected')])]).status, 'fail', 'wrong version');
  assert.equal(run(citation(null), [call(1, [hba1c('qs-edge-hba1c-corrected')])]).status, 'fail', 'a null version requires no versionId');
  assert.equal(run({ ...citation('1'), source: 'other' } as Check, [call(1, [hba1c('qs-edge-hba1c-corrected')])]).status, 'fail', 'wrong source');
  const shifted = { ...call(1, []), envelope: envelope([hba1c('qs-edge-other'), hba1c('qs-edge-hba1c-corrected')], [0]) };
  assert.equal(run(citation('1'), [shifted]).status, 'fail', 'provenance for another index does not cite this resource');
  assert.equal(run({ kind: 'resourceIdSet', id: 's', step: 1, equals: ['qs-edge-hba1c-corrected'] }, two).status, 'fail', 'a duplicated identity is not a set');
});

test('package oracle: raw lexemes, comparator, unit, status and date losses are distinguished', () => {
  const lexeme = (equals: string): Check => ({ kind: 'decimalLexeme', id: 'd', step: 1, resource_type: 'Observation', id_value: 'qs-edge-hba1c-corrected', path: 'valueQuantity.value', equals });
  const delivered = (value: string, id = 'qs-edge-hba1c-corrected') => { const r = [hba1c(id, { valueQuantity: { value: `@${value}@`, comparator: '<', unit: '%' } })]; return [{ ...call(1, []), envelope: envelope([hba1c(id)]), rawText: raw(r) }]; };
  assert.equal(run(lexeme('7.00'), delivered('7.00')).status, 'pass');
  for (const rounded of ['7.0', '7', '7.000', '0.700E1']) assert.equal(run(lexeme('7.00'), delivered(rounded)).status, 'fail', rounded);
  assert.equal(run(lexeme('7.00'), delivered('7.00', 'qs-edge-other')).status, 'fail', 'another resource\'s lexeme');
  assert.equal(run(lexeme('7.00'), [{ ...delivered('7.00')[0]!, rawText: undefined }]).status, 'fail', 'decoded numbers alone never pass');
  assert.equal(run(lexeme('7.00'), [call(0, []), ...delivered('7.00').map(c => ({ ...c, step: 0 }))]).status, 'fail', 'raw text of another step');
  for (const [path, equals, lost] of [['valueQuantity.comparator', '<', { valueQuantity: { value: 7, unit: '%' } }], ['valueQuantity.unit', '%', { valueQuantity: { value: 7, comparator: '<' } }],
    ['status', 'corrected', { status: undefined }], ['effectiveDateTime', '2025-11-03T08:30:00Z', { effectiveDateTime: undefined }]] as const) {
    assert.equal(run(fact(path, equals), [call(1, [hba1c('qs-edge-hba1c-corrected')])]).status, 'pass', path);
    assert.equal(run(fact(path, equals), [call(1, [hba1c('qs-edge-hba1c-corrected', lost)])]).cause, 'expected_fact_missing', `${path} lost`);
  }
  assert.equal(run(fact('status', 'corrected'), [call(1, [hba1c('qs-edge-hba1c-corrected', { status: 'entered-in-error' })])]).cause, 'expected_fact_mismatch');
  assert.equal(run(fact('effectiveDateTime', '2025-11-03T08:30:00Z'), [call(1, [hba1c('qs-edge-hba1c-corrected', { effectiveDateTime: '2025-11-03' })])]).cause, 'expected_fact_mismatch', 'a truncated date');
});

test('package oracle: provenance must cite one valid, distinct, in-range index for a citation or a version to count', () => {
  const versioned = fact('status', 'corrected', { version: '1' } as Partial<Check>);
  const citation: Check = { kind: 'citationTuple', id: 'c', step: 1, resource_type: 'Observation', id_value: 'qs-edge-hba1c-corrected', source: 'qs-hapi', version: '1' };
  const with_ = (provenance: (number | Rec)[]) => [{ ...call(1, []), envelope: envelope([hba1c('qs-edge-hba1c-corrected')], provenance) }];
  assert.equal(run(citation, with_([0])).status, 'pass');
  for (const provenance of [[0, 0], [0, 1], [-1], [{ resource_index: 0, retrieved_at: 'yesterday' }], [{ resource_index: 0, retrieved_at: '2025-13-40T00:00:00Z' }], [{ resource_index: 0 }], [{ resource_index: '0', retrieved_at: '2025-11-04T00:00:00Z' }]] as (number | Rec)[][]) {
    assert.equal(run(citation, with_(provenance)).status, 'fail', JSON.stringify(provenance));
    assert.equal(run(versioned, with_(provenance)).cause, 'version_mismatch', JSON.stringify(provenance));
  }
});

test('package oracle: a bare-id fact never resolves across resource types, and lexemes are numeric tokens of the right typed resource', () => {
  const split = [call(1, [hba1c('synthetic-lab', { status: 'final', meta: { versionId: '2' } }), { resourceType: 'Condition', id: 'synthetic-lab', meta: { versionId: '2' }, status: 'corrected' }])];
  assert.equal(run({ kind: 'fact', id: 'f', step: 1, resource: 'synthetic-lab', path: 'status', equals: 'corrected' }, split).cause, 'resource_id_mismatch');
  assert.equal(run({ kind: 'citationTuple', id: 'c', step: 1, resource_type: 'Condition', id_value: 'synthetic-lab', source: 'qs-hapi', version: '2' }, split).status, 'pass');
  assert.equal(run({ kind: 'citationTuple', id: 'c', step: 1, resource_type: 'Patient', id_value: 'synthetic-lab', source: 'qs-hapi', version: '2' }, split).status, 'fail', 'a citation needs the cited type');
  const lexeme = (equals: string, resource_type = 'Observation'): Check => ({ kind: 'decimalLexeme', id: 'd', step: 1, resource_type, id_value: 'synthetic-lab', path: 'valueQuantity.value', equals });
  const two = [hba1c('synthetic-lab', { meta: { versionId: '2' }, valueQuantity: { value: 8, unit: '%' } }), hba1c('synthetic-lab', { valueQuantity: { value: '@7.00@', unit: '%' } })];
  const versions = [{ ...call(1, []), envelope: envelope(two), rawText: raw(two) }];
  assert.equal(run(lexeme('7.00'), versions).status, 'pass', 'decimalLexeme is the legacy aggregate predicate: any delivered occurrence may supply it');
  const one = [hba1c('synthetic-lab', { valueQuantity: { value: '@7.00@', unit: '%' } })];
  assert.equal(run(lexeme('7.00'), [{ ...call(1, []), envelope: envelope(one), rawText: raw(one) }]).status, 'pass');
  assert.equal(run(lexeme('7.00', 'Condition'), [{ ...call(1, []), envelope: envelope(one), rawText: raw(one) }]).status, 'fail', 'the type is part of the identity');
  const quoted = [hba1c('synthetic-lab', { valueQuantity: { value: '7.00', unit: '%' } })];
  assert.equal(run(lexeme('7.00'), [{ ...call(1, []), envelope: envelope(quoted), rawText: raw(quoted) }]).status, 'fail', 'a JSON string is not a numeric token');
  const big = [hba1c('synthetic-lab', { valueQuantity: { value: '@9007199254740992@', unit: '%' } })];
  assert.equal(run(lexeme('9007199254740993'), [{ ...call(1, []), envelope: envelope(big), rawText: raw(big) }]).status, 'fail', 'unsafe integers compare as text');
  const otherIndex = [{ ...call(1, []), envelope: envelope([hba1c('qs-edge-other'), hba1c('qs-edge-hba1c-corrected', { meta: { versionId: '2' } })], [0]) }];
  assert.equal(run(fact('status', 'corrected', { version: '2' } as Partial<Check>), otherIndex).cause, 'version_mismatch', 'provenance for another index gives no version');
});

test('package oracle: a missing value never satisfies an expected null', () => {
  assert.equal(run(fact('valueQuantity.comparator', null), [call(1, [hba1c('qs-edge-hba1c-corrected', { valueQuantity: { value: 7, unit: '%' } })])]).cause, 'expected_fact_missing');
  assert.equal(run(fact('valueQuantity.comparator', null), [call(1, [hba1c('qs-edge-hba1c-corrected', { valueQuantity: { value: 7, comparator: null, unit: '%' } })])]).status, 'pass');
});

test('package oracle: work and outcomes stay with their own call; unknown or unexecuted work never passes', () => {
  const work: Check = { kind: 'upstreamWork', id: 'w', step: 1, clinical: 0 };
  const sdkError = (extra: Partial<OracleCall> = {}): OracleCall => ({ step: 1, outcome: { class: 'sdk_text_error', code: 'sdk_text_error' }, work: { metadata: 0, auth: 0, clinical: 1 }, ...extra });
  assert.equal(run(work, [call(0, []), sdkError()]).cause, 'upstream_work_mismatch', 'a clinical request before an SDK error counts');
  assert.equal(run(work, [call(0, []), sdkError({ work: undefined })]).cause, 'harness_error', 'unknown work on an envelope-less call');
  assert.equal(run(work, [call(0, [])]).cause, 'harness_error', 'a step with no call has no work count');
  assert.equal(run(work, [call(0, []), sdkError({ work: { metadata: 0, auth: 0, clinical: 0 } })]).status, 'pass', 'a recorded zero-work SDK error');
  const notFound = (extra: Partial<Check> = {}): Check => ({ kind: 'callOutcome', id: 'nf', step: 1, outcome: 'application_error', code: 'NOT_FOUND', ...extra } as Check);
  const errorEnvelope = envelope([], [], { error: { code: 'NOT_FOUND', safe_message: 'Not found.' } });
  const mixed = [call(1, [hba1c('qs-edge-hba1c-corrected')]), { step: 1, envelope: errorEnvelope, work: { metadata: 0, auth: 0, clinical: 1 } } as OracleCall];
  assert.equal(run(notFound(), mixed).status, 'fail', 'response 0 cannot borrow response 1\'s outcome');
  assert.equal(run(notFound({ response_index: 1 }), mixed).status, 'pass', 'an envelope error is the call\'s outcome even when none was recorded');
  assert.equal(run(notFound({ response_index: 'all' }), mixed).status, 'fail', "'all' needs the outcome on every call");
  assert.equal(run(notFound({ response_index: 9 }), mixed).cause, 'expected_fact_missing', 'an index past the step\'s calls fails');
  for (const check of [{ kind: 'resourceAbsent', id: 'a', step: 1, resource: 'qs-edge-other-hba1c', response_index: 9 }, { kind: 'constraintNotClaimed', id: 'n', step: 1, name: 'code', response_index: 9 }] as Check[])
    assert.equal(run(check, mixed).status, 'fail', `${check.kind} with a missing response`);
  assert.equal(run({ ...notFound(), step: undefined } as Check, mixed).cause, 'harness_error', 'a multi-step check without a step is unbound');
});

test('package oracle: the raw JSON-RPC result member keeps numeric lexemes that decoding would lose', () => {
  const resources = [hba1c('qs-edge-hba1c-corrected', { valueQuantity: { value: '@7.00@', unit: '%' } })];
  const frame = `{"jsonrpc":"2.0","id":7,"result":${raw(resources)}}`;
  const member = rawMember(frame, 'result')!;
  assert.match(member, /"value":7\.00,/);
  assert.equal(rawMember(frame, 'absent'), undefined);
  const lexeme: Check = { kind: 'decimalLexeme', id: 'd', step: 1, resource_type: 'Observation', id_value: 'qs-edge-hba1c-corrected', path: 'valueQuantity.value', equals: '7.00' };
  assert.equal(run(lexeme, [{ ...call(1, []), envelope: envelope(resources), rawText: member }]).status, 'pass');
  assert.equal(run(lexeme, [{ ...call(1, []), envelope: envelope(resources), rawText: JSON.stringify(JSON.parse(member)) }]).status, 'fail', 'decode and reserialize loses 7.00');
});

test('package oracle: citedFact binds the citation, the decoded value and the raw token to one cited occurrence of one response', () => {
  const cited = (extra: Partial<Check> = {}): Check => ({ kind: 'citedFact', id: 'cf', step: 1, source: 'qs-hapi', resource_type: 'Observation', id_value: 'synthetic-lab',
    version: '2', path: 'valueQuantity.value', ...extra } as Check);
  // As the SDK delivers them: the raw result is the whole envelope as the server spelled it; the decoded envelope is its
  // structuredContent parsed by JSON.parse.
  const decoded = (resources: Rec[]) => (JSON.parse(raw(resources)) as { structuredContent: { data: { resources: Rec[] } } }).structuredContent.data.resources;
  const rawOf = (env: GatewayEnvelope) => JSON.stringify({ structuredContent: env }).replace(/"@([-0-9.eE+]+)@"/g, '$1');
  const delivered = (resources: Rec[], provenance?: (number | Rec)[]) => {
    const rawText = rawOf(envelope(resources, provenance));
    return [{ ...call(1, []), envelope: (JSON.parse(rawText) as { structuredContent: GatewayEnvelope }).structuredContent, rawText }];
  };
  const v2 = (value?: string, extra: Rec = {}) => hba1c('synthetic-lab', { meta: { versionId: '2' }, valueQuantity: value === undefined ? { unit: '%' } : { value: `@${value}@`, unit: '%' }, ...extra });
  const v1 = (value: string) => hba1c('synthetic-lab', { valueQuantity: { value: `@${value}@`, unit: '%' } });
  assert.equal(run(cited({ lexeme: '7.00' }), delivered([v2(undefined), v1('7.00')])).cause, 'expected_fact_missing', 'the cited version has no value; another version cannot lend one');
  assert.equal(run(cited({ lexeme: '7.00' }), delivered([v2('7.00'), v1('8')])).status, 'pass', 'another version may hold a different value');
  assert.equal(run(cited({ lexeme: '7.0' }), delivered([v2('7.00')])).cause, 'expected_fact_mismatch');
  assert.equal(run(cited({ path: 'status', equals: 'corrected' }), delivered([v2('7.00')])).status, 'pass');
  assert.equal(run(cited({ path: 'status', equals: 'final' }), delivered([v2('7.00')])).cause, 'expected_fact_mismatch');
  assert.equal(run(cited({ path: 'status', equals: 'corrected' }), delivered([v2('7.00', { status: 'final' }), v2('7.00')])).cause, 'resource_id_mismatch', 'one identity twice is ambiguous');
  assert.equal(run(cited({ path: 'status', equals: 'corrected' }), delivered([v2('7.00')], [])).cause, 'version_mismatch', 'an uncited occurrence');
  assert.equal(run(cited({ path: 'status', equals: 'corrected', source: 'other' }), delivered([v2('7.00')])).cause, 'version_mismatch', 'another source');
  assert.equal(run(cited({ path: 'status', equals: 'corrected', version: '3' }), delivered([v2('7.00')])).cause, 'version_mismatch');
  assert.equal(run(cited({ path: 'status', equals: 'corrected', resource_type: 'Condition' }), delivered([v2('7.00')])).cause, 'version_mismatch', 'the type is part of the identity');
  assert.equal(run(cited({ path: 'valueQuantity.comparator', absent: true }), delivered([v2('7.00')])).status, 'pass');
  assert.equal(run(cited({ path: 'valueQuantity.comparator', absent: true }), delivered([v2('7.00', { valueQuantity: { value: '@7.00@', comparator: null, unit: '%' } })])).status, 'fail', 'an explicit null is present, not absent');
  assert.equal(run(cited({ path: 'valueQuantity.unit', absent: true }), delivered([v2('7.00')])).cause, 'expected_absence_violated');
  assert.equal(run(cited({ path: 'valueQuantity.low', lexeme: '7.00' }), delivered([v2('7.00')])).cause, 'expected_fact_missing', 'the requested path must exist');
  const other = [v2('8')];
  assert.equal(run(cited({ lexeme: '7.00' }), [{ ...call(1, []), envelope: envelope(decoded([v2('7.00')])), rawText: rawOf(envelope(other)) }]).cause, 'data_mismatch', 'raw text of another response');
  assert.equal(run(cited({ lexeme: '7.00' }), [{ ...call(1, []), envelope: envelope(decoded([v2('7.00')])), rawText: undefined }]).cause, 'expected_fact_missing', 'no raw capture, no pass');
  // The raw citation is part of the same response: the same resource at the same index under another source, request or
  // provenance, or a raw result carrying the resources alone, is not the cited occurrence.
  const good = delivered([v2('7.00')])[0]!;
  for (const [label, change] of [['another raw source', { source: { alias: 'other-source', fhir_version: '4.0.1', capability_revision: 'x' } }],
    ['another raw request', { request_id: 'different-response' }], ['no raw provenance', { provenance: [] }]] as [string, Rec][])
    assert.equal(run(cited({ lexeme: '7.00' }), [{ ...good, rawText: rawOf({ ...envelope([v2('7.00')]), ...change } as GatewayEnvelope) }]).cause, 'data_mismatch', label);
  assert.equal(run(cited({ lexeme: '7.00' }), [{ ...good, rawText: raw([v2('7.00')]) }]).cause, 'data_mismatch', 'raw resources without their envelope');
  assert.equal(run(cited({ lexeme: '7.00' }), delivered([v2(undefined, { valueQuantity: { value: '7.00', unit: '%' } })])).cause, 'expected_fact_mismatch', 'a string is not a numeric token');
  assert.equal(run(cited({ path: 'status', equals: 'corrected', version: null }), delivered([v2('7.00')])).cause, 'version_mismatch', 'a version-less claim never matches a versioned resource');
  const sdkFirst = [{ step: 1, outcome: { class: 'sdk_text_error', code: 'sdk_text_error' }, work: { metadata: 0, auth: 0, clinical: 0 } } as OracleCall, ...delivered([v2('7.00')])];
  assert.equal(run(cited({ lexeme: '7.00' }), sdkFirst).status, 'fail', 'call 0 is the SDK error: response indexes count every recorded call');
  assert.equal(run(cited({ lexeme: '7.00', response_index: 1 }), sdkFirst).status, 'pass');
  assert.equal(run({ kind: 'citationTuple', id: 'c', step: 1, response_index: 1, resource_type: 'Observation', id_value: 'synthetic-lab', source: 'qs-hapi', version: '2' }, sdkFirst).status, 'pass');
  assert.equal(run({ kind: 'citationTuple', id: 'c', step: 1, resource_type: 'Observation', id_value: 'synthetic-lab', source: 'qs-hapi', version: '2' }, sdkFirst).status, 'fail');
  assert.equal(evaluateCheck(cited({ lexeme: '7.00' }), 'fhir', collectEvidence([envelope(decoded([v2('7.00')])), envelope(decoded([v2('7.00')]))], [], { rawResults: [raw([v2('7.00')]), raw([v2('7.00')])] })).cause, 'harness_error', 'one response only');
});

test('package oracle: retrieval times are real calendar instants', () => {
  const citation: Check = { kind: 'citationTuple', id: 'c', step: 1, resource_type: 'Observation', id_value: 'qs-edge-hba1c-corrected', source: 'qs-hapi', version: '1' };
  const at = (retrieved_at: unknown) => run(citation, [{ ...call(1, []), envelope: envelope([hba1c('qs-edge-hba1c-corrected')], [{ resource_index: 0, retrieved_at }]) }]).status;
  for (const time of ['2025-11-04T00:00:00Z', '2024-02-29T23:59:59.999+05:30', '2025-12-31T23:59:59-14:00']) assert.equal(at(time), 'pass', time);
  for (const time of ['2025-02-30T00:00:00Z', '2023-02-29T00:00:00Z', '2025-11-04T24:00:00Z', '2025-11-04T12:60:00Z', '2025-11-04T12:00:60Z', '2025-13-01T00:00:00Z',
    '2025-11-04', '2025-11-04T00:00:00', '2025-11-04T00:00:00+15:00', '2025-11-04T00:00:00+14:59', 5]) assert.equal(at(time), 'fail', String(time));
  assert.equal(run(citation, [{ ...call(1, []), envelope: envelope([hba1c('qs-edge-hba1c-corrected')], [0, { resource_index: 0.5, retrieved_at: '2025-11-04T00:00:00Z' }]) }]).status, 'fail', 'a fractional index');
});

test('package oracle: an arm-specific check is incomparable on other arms before any selection, and work and outcome codes are exact', () => {
  const compactOnly: Check = { kind: 'citationTuple', id: 'c', step: 1, response_index: 9, arms: ['compact'], resource_type: 'Observation', id_value: 'qs-edge-hba1c-corrected', source: 'qs-hapi', version: '1' };
  assert.equal(run(compactOnly, [call(1, [hba1c('qs-edge-hba1c-corrected')])]).status, 'incomparable');
  const brokenChain = [{ ...call(1, []), envelope: envelope([hba1c('qs-edge-hba1c-corrected')], undefined, { coverage: { state: 'unknown', scope: 'page', reasons: [], query_digest: '0'.repeat(64), constraints: [] } }) }];
  assert.equal(run(compactOnly, brokenChain).status, 'incomparable', 'applicability comes before chain resolution');
  assert.equal(evaluateStepCheck(compactOnly, 'compact', brokenChain, { stepCount: 2, requests: [] }).cause, 'coverage_invalid', 'where it applies, the broken chain fails it');
  assert.equal(evaluateStepCheck(compactOnly, 'compact', [call(1, [hba1c('qs-edge-hba1c-corrected')])], { stepCount: 2, requests: [] }).cause, 'expected_fact_missing');
  const twoCalls = [call(1, []), call(1, [])];
  assert.equal(run({ kind: 'upstreamWork', id: 'w', step: 1, clinical: 2 }, twoCalls).status, 'pass', 'the step total sums every call');
  assert.equal(run({ kind: 'upstreamWork', id: 'w', step: 1, clinical: 1, response_index: 1 } as Check, twoCalls).status, 'pass', 'a selected call counts alone');
  const errored = [{ step: 1, outcome: { class: 'application_error', code: 'NOT_FOUND' }, work: { metadata: 0, auth: 0, clinical: 1 } } as OracleCall];
  assert.equal(run({ kind: 'callOutcome', id: 'o', step: 1, outcome: 'application_error', code: 'FORBIDDEN' }, errored).status, 'fail', 'the code must match too');
  assert.equal(run({ kind: 'decimalLexeme', id: 'd', step: 1, resource_type: 'Observation', id_value: 'qs-edge-hba1c-corrected', path: 'valueQuantity.low', equals: '7' },
    [call(1, [hba1c('qs-edge-hba1c-corrected')])]).status, 'fail', 'a missing path never borrows another value');
});

test('package oracle: a query chain keeps its bound type across empty pages and refuses a returned resource of another type', () => {
  const digest = (type: string) => createHash('sha256').update(JSON.stringify({ v: 1, source_revision: 'x', policy_revision: 'synthetic-v1', context_handle: 'ctx', resource_type: type,
    constraints: [{ name: 'code', value: 'http://loinc.org|4548-4' }], sort: [] })).digest('hex');
  const page = (resources: Rec[], first: boolean) => envelope(resources, undefined, { coverage: { state: 'unknown', scope: 'page', reasons: [], query_digest: digest('Observation'),
    ...(first ? { constraints: [{ name: 'code', value: 'http://loinc.org|4548-4', source_reported: 'not_reported', execution: 'unknown' }] } : { constraints_on_first_page: true }) } });
  const ids: Check = { kind: 'resourceIdSet', id: 's', step: 1, equals: ['qs-edge-hba1c-corrected'] };
  const chain = (second: Rec[]) => [{ ...call(1, []), envelope: page([hba1c('qs-edge-hba1c-corrected')], true) }, { ...call(1, []), envelope: page(second, false) }];
  assert.equal(run(ids, chain([])).status, 'pass', 'an empty last page keeps the chain\'s type');
  assert.equal(run(ids, chain([{ resourceType: 'Condition', id: 'c1' }])).cause, 'coverage_invalid', 'another returned type breaks the chain');
  assert.equal(evaluateStepCheck(ids, 'fhir', chain([]), { stepCount: 2, requests: [], resourceType: 'Condition' }).cause, 'coverage_invalid', 'a bound type the results contradict');
  // A cited fact on a shorthand continuation page compares the raw result with the page as delivered, not with the
  // coverage the chain resolution fills in from the first page.
  const second = page([hba1c('qs-edge-hba1c-corrected')], false);
  const pages = [{ ...call(1, []), envelope: page([hba1c('qs-edge-hba1c-entered-in-error')], true) }, { ...call(1, []), envelope: second, rawText: JSON.stringify({ structuredContent: second }) }];
  assert.equal(run({ kind: 'citedFact', id: 'cf', step: 1, response_index: 1, source: 'qs-hapi', resource_type: 'Observation', id_value: 'qs-edge-hba1c-corrected', version: '1',
    path: 'status', equals: 'corrected' }, pages).status, 'pass');
});

test('package oracle: upstream paging serves every retained remainder before the next upstream page', () => {
  const lab = (n: number) => Array.from({ length: n }, (_, i) => hba1c(`lab-${n}-${i}`));
  const drained = (rows: number[], clinical: number[]) => rows.map((n, i) => ({ ...call(0, lab(n)), work: { metadata: 0, auth: 0, clinical: clinical[i]! } }));
  const paging: Check = { kind: 'upstreamPaging', id: 'p', step: 0, page_size: 100 };
  const at = (calls: OracleCall[]) => evaluateStepCheck(paging, 'fhir', calls, { stepCount: 2, requests: [] });
  // The live fhir-arm shape at 64 KiB: three upstream pages of 100, 100 and 41, each delivered over several calls.
  assert.equal(at(drained([32, 32, 32, 4, 32, 32, 33, 3, 33, 8], [1, 0, 0, 0, 1, 0, 0, 0, 1, 0])).status, 'pass');
  assert.equal(at(drained([100, 100, 41], [1, 1, 1])).status, 'pass', 'whole pages per call');
  assert.equal(at(drained([77, 23, 77, 23, 41], [1, 0, 1, 1, 0])).cause, 'upstream_work_mismatch', 'prefetch during the second remainder, compensated at the end');
  assert.equal(at(drained([77, 23, 77, 23, 41], [1, 1, 0, 1, 0])).cause, 'upstream_work_mismatch', 'the next page fetched before the first remainder');
  assert.equal(at(drained([100, 41], [0, 1])).cause, 'upstream_work_mismatch', 'the first call must fetch');
  assert.equal(at(drained([100, 41], [2, 0])).cause, 'upstream_work_mismatch', 'one clinical request per call at most');
  assert.equal(at(drained([60, 40], [1, 2])).cause, 'upstream_work_mismatch', 'a later call cannot make two requests either');
  assert.equal(at(drained([100, 141], [1, 1])).cause, 'upstream_work_mismatch', 'the last page cannot exceed the page size');
  assert.equal(at([...drained([100, 41], [1, 1]), { step: 0, outcome: { class: 'sdk_text_error', code: 'sdk_text_error' }, work: { metadata: 0, auth: 0, clinical: 0 } } as OracleCall]).cause,
    'harness_error', 'an envelope-less call in the drain');
  assert.equal(at(drained([100, 41], [1, 1]).map(({ work: _work, ...rest }) => rest)).cause, 'harness_error', 'unknown work never passes');
});

test('package oracle: a retained read answers exactly the issuing response\'s rows, versions and facts', () => {
  const rows = Array.from({ length: 32 }, (_, i) => hba1c(`lab-${i}`, { valueQuantity: { value: i, unit: '%' } }));
  const result = { handle: 'res_first', expires_at: '2025-11-04T00:01:00Z', formats: ['compact', 'fhir'] };
  const view = { format: 'fhir', requested_format: 'fhir', projected: false, withheld_payloads: [] };
  const completeCall = (step: number, env: GatewayEnvelope): OracleCall => ({ ...call(step, []), envelope: env, rawText: JSON.stringify({ structuredContent: env }) });
  const issuing = completeCall(0, envelope(rows, undefined, { result }));
  const last = { ...call(0, rows.slice(0, 8).map((r, i) => ({ ...r, id: `last-${i}` }))) };
  const inspect = (omitted: Rec[], count = 32) => completeCall(1, envelope([], [], { data: { resource_count: count, omissions: omitted, next_offset: 20 }, result, transform: view, provenance: undefined }));
  const omission = (r: Rec, i: number) => ({ resource_index: i, resource_type: r.resourceType, id: r.id, version: (r.meta as Rec).versionId, omitted_fields: [], withheld_reasons: [], interpretation: 'clinical_projection' });
  const slice = (extra: Partial<Check> = {}): Check => ({ kind: 'retainedSlice', id: 'r', step: 1, from_step: 0, view: 'omissions', offset: 0, limit: 20, whole_count: true, ...extra } as Check);
  const judge = (check: Check, calls: OracleCall[]) => evaluateStepCheck(check, 'fhir', calls, { stepCount: 3, requests: [] });
  assert.equal(judge(slice(), [issuing, last, inspect(rows.slice(0, 20).map(omission))]).status, 'pass', 'the first answered call of the step issued the handle');
  assert.equal(judge(slice(), [last, issuing, inspect(rows.slice(0, 20).map(omission))]).cause, 'resource_id_mismatch', 'a read of the last drained response is not the first\'s');
  assert.equal(judge(slice(), [issuing, inspect(rows.slice(0, 20).map(omission), 8)]).cause, 'data_mismatch', 'the whole retained count');
  assert.equal(judge(slice(), [issuing, inspect(rows.slice(1, 21).map(omission))]).cause, 'resource_id_mismatch', 'shifted rows');
  assert.equal(judge(slice(), [issuing, inspect(rows.slice(0, 20).map((r, i) => ({ ...omission(r, i), version: '2' })))]).cause, 'resource_id_mismatch', 'another version');
  assert.equal(judge(slice(), [inspect(rows.slice(0, 20).map(omission))]).cause, 'expected_fact_missing', 'no issuing response');
  const fields = ['status', 'code', 'valueQuantity'];
  const project = (out: Rec[]) => completeCall(1, envelope(out, undefined, { result, data: { resources: out, ...(out.length < 32 ? { next_offset: out.length } : {}) },
    pagination: { returned_matches: out.length, returned_includes: 0, has_more: out.length < 32 }, transform: view }));
  const projected = rows.slice(0, 20).map(r => ({ resourceType: r.resourceType, id: r.id, meta: r.meta, status: r.status, code: r.code, valueQuantity: r.valueQuantity }));
  assert.equal(judge(slice({ view: 'resources', whole_count: undefined, fields }), [issuing, project(projected)]).status, 'pass');
  assert.equal(judge(slice({ view: 'resources', whole_count: undefined, fields }), [issuing, project(projected.map((r, i) => i === 3 ? { ...r, status: 'final' } : r))]).cause,
    'expected_fact_mismatch', 'a retained fact changed');
  assert.equal(judge(slice({ view: 'resources', whole_count: undefined, fields }), [issuing, project(projected.map(r => ({ ...r, id: `synthetic-wrong-${String(r.id)}` })))]).cause,
    'resource_id_mismatch', 'other identities with the same facts');
  assert.equal(judge(slice({ view: 'resources', whole_count: undefined, fields: ['code.text'] }), [issuing, project(projected)]).cause, 'expected_fact_mismatch', 'a field the issuing response lacks proves nothing');
  assert.equal(judge(slice({ view: 'resources', limit: 5, whole_count: undefined, fields }), [issuing, project(projected.slice(0, 5))]).status, 'pass');
  const sourceNull = rows.map((r, i) => i === 0 ? { ...r, status: null } : r);
  const nullIssuing = completeCall(0, envelope(sourceNull, undefined, { result }));
  const missingStatus = projected.map((r, i) => { const out = { ...r }; if (i === 0) delete out.status; return out; });
  assert.equal(judge(slice({ view: 'resources', whole_count: undefined, fields: ['status'] }), [nullIssuing, project(missingStatus)]).status, 'fail', 'a retained null and an absent field are different claims');
  const resourcesCheck = slice({ view: 'resources', whole_count: undefined, fields });
  assert.equal(judge(resourcesCheck, [issuing, project(projected.map((r, i) => i === 3 ? { ...r, code: { text: 'wrong code' } } : r))]).cause, 'expected_fact_mismatch', 'a retained code changed');
  const changed = (record: OracleCall, edit: (env: Rec) => void, rawEdit?: (text: string) => string): OracleCall => {
    const env = structuredClone(record.envelope!) as unknown as Rec; edit(env);
    return { ...record, envelope: env as unknown as GatewayEnvelope, rawText: rawEdit ? rawEdit(JSON.stringify({ structuredContent: env })) : JSON.stringify({ structuredContent: env }) };
  };
  for (const [label, record] of [
    ['indexes', changed(inspect(rows.slice(0, 20).map(omission)), e => { (e.data as Rec).omissions = rows.slice(0, 20).map((r, i) => ({ ...omission(r, i), resource_index: 999 })); })],
    ['offset', changed(project(projected), e => { (e.data as Rec).next_offset = 999; })],
    ['pagination', changed(project(projected), e => { (e.pagination as Rec).has_more = false; })],
    ['format', changed(project(projected), e => { (e.transform as Rec).format = 'compact'; })],
    ['missing provenance', changed(project(projected), e => { e.provenance = []; })],
    ['invalid provenance', changed(project(projected), e => { (e.provenance as Rec[])[0]!.retrieved_at = '2025-02-30T00:00:00Z'; })],
    ['other retrieval', changed(project(projected), e => { (e.provenance as Rec[])[0]!.retrieved_at = '2025-11-05T00:00:00Z'; })],
    ['raw spelling', changed(project(projected), () => {}, raw => raw.replace('"value":3,', '"value":3.0,'))],
    ['action controls', changed(project(projected), e => { (e.transform as Rec).projected = false; })],
  ] as [string, OracleCall][]) {
    const check = label === 'indexes' ? slice() : label === 'action controls' ? { ...resourcesCheck, action: 'project' as const } : resourcesCheck;
    assert.equal(judge(check, [issuing, record]).status, 'fail', label);
  }
  const omissionCheck = slice({ omissions: [{ format: 'fhir', omitted_fields: [], withheld_reasons: [] }] });
  assert.equal(judge(omissionCheck, [issuing, inspect(rows.slice(0, 20).map((r, i) => ({ ...omission(r, i), omitted_fields: ['/invented'] })))]).status, 'fail');
  assert.equal(judge(slice({ from_step: 1 }), [issuing, inspect(rows.slice(0, 20).map(omission))]).cause, 'harness_error', 'only an earlier step can issue the handle');
});
