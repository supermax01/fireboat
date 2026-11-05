import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { boundStep } from '../packages/evals/src/evidence-oracle.js';
import { armOutput, packageTasks, seedFacts, type SeedFacts } from '../packages/evals/src/package-tasks.js';

const fixture = (name: string) => readFileSync(new URL(`../packages/evals/fixtures/quickstart/${name}`, import.meta.url), 'utf8');
const ndjson = fixture('resources.ndjson');
const manifest = JSON.parse(fixture('seed-manifest.json')) as { patient: string; resources: { type: string; id: string }[] };
const observed = (version = '1') => new Map(manifest.resources.map(r => [`${r.type}/${r.id}`, version]));
const facts = (): SeedFacts => seedFacts(ndjson, manifest.patient, observed());

test('package tasks: seed facts come from the checked-in seed text and the observed versions', () => {
  const f = facts();
  assert.deepEqual(f.hba1c.map(h => `${h.id.startsWith('qs-edge') ? h.id : 'natural'}:${h.status}:${h.lexeme}:${h.unit}`),
    ['qs-edge-hba1c-entered-in-error:entered-in-error:6.10:%', 'qs-edge-hba1c-corrected:corrected:7.00:%', 'natural:final:5.28:%'], 'newest first, raw lexemes kept');
  assert.equal(f.labIds.length, 241, 'every lab of the natural patient: 239 natural and 2 edges');
  assert.ok(!f.labIds.includes(f.foreignLab) && f.foreignLab === 'qs-edge-other-hba1c');
  assert.deepEqual(f.document, { id: 'qs-edge-document', version: '1', status: 'current', typeSystem: 'http://loinc.org', typeCode: '11506-3', date: '2025-11-03T09:00:00Z',
    contentType: 'text/plain', title: 'Synthetic quickstart note' });
  assert.deepEqual({ ...f.corrected, version: undefined }, { id: 'qs-edge-hba1c-corrected', status: 'corrected', lexeme: '7.00', unit: '%', unitSystem: 'http://unitsofmeasure.org',
    unitCode: '%', effective: '2025-11-03T08:30:00Z', version: undefined, coding: 0, system: 'http://loinc.org', code: '4548-4' }, 'no comparator or coding version: both are claimed absent');
  assert.equal(seedFacts(ndjson, manifest.patient, observed('7')).corrected.version, '7', 'versions are the observed ones, never assumed');
  assert.throws(() => seedFacts(ndjson, manifest.patient, new Map()), /no observed version/);
});

test('package tasks: three tasks whose checks bind to real steps, cite observed versions and use unique ids', () => {
  const f = facts(), tasks = packageTasks(f, 'qs-hapi');
  assert.deepEqual(tasks.map(t => t.id), ['package-latest-hba1c', 'package-status-sensitive', 'package-drain-reproject']);
  for (const task of tasks) {
    assert.equal(new Set(task.checks.map(c => c.id)).size, task.checks.length, `${task.id} check ids`);
    for (const check of task.checks) assert.notEqual(boundStep(check, task.steps.length), undefined, `${task.id}/${check.id} step`);
    task.steps.forEach((step, i) => { if (step.handleFrom !== undefined) assert.ok(step.handleFrom < i, `${task.id} step ${i} handle`); });
    for (const check of task.checks.filter(c => c.kind === 'citedFact')) assert.ok(check.kind === 'citedFact' && check.source === 'qs-hapi' && check.version === '1');
  }
  const [latest, status, drain] = tasks as [typeof tasks[0], typeof tasks[0], typeof tasks[0]];
  assert.equal(latest.checks.filter(c => c.kind === 'citedFact').length, 30, 'ten claims for each HbA1c');
  for (const path of ['valueQuantity.comparator', 'code.coding.0.version'])
    assert.ok(latest.checks.filter(c => c.kind === 'citedFact' && c.path === path).every(c => c.kind === 'citedFact' && c.absent), `${path} is claimed absent`);
  assert.ok(['support-observation', 'code-parameter-type', 'date-parameter-type', 'date-comparator-ge', 'date-comparator-lt'].every(id => latest.checks.some(c => c.id === id)), 'discovery content');
  assert.equal(status.checks.filter(c => c.kind === 'citedFact' && c.id_value === 'qs-edge-document').length, 7, 'status, type, date, content type, title and payload absence');
  for (const id of ['qs-edge-hba1c-corrected', 'qs-edge-hba1c-entered-in-error'])
    assert.equal(status.checks.filter(c => c.kind === 'citedFact' && c.id_value === id).length, 10, `${id}: the whole result's meaning, not only status and value`);
  assert.ok(drain.checks.some(c => c.kind === 'upstreamPaging' && c.page_size === 100));
  assert.deepEqual(drain.checks.filter(c => c.kind === 'retainedSlice').map(c => c.step), [1, 2, 3]);
  assert.deepEqual(drain.checks.filter(c => c.kind === 'upstreamWork' && c.clinical === 0 && c.metadata === 0).map(c => c.step), [1, 2, 3, 4], 'retained reads do no upstream work');
  assert.ok(latest.checks.some(c => c.kind === 'sortEvidence' && c.order === 'requested_unverified'), 'the latest result is reported as unverified order');
  assert.ok(status.checks.some(c => c.kind === 'citedFact' && c.id_value === 'qs-edge-document' && c.absent), 'the payload is checked absent');
  assert.ok(drain.checks.some(c => c.kind === 'resourceIdSet' && c.equals.length === 241));
  assert.ok(drain.limits?.ttlMs && drain.steps.at(-1)!.waitMs! > drain.limits.ttlMs, 'the expiry step waits past the TTL');
  assert.deepEqual(armOutput(latest, 'selected', 'fhir_search'), { format: 'fhir', fields: ['status', 'code', 'effectiveDateTime', 'valueQuantity'], max_bytes: 24576 });
  assert.deepEqual(armOutput(latest, 'selected', 'fhir_capabilities'), { format: 'fhir', max_bytes: 24576 });
  assert.deepEqual(armOutput(drain, 'compact', 'fhir_result'), { format: 'compact', max_bytes: 65536 });
});

test('package tasks: each requested parameter row is bound to Observation independently of the support response', async () => {
  const { evaluateStepCheck } = await import('../packages/evals/src/evidence-oracle.js');
  const latest = packageTasks(facts(), 'qs-hapi')[0]!;
  for (const [step, name] of [[1, 'code'], [2, 'date']] as const) {
    const check = latest.checks.find(c => c.id === `${name}-parameter-resource`)!; assert.ok(check);
    const at = (resource_type: string) => evaluateStepCheck(check, 'fhir', [{ step, envelope: {
      schema_version: '0.3', data: { resource_type, total_parameters: 1, search_parameters: [{ name }] },
      coverage: { scope: 'metadata' }, source: { alias: 'qs-hapi' }, context: { mode: 'patient-bound' },
    } as any }], { stepCount: latest.steps.length, requests: [] });
    assert.equal(at('Observation').status, 'pass'); assert.equal(at('Patient').status, 'fail', name);
  }
});
