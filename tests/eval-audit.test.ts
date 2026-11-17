import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { roundedGatewayCopy } from './eval-audit-helpers.js';
import { FhirGateway, type GatewayEnvelope } from '../packages/core/src/index.js';
import { TASKS, exitCodeForReport, parseM3bTaskFile, runEvals } from '../packages/evals/src/index.js';
import { collectEvidence, evaluateCheck, parseOracleJson, oracleNumberLexeme } from '../packages/evals/src/evidence-oracle.js';
import { numbersOf, parseResource, storedMatchesApproved } from '../examples/quickstart/setup-oracle.js';
import { EVAL_PATIENT_ID, GOLDEN_RESOURCES, searchParamDeclaration, startEvalFixtureServer } from '../packages/evals/src/fixture.js';
import { externalTasks } from '../packages/evals/src/external.js';

// Child processes run from temporary directories, so resolve the tsx loader from this checkout, not from their cwd.
const TSX_LOADER = import.meta.resolve('tsx');

test('eval audit: the decimal-lexeme mutant fails default lexeme tasks in every arm and both eras', { timeout: 120_000 }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'eval-decimal-'));
  try {
    const copy = roundedGatewayCopy(directory);
    const probe = `import {runEvals,exitCodeForReport,TASKS} from './packages/evals/src/index.ts';
      for(const era of ['modern','legacy']) {
        const r=await runEvals({era,tasks:TASKS.filter(t=>['decimal-lexeme-preserved','p-decimal-lexemes'].includes(t.id))});
        if(exitCodeForReport(r)!==1 || r.results.some(row=>!row.failures.some(f=>f.check_id?.includes('lexeme')))) process.exit(2);
      } console.log('ROUNDED_EVAL_REJECTED both-eras all-arms');`;
    const child = spawnSync(process.execPath, ['--import', TSX_LOADER, '--input-type=module', '-e', probe], { cwd: copy, encoding: 'utf8', timeout: 110_000 });
    assert.equal(child.status, 0, child.stdout + child.stderr);
    assert.match(child.stdout, /ROUNDED_EVAL_REJECTED/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('eval audit: seed/setup expected tokens use an independent scanner and reject rounded storage', () => {
  const text = '{"resourceType":"Observation","id":"synthetic","valueQuantity":{"value":7.00},"component":[{"value":1.50e3}],"unsafe":9007199254740993}';
  const approved = parseResource(Buffer.from(text));
  assert.deepEqual(numbersOf(approved), [
    { pointer: '/component/0/value', lexeme: '1.50e3' }, { pointer: '/unsafe', lexeme: '9007199254740993' }, { pointer: '/valueQuantity/value', lexeme: '7.00' },
  ]);
  assert.equal(oracleNumberLexeme((parseOracleJson('7.0'))), '7.0');
  assert.equal(storedMatchesApproved(approved, parseResource(Buffer.from(text.replace('7.00', '7')))), false);
  for (const malformed of ['{"a":01}', '{"a":"\\uZZZZ"}', '{"a":1,}']) assert.throws(() => parseOracleJson(malformed));
});

test('eval audit: discovery checks reject duplicate, skipped, mistyped and unfinished rows', () => {
  const check = { kind: 'discoveryRows', id: 'drain', includes: [{ name: 'code', type: 'token' }, { name: 'date', type: 'date' }], complete: true } as const;
  const rows = [{ name: 'code', type: 'token' }, { name: 'date', type: 'date' }];
  const judge = (data: Record<string, unknown>[], complete = true) => evaluateCheck({ ...check, complete } as never, 'fhir', collectEvidence(data.map(data => ({ data } as GatewayEnvelope)))).status;
  const pages = [{ search_parameters: [rows[0]], total_parameters: 2, next_cursor: 'next' }, { search_parameters: [rows[1]], total_parameters: 2 }];
  assert.equal(judge(pages), 'pass');
  assert.equal(judge([{ search_parameters: [...rows, rows[0]], total_parameters: 3 }]), 'fail');
  assert.equal(judge([{ search_parameters: [...rows, rows[0]], total_parameters: 3 }], false), 'fail');
  assert.equal(judge(pages.slice(0, 1)), 'fail');
  assert.equal(judge([{ search_parameters: rows, total_parameters: 3 }]), 'fail');
  assert.equal(judge([{ search_parameters: [...rows, { name: 'status', type: 'token' }], total_parameters: 3 }]), 'fail');
  assert.equal(judge([{ search_parameters: [{ ...rows[0], type: 'date' }, rows[1]], total_parameters: 2 }]), 'fail');
  assert.equal(judge([{ search_parameters: rows, total_parameters: 2, next_cursor: 'more' }]), 'fail');
});

test('eval audit: complete discovery rejects a formerly unlisted row dropped together with the reported total', () => {
  for (const tasks of [TASKS, externalTasks()]) {
    const check = tasks.find(task => task.id === 'discovery-snapshot-drain')!.checks.find(check => check.kind === 'discoveryRows')!;
    assert.equal(check.kind, 'discoveryRows');
    if (check.kind !== 'discoveryRows') throw new Error('missing discovery check');
    const rows = check.includes;
    assert.ok(rows.some(row => row.name === 'status'), 'status was absent from the old minimum subset');
    const judge = (returned: typeof rows) => evaluateCheck(check, 'fhir', collectEvidence([
      { data: { search_parameters: returned, total_parameters: returned.length } } as unknown as GatewayEnvelope,
    ])).status;
    assert.equal(judge(rows), 'pass');
    assert.equal(judge(rows.filter(row => row.name !== 'status')), 'fail');
    // Also exercise a three-row counterexample with a self-consistent lowered total.
    assert.equal(judge(rows.filter(row => ['code', 'date', 'subject'].includes(row.name))), 'fail');
  }
});

test('eval audit: the coded Observation is denied because it contains an unclassified Basic', async () => {
  const resource = GOLDEN_RESOURCES.find(row => row.id === 'obs-contained-unclassified')!;
  assert.deepEqual(resource.code, { coding: [{ system: 'http://example.invalid/synthetic-eval', code: 'synthetic-contained-unclassified', display: 'Synthetic contained-resource result' }] });
  assert.deepEqual(resource.extension, [{ url: 'http://example.invalid/synthetic-eval/unclassified-detail', valueReference: { reference: '#unclassified' } }]);
  const fixture = await startEvalFixtureServer([resource]);
  const gateway = new FhirGateway({ mode: 'synthetic', source: { alias: 'contained-control', baseUrl: fixture.baseUrl }, patientId: EVAL_PATIENT_ID });
  try {
    const input = { resource_type: 'Observation', id: resource.id };
    assert.equal((await gateway.execute('fhir_read', input)).error?.code, 'NOT_FOUND');
    const control = structuredClone(resource);
    delete control.contained;
    delete control.extension;
    fixture.selectResources([control]);
    assert.equal((await gateway.execute('fhir_read', input)).error, undefined);
  } finally { gateway.close(); await fixture.close(); }
});

test('eval audit: ignoring selected fields fails the selected arm', async () => {
  const original = FhirGateway.prototype.execute;
  FhirGateway.prototype.execute = function(tool, input: any) {
    const changed = structuredClone(input);
    if (changed.output) delete changed.output.fields;
    return original.call(this, tool, changed);
  };
  try {
    const report = await runEvals({ arms: ['selected'], tasks: [TASKS.find(task => task.id === 'hba1c-quantity-ucum')!] });
    assert.equal(exitCodeForReport(report), 1);
    assert.ok(report.results[0]!.failures.some(f => f.detail.includes('selected output')));
  } finally { FhirGateway.prototype.execute = original; }
});

test('eval audit: inherited fixture table entries never become raw resources or definitions', async () => {
  Object.defineProperty(Object.prototype, 'Observation.inherited-test', { value: { type: 'uri', definition: 'synthetic-prototype' }, configurable: true });
  try { assert.deepEqual(searchParamDeclaration('Observation', 'inherited-test'), { name: 'inherited-test', type: 'token' }); }
  finally { delete (Object.prototype as any)['Observation.inherited-test']; }
  const raw = Object.create({ 'Observation/inherited-test': '{"resourceType":"Observation","id":"inherited-test"}' });
  const fixture = await startEvalFixtureServer([], raw);
  try { assert.equal((await fetch(`${fixture.baseUrl}/Observation/inherited-test`)).status, 404); }
  finally { await fixture.close(); }
});

test('eval audit: counted query corpus rejects missing discovery rows', async () => {
  const ids = ['discovery-snapshot-drain', 'discover-unknown-and-conflicting-definition', 'query-opaque-evidence'];
  const report = await runEvals({ tasks: TASKS.filter(task => ids.includes(task.id)) });
  assert.equal(exitCodeForReport(report), 0, JSON.stringify(report.results.flatMap(row => row.failures)));
});

test('eval audit: selection requires its projected flag even when no extra key is present', async () => {
  const original = FhirGateway.prototype.execute;
  FhirGateway.prototype.execute = async function(tool, input: any) {
    const envelope = await original.call(this, tool, input);
    const captures = (this as any).capturesV2;
    const capture = captures.get(envelope);
    if (capture && input.output?.fields) {
      const result = structuredClone(capture.result);
      result.structuredContent.transform.projected = false;
      // The shorter false/true spelling needs an independently consistent envelope and wire accounting.
      for (let i = 0; i < 8; i++) {
        result.content[0].text = JSON.stringify(result.structuredContent);
        result.structuredContent.budget.bytes_returned = Buffer.byteLength(JSON.stringify(result));
      }
      result.content[0].text = JSON.stringify(result.structuredContent);
      captures.set(envelope, { ...capture, result });
    }
    return envelope;
  };
  try {
    const report = await runEvals({ arms: ['selected'], tasks: [TASKS.find(task => task.id === 'hba1c-quantity-ucum')!] });
    assert.ok(report.results[0]!.failures.some(f => f.detail.includes('selected output')));
  } finally { FhirGateway.prototype.execute = original; }
});

test('eval audit: qualification recorder refuses ineligible profiles', () => {
  const directory = mkdtempSync(join(tmpdir(), 'record-qualification-'));
  try {
    const target = join(directory, 'packages/core/src/data');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'search-profiles.json'), JSON.stringify({ profiles: [{ id: 'ineligible', eligible: false }] }));
    const url = new URL('../scripts/record-search-qualification.ts', import.meta.url).href;
    const child = spawnSync(process.execPath, ['--import', TSX_LOADER, '--input-type=module', '-e', `import {recordSearchQualification} from ${JSON.stringify(url)}; recordSearchQualification('ineligible', {}, {});`], { cwd: directory, encoding: 'utf8' });
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, /Re-qualification requires an existing eligible profile/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});


test('eval audit: inherited adversarial modes are refused', () => {
  const task = { ...structuredClone(TASKS[0]!), fixtureMode: 'toString' };
  assert.throws(() => parseM3bTaskFile(JSON.stringify({ schema_version: 'm3b-tasks/1', tasks: [task] })), /unrecognized fixtureMode/);
});

test('eval audit: numeric facts compare the decoded wire envelope rather than gateway decimal objects', async () => {
  const task = structuredClone(TASKS.find(task => task.id === 'decimal-lexeme-preserved')!);
  task.checks.push({ kind: 'fact', id: 'wire-number', resource: 'obs-decimal-1', path: 'valueQuantity.value', equals: 7 });
  const report = await runEvals({ tasks: [task] });
  assert.equal(exitCodeForReport(report), 0, JSON.stringify(report.results.flatMap(row => row.failures)));
});

test('eval audit: discovery check vocabulary rejects malformed and extra row fields', () => {
  for (const includes of [[], [{ name: 42, type: 'token' }], [{ name: 'code', type: 'token', invented: true }]]) {
    const task = { ...structuredClone(TASKS[0]!), checks: [{ kind: 'discoveryRows', id: 'bad-row', step: 0, includes }] };
    assert.throws(() => parseM3bTaskFile(JSON.stringify({ schema_version: 'm3b-tasks/1', tasks: [task] })), /invalid discoveryRows/);
  }
});

test('eval audit: a clinical object named rawJSON cannot masquerade as an oracle number', () => {
  const value = parseResource(Buffer.from('{"rawJSON":"7.00","value":1.50}'));
  assert.equal(oracleNumberLexeme(value), undefined);
  assert.deepEqual(numbersOf(value), [{ pointer: '/value', lexeme: '1.50' }]);
});
