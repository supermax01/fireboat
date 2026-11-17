import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseFhirJson, stringifyFhir } from '../packages/core/src/decimal.js';
import { EdgeError, mergeEdges, type SeedFiles } from '../scripts/quickstart/edges.js';
import { replaceEncounterTerminology, replaceSeedTerminology, runTerminologyCli, TERMINOLOGY_SCRIPT_SHA256, TerminologyError, type TerminologyFault } from '../scripts/quickstart/terminology.js';
import { QUICKSTART_SELECTION, type SeedManifest } from '../scripts/quickstart/transform-synthea.js';

// Every code and description here is invented: the step keys on the system, never on a concept list.
type Rec = Record<string, unknown>;
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const SYSTEM = 'http://snomed.info/sct', OID = 'urn:oid:2.16.840.1.113883.6.96';
const TYPE = 'http://example.invalid/synthetic-encounter-type', REASON = 'http://example.invalid/synthetic-encounter-reason';
const P = '00000000-0000-4000-8000-000000000001';
const lab = [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'laboratory' }] }];
const coding = (code: string, display: string, system = SYSTEM) => ({ system, code, display });
const encounter = (id: string, extra: Rec = {}): Rec => ({ resourceType: 'Encounter', id, status: 'finished', subject: { reference: `Patient/${P}` }, ...extra });
const visit = (id: string, code: string, display: string, extra: Rec = {}) => encounter(id, { type: [{ coding: [coding(code, display)], text: display }], ...extra });
const observation = (id: string, extra: Rec = {}): Rec => ({ resourceType: 'Observation', id, status: 'final', category: lab, code: { coding: [{ system: 'http://loinc.org', code: '4548-4' }] },
  subject: { reference: `Patient/${P}` }, effectiveDateTime: '2023-01-01T00:00:00Z', valueQuantity: { value: 7.0, unit: '%' }, ...extra });
const patient: Rec = { resourceType: 'Patient', id: P, gender: 'female' };
const chart = (): Rec[] => [patient,
  visit('e1', '900001', 'Invented visit kind alpha (procedure)'),
  visit('e2', '900002', 'Invented visit kind beta (procedure)', { reasonCode: [{ coding: [coding('900101', 'Invented reason one (finding)', OID)] }] }),
  visit('e3', '900001', 'Invented visit kind alpha (procedure)', { reasonCode: [{ coding: [coding('900102', 'Invented reason two (situation)')] }, { coding: [coding('900101', 'Invented reason one (finding)')] }] }),
  encounter('e4', { type: [{ coding: [{ system: 'http://example.org/local', code: 'L1' }], text: 'Local visit' }] }),
  observation('o1', { encounter: { reference: 'Encounter/e3' } })];
/** A natural seed in the transform's exact output shape; `lines` overrides the serialized bodies. */
function seedOf(resources: Rec[] = chart(), lines = resources.map(r => stringifyFhir(r))): SeedFiles {
  const ndjson = lines.map(line => `${line}\n`).join('');
  const counts: Record<string, number> = {};
  for (const r of resources) counts[r.resourceType as string] = (counts[r.resourceType as string] ?? 0) + 1;
  const manifest: SeedManifest = { schema: 'fireboat-quickstart-seed/1', inputs: [{ name: 'x.json', bytes: 1, sha256: hash('x') }], selection: QUICKSTART_SELECTION,
    patient: `Patient/${P}`, counts, dropped_patient_identifiers: { SS: 0, DL: 0, PPN: 0 }, providers: { sanitized: 0, npi_identifiers_dropped: 0 },
    resources: lines.map((line, i) => ({ type: resources[i]!.resourceType as string, id: resources[i]!.id as string, bytes: Buffer.byteLength(line), sha256: hash(line), origin: 'natural' })),
    ndjson_sha256: hash(ndjson) };
  return { ndjson, manifest };
}
const refused = (resources: Rec[], code: TerminologyFault) =>
  assert.throws(() => replaceEncounterTerminology(resources), (e: unknown) => e instanceof TerminologyError && e.code === code && e.message === code, code);
const EDGES = readFileSync(new URL('../packages/evals/fixtures/quickstart/edges.json', import.meta.url));

