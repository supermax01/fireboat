// Gold reader and decimal handling: lexemes survive exactly; numbers never pass through a binary float.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { createGunzip } from 'node:zlib';
import { canonicalDecimal, compareDecimal, decimalEquals, isDecimalLexeme, lexemeChangedByFloat, parseDecimal } from '../gold/decimal.js';
import { compareInstant, parseInstant, utcDate } from '../gold/fhir.js';
import { parseResource, readSyntheaBundle } from '../gold/reader.js';
import { hoursBetween, noteConditions, obsValue, quantityInfo } from '../gold/rules.js';
import { LOCAL_CONFIG, mimicDevPatients, MIMIC_FHIR_DIR, tmpDir } from '../lib/paths.js';

/** MIMIC checks need the downloaded data and the local config; a present but malformed config still fails. */
const mimicSkip = () => (!existsSync(MIMIC_FHIR_DIR) ? 'MIMIC data not downloaded' : !existsSync(LOCAL_CONFIG) ? 'no bench-config.json (see bench/README.md)' : false);

const TRICKY = ['7.0', '12.3400', '0.0', '-0.0', '1e-3', '1E+2', '2.5E-10', '9007199254740993', '12345678901234567890123', '0.10000000000000000001', '-3.0666', '112.41600000000001'];

test('parseResource keeps every number lexeme as its exact source text', () => {
  const text = `{"resourceType":"Observation","id":"x","valueQuantity":{"value":12.3400,"unit":"/min"},"component":[${TRICKY.map(t => `{"valueQuantity":{"value":${t}}}`).join(',')}]}`;
  const r = parseResource(text) as unknown as { valueQuantity: { value: unknown }; component: { valueQuantity: { value: unknown } }[] };
  assert.equal(r.valueQuantity.value, '12.3400');
  assert.deepEqual(r.component.map(c => c.valueQuantity.value), TRICKY);
  // Whitespace inside the source does not leak into lexemes (some sources write '"value": 7.0', with a space).
  assert.equal((parseResource('{"resourceType":"Observation", "id": "y", "valueQuantity": {"value": 7.0}}') as never as { valueQuantity: { value: string } }).valueQuantity.value, '7.0');
});

test('decimals: canonical form, comparison and equality are exact', () => {
  assert.equal(canonicalDecimal('12.3400'), '12.34');
  assert.equal(canonicalDecimal('7.0'), '7');
  assert.equal(canonicalDecimal('-0.0'), '0');
  assert.equal(canonicalDecimal('1e-3'), '0.001');
  assert.equal(canonicalDecimal('1E+2'), '100');
  assert.equal(canonicalDecimal('2.5E-10'), '0.00000000025');
  assert.equal(canonicalDecimal('9007199254740993'), '9007199254740993');
  assert.equal(canonicalDecimal('12345678901234567890123'), '12345678901234567890123');
  assert.equal(canonicalDecimal('0.10000000000000000001'), '0.10000000000000000001');
  assert.equal(canonicalDecimal('120.500'), '120.5');
  assert.ok(decimalEquals('5', '5.0'));
  assert.ok(decimalEquals('1e-3', '0.0010'));
  assert.ok(!decimalEquals('9007199254740993', '9007199254740992')); // equal as doubles, not as decimals
  assert.ok(!decimalEquals('0.10000000000000000001', '0.1'));
  assert.equal(compareDecimal('-3.0666', '-3.06'), -1);
  assert.equal(compareDecimal('1E+2', '99.999'), 1);
  assert.deepEqual(parseDecimal('-0.0'), { negative: false, digits: 0n, exponent: 0 });
  for (const bad of ['01', '1.', '.5', '+1', 'NaN', '1e', '']) assert.ok(!isDecimalLexeme(bad), bad);
  assert.throws(() => canonicalDecimal('1.'));
});

test('lexeme eligibility: a float round trip would change the lexeme', () => {
  for (const t of ['7.0', '12.3400', '-0.0', '1e-3', '1E+2', '9007199254740993', '0.10000000000000000001', '0.0']) assert.ok(lexemeChangedByFloat(t), t);
  for (const t of ['7', '2.9', '-3.0666', '112.41600000000001', '12.345678901234567']) assert.ok(!lexemeChangedByFloat(t), t);
  assert.ok(!lexemeChangedByFloat('NEG.'));
});

test('quantity values keep comparator, lexeme and the record unit (unit, else code)', () => {
  assert.deepEqual(quantityInfo({ value: '300', comparator: '>', unit: 'mg/dL', code: 'mg/dL', system: 's' }),
    { kind: 'quantity', value: '>300', recorded: '>300', unit: 'mg/dL', unit_code: 'mg/dL', unit_system: 's' });
  assert.equal(quantityInfo({ value: '56.7800', code: '/min' }).unit, '/min');
  assert.equal(quantityInfo({ value: '56.7800', code: '/min' }).value, '56.78');
  assert.equal(quantityInfo({ value: '1.3', system: 's' }).unit, null); // a record without a unit gains none
  assert.equal(obsValue(parseResource('{"resourceType":"Observation","id":"z","valueString":"NO GROWTH.  "}')).value, 'NO GROWTH.  ');
  assert.equal(obsValue(parseResource('{"resourceType":"Observation","id":"z","dataAbsentReason":{"text":"unknown"}}')).kind, 'none');
});

