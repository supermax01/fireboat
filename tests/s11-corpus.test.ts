import assert from 'node:assert/strict';
import test from 'node:test';
import { GENERATOR_PINS } from '../examples/quickstart/manifest.js';
import { candidatePins, generateCandidate, type GeneratorExecutor } from '../scripts/s11/generate.js';
import { naturalChart } from '../scripts/s11/corpus.js';
import { STUDY, completeCohort, exclusion, pool, selectPrefix, type Screening } from '../scripts/s11/study.js';
import { exportFiles, patient } from './s11-fixtures.js';

function screen(seed: number, overrides: Partial<Screening> = {}): Screening {
  return { split: 'heldout', stratum: 'large', seed, chartResources: 1000, eligibleObservations: 300, sanitizedObservationBytes: 131072, ...overrides };
}
test('S11 pools are disjoint, complete and frozen; selection requires an ordered contiguous prefix', () => {
  const all = (['development', 'heldout'] as const).flatMap(split => STUDY.strata.flatMap(s => pool(split, s)));
  assert.equal(all.length, 768); assert.equal(new Set(all).size, 768);
  assert.deepEqual(pool('heldout', 'large').slice(0, 2), [202000, 202001]);
  const rows = Array.from({ length: 10 }, (_, i) => screen(202000 + i, i === 1 ? { eligibleObservations: 299 } : {}));
  assert.deepEqual(selectPrefix(rows, 'heldout', 'large'), { fulfilled: true, selected: [202000, 202002, 202003, 202004, 202005, 202006, 202007, 202008] });
  assert.equal(selectPrefix(rows.slice(0, 8), 'heldout', 'large').fulfilled, false);
  assert.throws(() => selectPrefix([rows[1]!], 'heldout', 'large'), /SCREEN_ORDER/);
  assert.throws(() => selectPrefix([rows[0]!, rows[0]!], 'heldout', 'large'), /SCREEN_ORDER/);
});
test('S11 large eligibility enforces both exact lower bounds without looking at compact/token outcomes', () => {
  assert.equal(exclusion(screen(202000)), undefined);
  assert.equal(exclusion(screen(202000, { eligibleObservations: 299 })), 'OBSERVATION_MINIMUM');
  assert.equal(exclusion(screen(202000, { sanitizedObservationBytes: 131071 })), 'OBSERVATION_BYTE_MINIMUM');
  assert.equal(exclusion(screen(202000, { chartResources: 999 })), 'SIZE_BAND');
  assert.equal(exclusion(screen(202000, { chartResources: 30001 })), 'SIZE_BAND');
  assert.equal(exclusion(screen(202000, { failure: 'REFERENCE_UNRESOLVED' })), 'REFERENCE_UNRESOLVED');
  assert.equal(exclusion(screen(202000, { chartResources: null, eligibleObservations: null, sanitizedObservationBytes: null, failure: 'CHART_REFERENCE_UNRESOLVED' })), 'CHART_REFERENCE_UNRESOLVED');
  assert.throws(() => exclusion(screen(202000, { chartResources: null })), /SCREEN_INVALID/);
  assert.throws(() => exclusion(screen(202000, { eligibleObservations: NaN })), /SCREEN_INVALID/);
  for (const [stratum, size, expected] of [['small', 99, undefined], ['small', 100, 'SIZE_BAND'], ['medium', 100, undefined], ['medium', 1000, 'SIZE_BAND']] as const)
    assert.equal(exclusion(screen(202000, { stratum, chartResources: size, eligibleObservations: 0, sanitizedObservationBytes: 0 })), expected);
});
test('S11 cohort integrity enforces 30 disjoint patients and the exact 10/20 and 6/6/8 split', () => {
  const rows = (['development', 'heldout'] as const).flatMap(split => STUDY.strata.flatMap((stratum, i) =>
    pool(split, stratum).slice(0, STUDY[split][i]).map(seed => ({ ...screen(seed), split, stratum, chartResources: STUDY.bands[i]![0], patient: `Patient/${seed}` }))));
  assert.equal(completeCohort(rows), true);
  assert.equal(completeCohort(rows.slice(1)), false);
  assert.equal(completeCohort(rows.map((r, i) => i ? r : { ...r, patient: rows[1]!.patient })), false);
  assert.equal(completeCohort(rows.map((r, i) => i ? r : { ...r, seed: rows[1]!.seed })), false);
});
test('S11 chart size counts the full natural patient chart, excludes unrelated provider exports, and uses only the lab view for evidence', () => {
  const result = naturalChart(exportFiles());
  assert.equal(result.chartResources, 3); assert.equal(result.eligibleObservations, 1);
  assert.equal(result.chartInventory.length, 3);
  assert.ok(result.chartInventory.some(r => r.type === 'Condition'));
  assert.ok(!result.chartInventory.some(r => r.id === 'unrelated-statewide-provider'));
  assert.equal(result.patient, `Patient/${patient}`);
  assert.equal(result.seed.manifest.resources.length, 2);
  assert.ok(result.seed.ndjson.includes('"value":7.0') && result.seed.ndjson.includes('120.00'));
  assert.ok(result.sanitizedObservationBytes > 0);
  assert.ok(result.seed.manifest.resources.every(r => r.origin === 'natural'));
  assert.throws(() => naturalChart([...exportFiles(), exportFiles()[0]!]), /RAW_INPUT_INVALID/);
  const files = exportFiles(); files[0]!.bytes = Buffer.from(Buffer.from(files[0]!.bytes).toString().replace(`urn:uuid:${patient}`, 'urn:uuid:missing'));
  assert.throws(() => naturalChart(files), /RAW_RESOURCE_INVALID|CHART_REFERENCE_UNRESOLVED/);
});
function fakeExecutor(second = '7.0') {
  const commands: { file: string; args: string[] }[] = [], reads: string[] = [];
  const adapter: GeneratorExecutor = {
    inspectJar: async () => ({ path: '/cached/synthea.jar', bytes: GENERATOR_PINS.synthea.bytes, sha256: GENERATOR_PINS.synthea.sha256 }),
    createWorkspace: async () => ({ first: '/scratch/first', second: '/scratch/second', config: '/scratch/generation.properties' }),
    writeProperties: async (_path, content) => { assert.ok(content.includes('generate.thread_pool_size=1\n')); },
    run: async command => { commands.push(command); return { code: 0 }; },
    readExports: async path => { reads.push(path); return new Map([['fhir/patient.json', Buffer.from(path.endsWith('second') ? second : '7.0')]]); },
  };
  return { adapter, commands, reads };
}
const generation = { split: 'heldout', stratum: 'large', seed: 202000, jar: '/cached/synthea.jar', out: '/scratch' } as const;
test('S11 generation reuses the pinned offline command, paired seeds and exact raw comparison twice before returning inputs', async () => {
  const f = fakeExecutor(), result = await generateCandidate(generation, f.adapter);
  assert.equal(result.runs, 2); assert.equal(f.commands.length, 2); assert.deepEqual(f.reads, ['/scratch/first', '/scratch/second']);
  for (const command of f.commands) {
    const a = command.args;
    assert.equal(command.file, 'docker'); assert.equal(a[a.indexOf('--pull') + 1], 'never'); assert.equal(a[a.indexOf('--network') + 1], 'none');
    assert.ok(a.includes(`eclipse-temurin@${GENERATOR_PINS.jdk.childDigest}`));
    assert.equal(a[a.indexOf('-s') + 1], '202000'); assert.equal(a[a.indexOf('-cs') + 1], '202000'); assert.equal(a[a.indexOf('-p') + 1], '1');
    assert.equal(a[a.indexOf('-a') + 1], '60-85'); assert.ok(a.includes('--read-only') && a.includes('no-new-privileges'));
  }
  await assert.rejects(generateCandidate(generation, fakeExecutor('7').adapter), /EXPORTS_DIFFER/);
  const missingFile = fakeExecutor(); missingFile.adapter.readExports = async path => new Map(path.endsWith('second') ? [] : [['fhir/patient.json', Buffer.from('7.0')]]);
  await assert.rejects(generateCandidate(generation, missingFile.adapter), /EXPORT_INVALID/);
});
test('S11 refuses out-of-pool seeds, changed JAR bytes and failed generation without screening', async () => {
  assert.throws(() => candidatePins('heldout', 'large', 42), /SEED_OUTSIDE_POOL/);
  assert.deepEqual(candidatePins('development', 'small', 100000).generation.ages, { min: 0, max: 5 });
  const jar = fakeExecutor(); jar.adapter.inspectJar = async () => ({ path: '/bad.jar', bytes: 1, sha256: GENERATOR_PINS.synthea.sha256 });
  await assert.rejects(generateCandidate(generation, jar.adapter), /JAR_MISMATCH/); assert.equal(jar.commands.length, 0);
  const failed = fakeExecutor(); failed.adapter.run = async () => ({ code: 1 });
  await assert.rejects(generateCandidate(generation, failed.adapter), /GENERATION_FAILED/); assert.equal(failed.reads.length, 0);
});