test('quickstart terminology: Encounter type and reasonCode codings, in the system or OID form, become numbered example.invalid codings with the text following', () => {
  const seed = seedOf();
  const { ndjson, manifest } = replaceSeedTerminology(seed);
  const rows = ndjson.trimEnd().split('\n'), bodies = rows.map(line => parseFhirJson(line) as Rec);
  const byId = new Map(bodies.map(r => [r.id as string, r]));
  assert.deepEqual(byId.get('e1')!.type, [{ coding: [{ system: TYPE, code: 'encounter-type-1', display: 'Synthetic encounter type 1' }], text: 'Synthetic encounter type 1' }]);
  assert.deepEqual(byId.get('e2')!.type, [{ coding: [{ system: TYPE, code: 'encounter-type-2', display: 'Synthetic encounter type 2' }], text: 'Synthetic encounter type 2' }]);
  assert.deepEqual(byId.get('e3')!.type, byId.get('e1')!.type, 'a repeated source code keeps its synthetic code');
  assert.deepEqual(byId.get('e2')!.reasonCode, [{ coding: [{ system: REASON, code: 'encounter-reason-1', display: 'Synthetic encounter reason 1' }] }], 'the OID form is replaced; no text is added');
  assert.deepEqual(byId.get('e3')!.reasonCode, [{ coding: [{ system: REASON, code: 'encounter-reason-2', display: 'Synthetic encounter reason 2' }] },
    { coding: [{ system: REASON, code: 'encounter-reason-1', display: 'Synthetic encounter reason 1' }] }], 'reasons count apart from types, by first appearance');
  assert.deepEqual(Object.keys(byId.get('e2')!), Object.keys(chart()[2]!), 'element order is kept');
  assert.deepEqual(manifest.terminology, { schema: 'fireboat-quickstart-terminology/1', script: 'scripts/quickstart/terminology.ts',
    script_sha256: hash(readFileSync(new URL('../scripts/quickstart/terminology.ts', import.meta.url))), input_ndjson_sha256: seed.manifest.ndjson_sha256,
    replaced_codings: 6, replaced_texts: 3 });
  assert.equal(manifest.terminology.script_sha256, TERMINOLOGY_SCRIPT_SHA256, 'the record names the bytes of the step that ran');
  const input = seed.ndjson.trimEnd().split('\n');
  assert.deepEqual(rows.map((line, i) => line === input[i]), [true, false, false, false, true, true], 'rows without restricted codings are copied byte for byte');
  rows.forEach((line, i) => assert.deepEqual(manifest.resources[i], { ...seed.manifest.resources[i], bytes: Buffer.byteLength(line), sha256: hash(line) }));
  assert.equal(manifest.ndjson_sha256, hash(ndjson));
  assert.ok(!/snomed|2\.16\.840\.1\.113883\.6\.96|9001|Invented/i.test(ndjson), 'no source system, code or description remains');
  const { resources, counts, patient: owner, inputs, selection } = manifest;
  assert.deepEqual({ counts, owner, inputs, selection }, { counts: seed.manifest.counts, owner: seed.manifest.patient, inputs: seed.manifest.inputs, selection: seed.manifest.selection });
  assert.deepEqual(resources.map(r => `${r.type}/${r.id}`), seed.manifest.resources.map(r => `${r.type}/${r.id}`));
  const result = mergeEdges({ ndjson, manifest }, EDGES);
  assert.deepEqual(result.manifest.resources.length, 11, 'the edge merge accepts the output');
  assert.deepEqual((result.manifest as unknown as { terminology: unknown }).terminology, manifest.terminology, 'the merged manifest carries the record');
  const again = replaceEncounterTerminology(bodies);
  assert.deepEqual([again.replacedCodings, again.replacedTexts], [0, 0]);
  assert.ok(again.resources.every((r, i) => r === bodies[i]), 'a fixed point on its own output');
});