test('instants: offsets, fractions and UTC calendar days', () => {
  assert.equal(compareInstant('2125-06-11T01:30:00-05:00', '2125-06-11T02:30:00-04:00'), 0);
  assert.equal(compareInstant('2021-07-15T23:39:43.200-04:00', '2021-07-15T23:39:43.2001-04:00'), -1);
  assert.equal(utcDate('2131-05-20T22:34:00-04:00'), '2131-05-21');
  assert.equal(parseInstant('2058-07-30').precision, 'day');
  assert.throws(() => parseInstant('2131-05-20T22:34:00')); // a time without an offset is refused
  assert.equal(hoursBetween('2120-01-01T09:00:00-04:00', '2120-01-06T15:20:00-04:00'), '126.33');
  assert.equal(hoursBetween('2125-06-11T00:00:00-05:00', '2125-06-11T12:00:00-04:00'), '11');
});

test('note condition lists are split as documented', () => {
  const text = '# History of Present Illness\nX\n is a 55 year-old. Patient has a history of polyp of colon, acute viral pharyngitis (disorder).\n\n# Assessment and Plan\nPatient is presenting with otitis media. \n';
  assert.deepEqual(noteConditions(text), ['polyp of colon', 'acute viral pharyngitis (disorder)', 'otitis media']);
  assert.deepEqual(noteConditions('No complaints.'), []);
});

test('Synthea bundle reader rewrites urn:uuid references and keeps lexemes', async () => {
  await mkdir(tmpDir('bench-tests'), { recursive: true });
  const dir = await mkdtemp(join(tmpDir('bench-tests'), 'gold-'));
  try {
    const pid = '00000000-0000-0000-0000-000000000001', oid = '00000000-0000-0000-0000-000000000002', mid = '00000000-0000-0000-0000-000000000003';
    const text = `{"resourceType":"Bundle","type":"transaction","entry":[
      {"fullUrl":"urn:uuid:${pid}","resource":{"resourceType":"Patient","id":"${pid}"}},
      {"fullUrl":"urn:uuid:${mid}","resource":{"resourceType":"Medication","id":"${mid}"}},
      {"fullUrl":"urn:uuid:${oid}","resource":{"resourceType":"MedicationRequest","id":"${oid}","subject":{"reference":"urn:uuid:${pid}"},
        "medicationReference":{"reference":"urn:uuid:${mid}"},"requester":{"reference":"Practitioner?identifier=x|1"},
        "dosageInstruction":[{"doseAndRate":[{"doseQuantity":{"value":1.0}}]}]}}]}`;
    const path = join(dir, `Test_${pid}.json`);
    await writeFile(path, text);
    const sha = createHash('sha256').update(text).digest('hex');
    const b = await readSyntheaBundle(path, new Map([[basename(path), sha]]));
    assert.equal(b.data.patientId, pid);
    const mr = b.data.byRef.get(`MedicationRequest/${oid}`) as never as Record<string, any>;
    assert.equal(mr.subject.reference, `Patient/${pid}`);
    assert.equal(mr.medicationReference.reference, `Medication/${mid}`);
    assert.equal(mr.requester.reference, 'Practitioner?identifier=x|1');
    assert.equal(mr.dosageInstruction[0].doseAndRate[0].doseQuantity.value, '1.0');
    assert.equal(b.conditionalRefs, 1);
    assert.ok(b.shared.byRef.has(`Medication/${mid}`));
    await assert.rejects(readSyntheaBundle(path, new Map([[basename(path), '0'.repeat(64)]])), /checksum mismatch/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('MIMIC development records: every valueQuantity lexeme equals the raw file text', { skip: mimicSkip() }, async () => {
  const file = join(MIMIC_FHIR_DIR, 'MimicObservationVitalSignsED.ndjson.gz');
  const lines = createInterface({ input: createReadStream(file).pipe(createGunzip()), crlfDelay: Infinity });
  let checked = 0, trailing = 0;
  for await (const line of lines) {
    if (!mimicDevPatients().some(id => line.includes(id))) continue;
    const raw = /"valueQuantity": \{[^}]*"value": (-?[0-9.eE+-]+)/.exec(line)?.[1];
    if (!raw) continue;
    const r = parseResource(line) as never as { valueQuantity?: { value: string } };
    if (!r.valueQuantity) continue; // the match was inside a component
    assert.equal(r.valueQuantity.value, raw);
    checked++;
    if (/\.\d*0$/.test(raw)) trailing++;
  }
  assert.ok(checked > 0, 'no development vital signs found');
  assert.ok(trailing > 0, 'expected trailing-zero lexemes among development vital signs');
});