test('quickstart terminology: the edge merge refuses the unscrubbed seed, and the step keeps number lexemes', () => {
  assert.throws(() => mergeEdges(seedOf(), EDGES), (e: unknown) => e instanceof EdgeError && e.code === 'SEED_TERMINOLOGY_RESTRICTED');
  const lexeme = [patient, visit('e1', '900001', 'Invented kind (procedure)', { length: { value: 1.50, unit: 'h' } })];
  const lines = lexeme.map(r => stringifyFhir(r)).map(line => line.replace('"value":1.5', '"value":1.50'));
  const { ndjson } = replaceSeedTerminology(seedOf(lexeme, lines));
  assert.match(ndjson, /"length":\{"value":1\.50,"unit":"h"\}/);
});

test('quickstart terminology: restricted terminology outside Encounter type and reasonCode refuses as unmapped', () => {
  const restricted = { coding: [coding('900201', 'Invented disorder (disorder)')] };
  refused([patient, { resourceType: 'Condition', id: 'c1', subject: { reference: `Patient/${P}` }, code: restricted }], 'TERMINOLOGY_UNMAPPED');
  refused([patient, observation('o1', { valueCodeableConcept: restricted })], 'TERMINOLOGY_UNMAPPED');
  refused([patient, encounter('e1', { serviceType: restricted })], 'TERMINOLOGY_UNMAPPED');
  refused([patient, encounter('e1', { hospitalization: { admitSource: { coding: [coding('900202', 'Invented source', OID)] } } })], 'TERMINOLOGY_UNMAPPED');
  refused([patient, visit('e1', '900001', 'Invented kind (procedure)'), observation('o1', { note: [{ text: 'coded in SNOMED CT' }] })], 'TERMINOLOGY_UNMAPPED');
  assert.throws(() => replaceSeedTerminology(seedOf([patient, observation('o1', { valueCodeableConcept: restricted })])),
    (e: unknown) => e instanceof TerminologyError && e.code === 'TERMINOLOGY_UNMAPPED');
});

test('quickstart terminology: concepts and codings in the replaced fields are closed shapes', () => {
  const kind = coding('900001', 'Invented kind (procedure)');
  for (const extra of [{ version: 'http://example.invalid/edition' }, { userSelected: true }, { extension: [] }, { id: 'c' }, { display: 7 }])
    refused([encounter('e1', { type: [{ coding: [{ ...kind, ...extra }] }] })], 'TERMINOLOGY_SHAPE_INVALID');
  for (const concept of [{ coding: [kind], extension: [] }, { coding: [kind], id: 'x' }, { coding: [kind], text: 5 }, { coding: kind }, 'text', null])
    refused([encounter('e1', { reasonCode: [concept] })], 'TERMINOLOGY_SHAPE_INVALID');
  refused([encounter('e1', { type: { coding: [kind] } })], 'TERMINOLOGY_SHAPE_INVALID');
  refused([encounter('e1', { type: [{ coding: [{ system: SYSTEM, display: 'Invented kind' }] }] })], 'TERMINOLOGY_SHAPE_INVALID');
  refused([encounter('e1', { type: [{ coding: [{ system: SYSTEM, code: '' }] }] })], 'TERMINOLOGY_SHAPE_INVALID');
  refused([encounter('e1', { type: [{ coding: [{ system: 'http://example.org/local', code: 'L1', extension: [] }] }] })], 'TERMINOLOGY_SHAPE_INVALID');
  const kept = replaceEncounterTerminology([encounter('e1', { type: [{ text: 'Text only' }, { coding: [kind] }] })]);
  assert.deepEqual((kept.resources[0]!.type as Rec[])[0], { text: 'Text only' }, 'a text-only concept is left as it is');
  assert.equal(kept.replacedCodings, 1);
});

test('quickstart terminology: a removed code, description or text left anywhere refuses as residue, matched as a whole token', () => {
  const removed = visit('e1', '900001', 'Invented kind alpha (procedure)');
  refused([removed, observation('o1', { interpretation: [{ text: 'Invented kind alpha (procedure)' }] })], 'TERMINOLOGY_RESIDUE');
  refused([removed, observation('o1', { interpretation: [{ text: 'invented KIND alpha (procedure) follow-up' }] })], 'TERMINOLOGY_RESIDUE');
  refused([removed, observation('o1', { identifier: [{ system: 'http://example.org/id', value: 'ref 900001' }] })], 'TERMINOLOGY_RESIDUE');
  refused([visit('e1', '900001', 'Invented kind alpha (procedure)', { type: [{ coding: [coding('900001', 'Invented kind alpha (procedure)')], text: 'Invented free text' }] }),
    encounter('e2', { serviceProvider: { display: 'Invented free text' } })], 'TERMINOLOGY_RESIDUE');
  refused([removed, encounter('e2', { type: [{ coding: [{ system: 'http://example.org/local', code: '900001' }] }] })], 'TERMINOLOGY_RESIDUE');
  const tokens = replaceEncounterTerminology([removed, observation('o1', { identifier: [{ system: 'http://example.org/id', value: 'a9000012' }] })]);
  assert.equal(tokens.replacedCodings, 1, 'a code inside a longer token is not residue');
});

test('quickstart terminology: the input must be an intact natural seed that has not been through the step', () => {
  const seed = seedOf();
  const tampered = { ...seed, manifest: { ...seed.manifest, resources: seed.manifest.resources.map((r, i) => i === 1 ? { ...r, sha256: hash('other') } : r) } };
  assert.throws(() => replaceSeedTerminology(tampered), (e: unknown) => e instanceof EdgeError && e.code === 'SEED_INVALID');
  assert.throws(() => replaceSeedTerminology({ ...seed, ndjson: seed.ndjson.replace('"e1"', '"e9"') }), (e: unknown) => e instanceof EdgeError && e.code === 'SEED_INVALID');
  const done = replaceSeedTerminology(seed);
  assert.throws(() => replaceSeedTerminology(done), (e: unknown) => e instanceof EdgeError && e.code === 'SEED_INVALID');
});

test('quickstart terminology CLI: writes the scrubbed seed into a new directory and refuses usage, missing, invalid and non-empty paths with codes only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qs-term-'));
  try {
    const seed = seedOf(), seedDir = join(dir, 'seed'), out = join(dir, 'out');
    mkdirSync(seedDir);
    writeFileSync(join(seedDir, 'resources.ndjson'), seed.ndjson);
    writeFileSync(join(seedDir, 'seed-manifest.json'), `${JSON.stringify(seed.manifest, null, 2)}\n`);
    const result = replaceSeedTerminology(seed);
    assert.deepEqual(runTerminologyCli([seedDir, out]), { code: 0, line: `quickstart-terminology: 6 resources; 6 codings and 3 texts replaced; ndjson sha256 ${result.manifest.ndjson_sha256}` });
    assert.equal(readFileSync(join(out, 'resources.ndjson'), 'utf8'), result.ndjson);
    assert.equal(readFileSync(join(out, 'seed-manifest.json'), 'utf8'), `${JSON.stringify(result.manifest, null, 2)}\n`);
    const failed = (code: string) => ({ code: 1, line: `quickstart-terminology: ${code}` });
    assert.deepEqual(runTerminologyCli([seedDir, out]), failed('OUT_NOT_EMPTY'));
    assert.deepEqual(runTerminologyCli([seedDir]), failed('USAGE'));
    assert.deepEqual(runTerminologyCli([seedDir, join(dir, 'x'), 'extra']), failed('USAGE'));
    assert.deepEqual(runTerminologyCli([join(dir, 'absent'), join(dir, 'x')]), failed('INPUT_MISSING'));
    assert.deepEqual(runTerminologyCli([out, join(dir, 'x')]), failed('SEED_INVALID'), 'the step\'s own output is not a natural seed');
    const unmapped = join(dir, 'unmapped'), bad = seedOf([patient, observation('o1', { valueCodeableConcept: { coding: [coding('900201', 'Invented')] } })]);
    mkdirSync(unmapped);
    writeFileSync(join(unmapped, 'resources.ndjson'), bad.ndjson);
    writeFileSync(join(unmapped, 'seed-manifest.json'), JSON.stringify(bad.manifest));
    assert.deepEqual(runTerminologyCli([unmapped, join(dir, 'y')]), failed('TERMINOLOGY_UNMAPPED'));
    writeFileSync(join(unmapped, 'seed-manifest.json'), '{');
    assert.deepEqual(runTerminologyCli([unmapped, join(dir, 'y')]), failed('SEED_INVALID'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
