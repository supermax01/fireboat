import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, symlinkSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseFhirJson } from '../packages/core/src/decimal.js';
import { QUICKSTART_SELECTION, TransformError, checkSeedContract, runTransformCli, transformSyntheaExport, utcInterval, type ExportFile, type TransformFault } from '../scripts/quickstart/transform-synthea.js';

type Rec = Record<string, unknown>;
const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const P = u(1), Q = u(2), E = u(10), L1 = u(20), L2 = u(21), L3 = u(22), V1 = u(23), D1 = u(30), D2 = u(31), C1 = u(40), QL = u(50), ORG = u(60), LOC = u(61), PR = u(70);
const NPI = 'http://hl7.org/fhir/sid/us-npi', SYN = 'https://github.com/synthetichealth/synthea';
const SSN = '999-55-0123', DL = 'S99950123', PPN = 'X99950123X';
const lab = [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'laboratory' }] }];
const vital = [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs' }] }];
const labReport = [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0074', code: 'LAB' }] }];
const ref = (id: string) => ({ reference: `urn:uuid:${id}` });
const typed = (code: string) => ({ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code }] });
const labObs = (id: string, effectiveDateTime: string, value: string, extra: Rec = {}): Rec => ({ resourceType: 'Observation', id, status: 'final', category: lab,
  code: { coding: [{ system: 'http://loinc.org', code: '4548-4' }] }, subject: ref(P), encounter: ref(E), effectiveDateTime, valueQuantity: { value: `@${value}@`, unit: '%' }, ...extra });

/** Raw export bytes; numbers are written as raw JSON so `7.00`, an 18-digit fraction and `1E+02` reach the reader exactly. */
function exportFiles(edit: (r: Record<string, Rec>) => void = () => {}): ExportFile[] {
  const r: Record<string, Rec> = {
    P: { resourceType: 'Patient', id: P, identifier: [{ system: SYN, value: P }, { type: typed('MR'), system: 'http://hospital.smarthealthit.org', value: P },
      { type: typed('SS'), system: 'http://hl7.org/fhir/sid/us-ssn', value: SSN }, { type: typed('DL'), system: 'urn:oid:2.16.840.1.113883.4.3.25', value: DL },
      { type: typed('PPN'), system: 'http://hl7.org/fhir/sid/passport-USA', value: PPN }], name: [{ family: 'Synthetic', given: ['Quick', 'Zoë'] }], gender: 'female' },
    E: { resourceType: 'Encounter', id: E, status: 'finished', subject: ref(P), participant: [{ individual: { reference: `Practitioner?identifier=${NPI}|9990000001` } }],
      serviceProvider: { reference: `Organization?identifier=${SYN}|${ORG}` }, location: [{ location: { reference: `Location?identifier=${SYN}|${LOC}` } }] },
    L1: labObs(L1, '2020-01-01T09:00:00-05:00', '7.00', { referenceRange: [{ low: { value: '@1E+02@' } }] }),
    L2: labObs(L2, '2025-12-31T23:59:59Z', '0.123456789012345678', { code: { coding: [{ system: 'http://loinc.org', code: '2339-0' }] } }),
    L3: labObs(L3, '2026-01-01T00:00:00Z', '6.20'),
    V1: { ...labObs(V1, '2023-05-05T10:00:00Z', '170.10'), category: vital },
    D1: { resourceType: 'DiagnosticReport', id: D1, status: 'final', category: labReport, subject: ref(P), encounter: ref(E), effectiveDateTime: '2023-01-01T00:00:00Z', result: [ref(L1), ref(L2)] },
    D2: { resourceType: 'DiagnosticReport', id: D2, status: 'final', category: labReport, subject: ref(P), encounter: ref(E), effectiveDateTime: '2023-01-01T00:00:00Z', result: [ref(L1), ref(L3)] },
    C1: { resourceType: 'Claim', id: C1, patient: ref(P), item: [{ encounter: [ref(E)] }] },
    Q: { resourceType: 'Patient', id: Q, deceasedDateTime: '2019-02-02T00:00:00Z', identifier: [{ system: SYN, value: Q }] },
    QL: { ...labObs(QL, '2021-01-01T00:00:00Z', '5.9'), subject: ref(Q), encounter: undefined },
    ORG: { resourceType: 'Organization', id: ORG, identifier: [{ system: SYN, value: ORG }], name: 'Synthetic Hospital' },
    LOC: { resourceType: 'Location', id: LOC, identifier: [{ system: SYN, value: LOC }], name: 'Synthetic Clinic', managingOrganization: { reference: `Organization?identifier=${SYN}|${ORG}` } },
    PR: { resourceType: 'Practitioner', id: PR, identifier: [{ system: NPI, value: '9990000001' }], name: [{ family: 'Clinician707', given: ['Quick891'], prefix: ['Dr.'] }] },
  };
  edit(r);
  // Synthea's shapes: patient files are transactions; the shared files are conditional-create batches.
  const bundle = (keys: string[], type = 'transaction') => Buffer.from(JSON.stringify({ resourceType: 'Bundle', type, entry: keys.filter(k => r[k]).map(k => ({
    fullUrl: `urn:uuid:${r[k]!.id}`, resource: r[k], request: { method: 'POST', url: r[k]!.resourceType } })) }).replace(/"@([-0-9.eE+]+)@"/g, '$1'));
  return [
    { name: 'Quick_Synthetic_patient.json', bytes: bundle(['P', 'E', 'L1', 'L2', 'L3', 'V1', 'D1', 'D2', 'C1', ...Object.keys(r).filter(k => k.startsWith('X'))]) },
    { name: 'Other_Synthetic_patient.json', bytes: bundle(['Q', 'QL']) },
    { name: 'hospitalInformation1767225600000.json', bytes: bundle(['ORG', 'LOC'], 'batch') },
    { name: 'practitionerInformation1767225600000.json', bytes: bundle(['PR'], 'batch') },
  ];
}
const refused = (files: ExportFile[], code: TransformFault, selection = QUICKSTART_SELECTION) =>
  assert.throws(() => transformSyntheaExport(files, selection), (e: unknown) => e instanceof TransformError && e.code === code && e.message === code);
const lines = (ndjson: string) => ndjson.trimEnd().split('\n');
const put = (r: { type: string; id: string }) => `${r.type}/${r.id}`;
const puts = (files: ExportFile[]) => transformSyntheaExport(files).manifest.resources.map(put);
const createHashHex = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const text = (file: ExportFile) => Buffer.from(file.bytes).toString('utf8');
const PROVIDERS = ['Organization', 'Location', 'Practitioner', 'PractitionerRole'] as const;
const ROLE = u(72);
function providerFiles(type: typeof PROVIDERS[number], edit: (provider: Rec, resources: Record<string, Rec>) => void): ExportFile[] {
  return exportFiles(r => {
    r.E!.participant = [{ individual: ref(PR) }]; r.E!.serviceProvider = ref(ORG); r.E!.location = [{ location: ref(LOC) }];
    r.LOC!.managingOrganization = ref(ORG);
    if (type === 'PractitionerRole') {
      r.XRole = { resourceType: type, id: ROLE, practitioner: ref(PR), organization: ref(ORG), location: [ref(LOC)] };
      r.L1!.performer = [ref(ROLE)];
    }
    edit(r[{ Organization: 'ORG', Location: 'LOC', Practitioner: 'PR', PractitionerRole: 'XRole' }[type]]!, r);
  });
}

test('quickstart transform selects the living patient\'s in-window lab slice, closes its references and emits fixed-id PUTs in dependency order', () => {
  const { ndjson, manifest } = transformSyntheaExport(exportFiles());
  assert.deepEqual(manifest.resources.map(put), [`Organization/${ORG}`, `Location/${LOC}`, `Practitioner/${PR}`, `Patient/${P}`, `Encounter/${E}`,
    `Observation/${L1}`, `Observation/${L2}`, `DiagnosticReport/${D1}`]);
  assert.equal(manifest.patient, `Patient/${P}`);
  assert.deepEqual(manifest.counts, { Organization: 1, Location: 1, Practitioner: 1, Patient: 1, Encounter: 1, Observation: 2, DiagnosticReport: 1 });
  assert.ok(manifest.resources.every(r => r.origin === 'natural'));
  assert.ok(!ndjson.includes('urn:uuid:') && !ndjson.includes('?identifier='), 'every reference is rewritten to Type/id');
  const parsed = lines(ndjson).map(line => parseFhirJson(line) as Rec);
  parsed.forEach((resource, i) => assert.equal(`${resource.resourceType}/${resource.id}`, put(manifest.resources[i]!)));
  const byPut = new Map(parsed.map(r => [`${r.resourceType}/${r.id}`, r]));
  const encounter = byPut.get(`Encounter/${E}`)!;
  assert.deepEqual(encounter.subject, { reference: `Patient/${P}` });
  assert.deepEqual(encounter.participant, [{ individual: { reference: `Practitioner/${PR}` } }]);
  assert.deepEqual(encounter.serviceProvider, { reference: `Organization/${ORG}` });
  assert.deepEqual((byPut.get(`Location/${LOC}`)!).managingOrganization, { reference: `Organization/${ORG}` });
  assert.deepEqual((byPut.get(`DiagnosticReport/${D1}`)!).result, [{ reference: `Observation/${L1}` }, { reference: `Observation/${L2}` }]);
});

test('quickstart transform window is a half-open UTC interval: offsets count, partial dates and Periods must lie wholly inside', () => {
  const base = puts(exportFiles());
  assert.ok(base.includes(`Observation/${L1}`) && base.includes(`Observation/${L2}`));
  assert.ok(!base.includes(`Observation/${L3}`), 'the end instant is excluded');
  assert.ok(!base.includes(`Observation/${V1}`), 'vital signs are not lab Observations');
  assert.ok(!base.includes(`DiagnosticReport/${D2}`), 'a report with an out-of-window result is excluded, not truncated');
  assert.ok(!base.includes(`Claim/${C1}`) && !base.includes(`Patient/${Q}`) && !base.includes(`Observation/${QL}`));
  const at = (effective: Rec) => puts(exportFiles(r => { delete r.L2!.effectiveDateTime; Object.assign(r.L2!, effective); })).includes(`Observation/${L2}`);
  assert.equal(at({ effectiveDateTime: '2025-12-31T23:30:00-05:00' }), false, 'after the UTC end once the offset is applied');
  assert.equal(at({ effectiveDateTime: '2020-01-01T01:00:00+02:00' }), false, 'before the UTC start once the offset is applied');
  assert.equal(at({ effectiveDateTime: '2025-12-31' }), true);
  assert.equal(at({ effectiveDateTime: '2023' }), true, 'a whole in-window year');
  assert.equal(at({ effectiveDateTime: '2019' }), false);
  assert.equal(at({ effectiveDateTime: '2025-12' }), true);
  assert.equal(at({ effectivePeriod: { start: '2021-01-01T00:00:00Z', end: '2021-01-02T00:00:00Z' } }), true);
  assert.equal(at({ effectivePeriod: { start: '2019-12-31T00:00:00Z', end: '2020-01-02T00:00:00Z' } }), false, 'a period straddling the start');
  assert.equal(at({ effectivePeriod: { start: '2021-01-01T00:00:00Z' } }), false, 'an open period');
  const midYear = { ...QUICKSTART_SELECTION, window: { start: '2020-01-01', end: '2025-06-15' } };
  const partial = (value: string) => transformSyntheaExport(exportFiles(r => { r.L2!.effectiveDateTime = value; }), midYear).manifest.resources.map(put).includes(`Observation/${L2}`);
  assert.equal(partial('2025-06'), false, 'a month that runs past the end is not inside');
  assert.equal(partial('2025-05'), true);
  assert.equal(partial('2025'), false, 'a year that runs past the end is not inside');
  assert.deepEqual(utcInterval('2020-01-01T00:00:00.5+01:00'), [Date.UTC(2019, 11, 31, 23, 0, 0, 500), Date.UTC(2019, 11, 31, 23, 0, 0, 501)]);
});

test('quickstart transform refuses invalid lab dates and reversed periods', () => {
  for (const effective of [{ effectiveDateTime: '2023-02-30' }, { effectiveDateTime: '2023-01-01T10:00:00Z junk' }, { effectiveDateTime: '2023-01-01T10:00:00' },
    { effectiveDateTime: '2023-13-01' }, { effectiveDateTime: '2023-01-01T24:00:00Z' }, { effectivePeriod: { start: '2022-01-02T00:00:00Z', end: '2022-01-01T00:00:00Z' } }])
    refused(exportFiles(r => { delete r.L2!.effectiveDateTime; Object.assign(r.L2!, effective); }), 'DATE_INVALID');
  for (const effective of [{ effectiveDateTime: '2023-01-01T10:00:00+14:59' }, { effectivePeriod: { start: '2022-01-01T00:00:00.001Z', end: '2022-01-01T00:00:00.000Z' } },
    { effectivePeriod: { start: '2022-01-02', end: '2022-01-01' } }, { effectivePeriod: { start: '2025-01-01T00:00:00.0009Z', end: '2025-01-01T00:00:00.0001Z' } },
    { effectivePeriod: { start: '2025-01-01T00:00:00.0000000009Z', end: '2025-01-01T00:00:00.0000000001Z' } }])
    refused(exportFiles(r => { delete r.L2!.effectiveDateTime; Object.assign(r.L2!, effective); }), 'DATE_INVALID');
  assert.ok(puts(exportFiles(r => { r.L2!.effectiveDateTime = '2023-01-01T10:00:00+14:00'; })).includes(`Observation/${L2}`), 'the largest valid offset');
  assert.ok(puts(exportFiles(r => { r.L2!.effectiveDateTime = '2023-01-01T00:00:00.1234567890Z'; })).includes(`Observation/${L2}`), 'any number of fraction digits');
  const year = (y: number) => { const d = new Date(0); d.setUTCFullYear(y, 0, 1); return d.getTime(); };
  assert.deepEqual(utcInterval('0099'), [year(99), year(100)], 'years 0-99 are not shifted into the 1900s');
  assert.deepEqual(utcInterval('0024-03-01'), [year(24) + 60 * 86_400_000, year(24) + 61 * 86_400_000], 'year 24 is a leap year');
});

test('quickstart transform keeps every number lexeme exactly (7.00, 18 fraction digits, 1E+02) and hashes inputs and NDJSON lines', () => {
  const files = exportFiles();
  const { ndjson, manifest } = transformSyntheaExport(files);
  assert.match(ndjson, /"value":7\.00,/);
  assert.match(ndjson, /"value":0\.123456789012345678,/);
  assert.match(ndjson, /"low":\{"value":1E\+02\}/);
  lines(ndjson).forEach((line, i) => {
    assert.equal(manifest.resources[i]!.sha256, createHashHex(line));
    assert.equal(manifest.resources[i]!.bytes, Buffer.byteLength(line));
  });
  assert.equal(manifest.ndjson_sha256, createHashHex(ndjson));
  const byName = new Map(files.map(f => [f.name, f]));
  for (const input of manifest.inputs) {
    assert.equal(input.sha256, createHashHex(byName.get(input.name)!.bytes), input.name);
    assert.equal(input.bytes, byName.get(input.name)!.bytes.byteLength);
  }
});

test('quickstart transform refuses invalid UTF-8 instead of replacing it, and never echoes parser text', () => {
  const files = exportFiles();
  const bytes = Buffer.from(files[0]!.bytes);
  const at = bytes.indexOf(Buffer.from('Synthetic'));
  bytes[at] = 0xff;
  refused([{ ...files[0]!, bytes }, ...files.slice(1)], 'EXPORT_INVALID');
  refused([{ name: 'broken.json', bytes: Buffer.from('{"resourceType": secret-text') }, ...files], 'EXPORT_INVALID');
});

test('quickstart transform drops the synthetic SSN, licence and passport identifiers in every form and refuses any decoded residue', () => {
  const { ndjson, manifest } = transformSyntheaExport(exportFiles());
  assert.deepEqual(manifest.dropped_patient_identifiers, { SS: 1, DL: 1, PPN: 1 });
  for (const value of [SSN, DL, PPN]) assert.ok(!ndjson.includes(value));
  const patient = lines(ndjson).map(l => JSON.parse(l) as Rec).find(r => r.resourceType === 'Patient')!;
  assert.deepEqual((patient.identifier as Rec[]).map(i => i.system), [SYN, 'http://hospital.smarthealthit.org']);
  const dropped = (identifier: Rec) => transformSyntheaExport(exportFiles(r => { (r.P!.identifier as Rec[]).push(identifier); })).manifest.dropped_patient_identifiers;
  assert.equal(dropped({ system: 'http://hl7.org/fhir/sid/us-ssn', value: '999-55-7777' }).SS, 2, 'system-only SSN');
  assert.equal(dropped({ system: 'http://hl7.org/fhir/sid/passport-USA', value: 'X99957777X' }).PPN, 2, 'system-only passport');
  assert.equal(dropped({ system: 'urn:oid:2.16.840.1.113883.4.3.6', value: 'S99957777' }).DL, 2, 'another state licence OID');
  assert.equal(dropped({ type: { coding: [{ code: 'SS' }] }, system: 'urn:example:other', value: '999-55-8888' }).SS, 2, 'a type code without a coding system');
  for (const kind of ['SS', 'DL', 'PPN'] as const)
    assert.equal(dropped({ type: typed(kind), value: `T-${kind}-777777` })[kind], 2, `a typed ${kind} identifier without Identifier.system`);
  const residue = (div: string) => exportFiles(r => { r.P!.text = { status: 'generated', div: `<div xmlns="http://www.w3.org/1999/xhtml">${div}</div>` }; });
  refused(residue(`SSN ${SSN}`), 'IDENTIFIER_RESIDUE');
  refused(residue('SSN &#57;99-55-0123'), 'IDENTIFIER_RESIDUE');
  refused(residue('SSN 999-<b>55</b>-0123'), 'IDENTIFIER_RESIDUE');
  refused(exportFiles(r => { r.P!.name = [{ family: 'Synthetic', given: [`a "${DL}" b`] }]; }), 'IDENTIFIER_RESIDUE');
  refused(residue(`<span title="${DL}">licence</span>`), 'IDENTIFIER_RESIDUE');
  refused(residue(`999-<span title="a>b">55</span>-0123`), 'IDENTIFIER_RESIDUE');
  refused(residue(`S9995<!-- ' -->0123 is split by a comment`), 'IDENTIFIER_RESIDUE');
  refused(residue(`999-<![CDATA[55]]>-0123`), 'IDENTIFIER_RESIDUE');
  refused(residue('an unterminated <!-- comment'), 'EXPORT_INVALID');
  refused(residue('a <?pi ?> instruction'), 'EXPORT_INVALID');
  assert.equal(transformSyntheaExport(exportFiles(r => { r.L2!.effectivePeriod = { start: '2025-01-01T00:00:00.0001Z', end: '2025-01-01T00:00:00.0009Z' }; delete r.L2!.effectiveDateTime; })).manifest.resources.length, 8, 'a forward sub-millisecond period is fine');
  refused(residue('bad &#x110000; entity'), 'EXPORT_INVALID');
  refused(residue('surrogate &#55296; entity'), 'EXPORT_INVALID');
  assert.equal(transformSyntheaExport(residue(`${DL}Z is another token`)).manifest.resources.length, 8, 'a longer token containing the value is not residue');
});

test('quickstart transform accepts an export bundle larger than one bounded precision walk, and refuses a resource too deep to walk', () => {
  const filler = Array.from({ length: 1200 }, (_, i) => ({ fullUrl: `urn:uuid:${u(100000 + i)}`, resource: { ...labObs(u(100000 + i), '2010-01-01T00:00:00Z', '1.5'), category: vital,
    component: Array.from({ length: 20 }, () => ({ code: { text: 'x' }, valueQuantity: { value: 1.5 } })) } }));
  const files = exportFiles();
  const big = JSON.parse(text(files[0]!).replace(/"value":([-0-9.eE+]+)/g, '"value":"@$1@"')) as { entry: unknown[] };
  big.entry.push(...filler);
  const bytes = Buffer.from(JSON.stringify(big).replace(/"@([-0-9.eE+]+)@"/g, '$1'));
  const { ndjson } = transformSyntheaExport([{ ...files[0]!, bytes }, ...files.slice(1)]);
  assert.match(ndjson, /"value":7\.00,/);
  assert.ok(!ndjson.includes(u(100000)), 'out-of-window vital signs stay out of the seed');
  let deep: Rec = { value: 1 };
  for (let i = 0; i < 70; i++) deep = { extension: [{ url: 'urn:example:x', valueString: 'x', nested: deep }] };
  refused(exportFiles(r => { r.V1!.extension = [deep]; }), 'PRECISION_LOST');
});

test('quickstart transform is deterministic: input order and repetition do not change a byte', () => {
  const a = transformSyntheaExport(exportFiles());
  const b = transformSyntheaExport([...exportFiles()].reverse());
  assert.equal(b.ndjson, a.ndjson);
  assert.deepEqual(b.manifest, a.manifest);
});

test('quickstart transform resolves every reference before selection: an identifier-search subject selects the same slice', () => {
  const viaIdentifier = transformSyntheaExport(exportFiles(r => { r.L1!.subject = { reference: `Patient?identifier=${SYN}|${P}` }; }));
  assert.ok(viaIdentifier.manifest.resources.map(put).includes(`Observation/${L1}`));
  assert.match(viaIdentifier.ndjson, new RegExp(`"id":"${L1}"[^\\n]*"subject":\\{"reference":"Patient/${P}"\\}`));
  assert.equal(transformSyntheaExport(exportFiles(r => { r.ORG!.identifier = [{ system: SYN, value: ORG }, { system: SYN, value: ORG }]; })).manifest.resources.length, 8,
    'two equal identifiers on one resource are not ambiguous');
});

test('quickstart transform refuses unresolved, ambiguous, foreign, logical and mistyped references, in extensions too', () => {
  refused(exportFiles(r => { r.L1!.performer = [ref(u(999))]; }), 'REFERENCE_UNRESOLVED');
  refused(exportFiles(r => { r.L1!.extension = [{ url: 'urn:example:x', valueReference: ref(u(999)) }]; }), 'REFERENCE_UNRESOLVED');
  refused(exportFiles(r => { r.E!.serviceProvider = { reference: `Organization?identifier=${SYN}|org-missing` }; }), 'REFERENCE_UNRESOLVED');
  refused(exportFiles(r => { r.X1 = { ...r.PR!, id: u(71) }; }), 'REFERENCE_AMBIGUOUS');
  refused(exportFiles(r => { r.L1!.performer = [{ reference: `Practitioner/${PR}` }]; }), 'REFERENCE_FOREIGN');
  refused(exportFiles(r => { r.L1!.performer = [{ reference: 'https://example.invalid/fhir/Practitioner/1' }]; }), 'REFERENCE_FOREIGN');
  refused(exportFiles(r => { r.E!.serviceProvider = { reference: `Organization?identifier=${SYN}|org-1&active=false` }; }), 'REFERENCE_FOREIGN');
  refused(exportFiles(r => { r.L1!.extension = [{ url: 'urn:example:x', valueUri: `urn:uuid:${PR}` }]; }), 'REFERENCE_FOREIGN');
  refused(exportFiles(r => { r.E!.subject = { identifier: { system: SYN, value: Q } }; }), 'REFERENCE_LOGICAL');
  refused(exportFiles(r => { r.L1!.subject = { identifier: { system: SYN, value: P } }; }), 'REFERENCE_LOGICAL');
  refused(exportFiles(r => { r.D1!.result = [ref(L1), { identifier: { system: SYN, value: L2 } }]; }), 'REFERENCE_LOGICAL');
  refused(exportFiles(r => { r.D1!.result = [ref(L1), { display: 'a result' }]; }), 'REFERENCE_UNRESOLVED');
  refused(exportFiles(r => { r.E!.serviceProvider = { reference: `Organization?identifier=${SYN}|org%2D1` }; }), 'REFERENCE_FOREIGN');
  refused(exportFiles(r => { r.L1!.extension = [{ url: 'urn:example:x', valueReference: { identifier: { system: SYN, value: Q } } }]; }), 'REFERENCE_LOGICAL');
  refused(exportFiles(r => { r.E!.serviceProvider = { reference: `Organization?identifier=${SYN}|${ORG}`, type: 'Practitioner' }; }), 'REFERENCE_TYPE_MISMATCH');
  assert.equal(transformSyntheaExport(exportFiles(r => { r.E!.serviceProvider = { reference: `Organization?identifier=${SYN}|${ORG}`, type: 'Organization' }; })).manifest.resources.length, 8);
});

test('quickstart transform refuses contained resources and local references outright', () => {
  refused(exportFiles(r => { r.L1!.contained = [{ resourceType: 'Specimen', id: 'sp1' }]; r.L1!.specimen = { reference: '#sp1' }; }), 'CONTAINED_REFUSED');
  refused(exportFiles(r => { r.L1!.contained = [{ resourceType: 'Patient', id: 'p2' }]; }), 'CONTAINED_REFUSED');
  refused(exportFiles(r => { r.L1!.derivedFrom = [{ reference: '#missing' }]; }), 'CONTAINED_REFUSED');
});

test('quickstart transform refuses a closure that reaches another patient, a disallowed type, or a clinical resource outside the slice', () => {
  refused(exportFiles(r => { r.L1!.hasMember = [ref(QL)]; }), 'SLICE_VIOLATION');
  refused(exportFiles(r => { r.X3 = { resourceType: 'Encounter', id: u(12), status: 'finished', subject: ref(Q) }; r.L1!.encounter = ref(u(12)); }), 'FOREIGN_PATIENT');
  refused(exportFiles(r => { r.P!.link = [{ other: ref(Q), type: 'seealso' }]; }), 'FOREIGN_PATIENT');
  refused(exportFiles(r => { r.X3 = { resourceType: 'Encounter', id: u(12), status: 'finished' }; r.L1!.encounter = ref(u(12)); }), 'FOREIGN_PATIENT');
  refused(exportFiles(r => { r.E!.account = [ref(C1)]; }), 'TYPE_NOT_ALLOWED');
  refused(exportFiles(r => { r.L1!.derivedFrom = [ref(D2)]; }), 'SLICE_VIOLATION');
  refused(exportFiles(r => { r.L1!.hasMember = [ref(L3)]; }), 'SLICE_VIOLATION');
});

test('quickstart transform orders by the reference graph, not by type and id alone', () => {
  const order = puts(exportFiles(r => { r.L1!.hasMember = [ref(L2)]; }));
  assert.ok(order.indexOf(`Observation/${L2}`) < order.indexOf(`Observation/${L1}`), 'the referenced Observation is written first despite its larger id');
});

test('quickstart transform order equals an independent rule: repeatedly write the smallest (type order, id) whose targets are written', () => {
  const extra = [u(29), u(24), u(27), u(25), u(28)];
  const files = exportFiles(r => {
    extra.forEach((id, i) => { r[`X${i}`] = labObs(id, '2022-02-02T00:00:00Z', '4.1'); });
    r.D1!.result = [ref(L1), ref(L2), ...extra.map(ref)];
    r[`X9`] = labObs(u(26), '2022-02-02T00:00:00Z', '4.2', { hasMember: [ref(u(29))] });
  });
  const { ndjson, manifest } = transformSyntheaExport(files);
  const typeOrder = ['Organization', 'Location', 'Practitioner', 'PractitionerRole', 'Patient', 'Encounter', 'Condition', 'Observation', 'DiagnosticReport'];
  const nodes = lines(ndjson).map(l => JSON.parse(l) as Rec).map(r => ({ key: `${r.resourceType}/${r.id}`, rank: [typeOrder.indexOf(r.resourceType as string), r.id as string] as const,
    deps: new Set([...l2refs(r)].filter(k => k !== `${r.resourceType}/${r.id}`)) }));
  const written = new Set<string>(), expected: string[] = [];
  while (expected.length < nodes.length) {
    const next = nodes.filter(n => !written.has(n.key) && [...n.deps].every(d => written.has(d)))
      .sort((a, b) => a.rank[0] - b.rank[0] || (a.rank[1] < b.rank[1] ? -1 : 1))[0]!;
    written.add(next.key); expected.push(next.key);
  }
  assert.deepEqual(manifest.resources.map(put), expected);
});
function l2refs(node: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(node)) node.forEach(child => l2refs(child, out));
  else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) { if (k === 'reference' && typeof v === 'string') out.add(v); else l2refs(v, out); }
  return out;
}

test('quickstart transform refuses reference cycles, including a self-reference', () => {
  refused(exportFiles(r => { r.X2 = { resourceType: 'Encounter', id: u(11), status: 'finished', subject: ref(P), partOf: ref(E) }; r.E!.partOf = ref(u(11)); }), 'REFERENCE_CYCLE');
  refused(exportFiles(r => { r.E!.partOf = ref(E); }), 'REFERENCE_CYCLE');
});

test('quickstart transform refuses anything but exactly one living patient', () => {
  refused(exportFiles(r => { delete r.Q!.deceasedDateTime; }), 'PATIENT_SELECTION');
  refused(exportFiles(r => { r.P!.deceasedBoolean = true; }), 'PATIENT_SELECTION');
  assert.equal(transformSyntheaExport(exportFiles(r => { r.P!.deceasedBoolean = false; })).manifest.patient, `Patient/${P}`);
});

test('quickstart transform refuses malformed exports, duplicate ids and invalid ids', () => {
  const files = exportFiles();
  refused([...files, { name: 'zz-duplicate.json', bytes: files[3]!.bytes }], 'DUPLICATE_ID');
  refused([{ name: 'collection.json', bytes: Buffer.from(text(files[0]!).replace('"type":"transaction"', '"type":"collection"')) }, ...files.slice(1)], 'EXPORT_INVALID');
  refused([{ name: 'p.json', bytes: Buffer.from(text(files[0]!).replace(`"fullUrl":"urn:uuid:${E}"`, `"fullUrl":"urn:uuid:${u(12)}"`)) }, ...files.slice(1)], 'EXPORT_INVALID');
  refused([{ name: 'bad-id.json', bytes: Buffer.from(JSON.stringify({ resourceType: 'Bundle', type: 'transaction', entry: [{ fullUrl: 'urn:uuid:bad id!', resource: { resourceType: 'Organization', id: 'bad id!' } }] })) }, ...files], 'ID_INVALID');
});

test('quickstart transform bounds inputs, resources and NDJSON bytes (newlines included), refusing early on oversize slices', () => {
  const files = exportFiles();
  const { ndjson, manifest } = transformSyntheaExport(files);
  refused(files, 'SEED_TOO_LARGE', { ...QUICKSTART_SELECTION, maxResources: 7 });
  const bodies = manifest.resources.reduce((n, r) => n + r.bytes, 0);
  refused(files, 'SEED_TOO_LARGE', { ...QUICKSTART_SELECTION, maxBytes: bodies });
  assert.equal(transformSyntheaExport(files, { ...QUICKSTART_SELECTION, maxBytes: Buffer.byteLength(ndjson) }).ndjson, ndjson);
  refused(files, 'INPUT_TOO_LARGE', { ...QUICKSTART_SELECTION, maxInputBytes: 100 });
  const many = exportFiles(r => { for (let i = 0; i < 2000; i++) r[`X${i}`] = labObs(u(200000 + i), '2022-06-01T00:00:00Z', '5.5'); });
  refused(many, 'SEED_TOO_LARGE', { ...QUICKSTART_SELECTION, maxResources: 50 });
});

test('quickstart transform CLI writes the seed into an empty directory and reports only counts and the NDJSON hash; every preflight failure is a fixed code', () => {
  const root = mkdtempSync(join(tmpdir(), 'qs-transform-'));
  try {
    const exportDir = join(root, 'fhir'); mkdirSync(exportDir);
    for (const f of exportFiles()) writeFileSync(join(exportDir, f.name), f.bytes);
    const out = join(root, 'seed');
    const ok = runTransformCli([exportDir, out]);
    assert.equal(ok.code, 0);
    const manifest = JSON.parse(readFileSync(join(out, 'seed-manifest.json'), 'utf8')) as { ndjson_sha256: string; resources: unknown[] };
    assert.equal(createHashHex(readFileSync(join(out, 'resources.ndjson'))), manifest.ndjson_sha256);
    assert.equal(ok.line, `transform-synthea: 8 resources (Organization 1, Location 1, Practitioner 1, Patient 1, Encounter 1, Observation 2, DiagnosticReport 1); ndjson sha256 ${manifest.ndjson_sha256}`);
    assert.ok(!ok.line.includes(root) && !ok.line.includes(P));
    assert.deepEqual(runTransformCli([exportDir, out]), { code: 1, line: 'transform-synthea: OUT_NOT_EMPTY' });
    writeFileSync(join(root, 'a-file'), 'x');
    assert.deepEqual(runTransformCli([exportDir, join(root, 'a-file')]), { code: 1, line: 'transform-synthea: OUT_NOT_EMPTY' });
    assert.deepEqual(runTransformCli([join(root, 'a-file'), join(root, 'o1')]), { code: 1, line: 'transform-synthea: EXPORT_MISSING' });
    assert.deepEqual(runTransformCli([join(root, 'missing'), join(root, 'o2')]), { code: 1, line: 'transform-synthea: EXPORT_MISSING' });
    assert.deepEqual(runTransformCli([exportDir]), { code: 1, line: 'transform-synthea: USAGE' });
    const linked = join(root, 'linked'); mkdirSync(linked);
    for (const f of exportFiles()) writeFileSync(join(linked, f.name), f.bytes);
    symlinkSync(join(exportDir, 'hospitalInformation1767225600000.json'), join(linked, 'zz-link.json'));
    assert.deepEqual(runTransformCli([linked, join(root, 'o3')]), { code: 1, line: 'transform-synthea: EXPORT_INVALID' });
    const big = join(root, 'big'); mkdirSync(big);
    for (const f of exportFiles()) writeFileSync(join(big, f.name), f.bytes);
    writeFileSync(join(big, 'zz-big.json'), ''); truncateSync(join(big, 'zz-big.json'), QUICKSTART_SELECTION.maxInputBytes + 1); chmodSync(join(big, 'zz-big.json'), 0);
    assert.deepEqual(runTransformCli([big, join(root, 'o7')]), { code: 1, line: 'transform-synthea: INPUT_TOO_LARGE' }, 'refused on sizes alone, before any read');
    chmodSync(join(big, 'zz-big.json'), 0o600);
    writeFileSync(join(exportDir, 'zz-broken.json'), '{"resourceType":');
    assert.deepEqual(runTransformCli([exportDir, join(root, 'o4')]), { code: 1, line: 'transform-synthea: EXPORT_INVALID' });
    const stderr = (args: string[]) => { try { execFileSync(process.execPath, ['--import', 'tsx', 'scripts/quickstart/transform-synthea.ts', ...args], { stdio: 'pipe' }); return ''; }
      catch (e) { return String((e as { stderr: Buffer }).stderr); } };
    assert.equal(stderr([exportDir, join(root, 'o5')]), 'transform-synthea: EXPORT_INVALID\n');
    assert.equal(stderr([join(root, 'a-file'), join(root, 'o6')]), 'transform-synthea: EXPORT_MISSING\n');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('quickstart transform reduces provider directory resources to synthetic stand-ins with no contact data, NPI identifiers or naming displays', () => {
  const files = exportFiles(r => {
    Object.assign(r.ORG!, { name: 'Real Clinic Of Somewhere', telecom: [{ system: 'phone', value: '555-0142' }], address: [{ line: ['12 Example Street'], city: 'Springfield' }] });
    Object.assign(r.LOC!, { name: 'Real Location Of Somewhere', telecom: [{ system: 'phone', value: '555-0143' }], position: { longitude: -71.1, latitude: 42.1 } });
    Object.assign(r.PR!, { telecom: [{ system: 'email', value: 'clinician@example.org' }], address: [{ line: ['12 Example Street'] }], qualification: [{ code: { text: 'MD' } }] });
    (r.E!.serviceProvider as Rec).display = 'Real Clinic Of Somewhere';
  });
  const { ndjson, manifest } = transformSyntheaExport(files);
  const byPut = new Map(lines(ndjson).map(line => parseFhirJson(line) as Rec).map(r => [`${r.resourceType}/${r.id}`, r]));
  assert.equal(byPut.get(`Organization/${ORG}`)!.name, 'Synthetic organization 1');
  assert.equal(byPut.get(`Location/${LOC}`)!.name, 'Synthetic location 1');
  for (const key of [`Organization/${ORG}`, `Location/${LOC}`, `Practitioner/${PR}`])
    for (const field of ['telecom', 'address', 'position', 'qualification']) assert.ok(!(field in byPut.get(key)!), `${key}.${field}`);
  assert.ok(!('identifier' in byPut.get(`Practitioner/${PR}`)!), 'the NPI identifier is removed after it resolved the reference');
  assert.deepEqual(byPut.get(`Encounter/${E}`)!.serviceProvider, { reference: `Organization/${ORG}` }, 'the display naming the organisation is dropped');
  assert.deepEqual(byPut.get(`Encounter/${E}`)!.participant, [{ individual: { reference: `Practitioner/${PR}` } }]);
  for (const removed of ['Real Clinic', 'Real Location', '555-014', 'Example Street', 'clinician@example.org', 'us-npi']) assert.ok(!ndjson.includes(removed), removed);
  assert.deepEqual(manifest.providers, { sanitized: 3, npi_identifiers_dropped: 1 });
  refused(exportFiles(r => { Object.assign(r.ORG!, { telecom: [{ system: 'phone', value: '555-0142' }] }); r.L1!.note = [{ text: 'call 555-0142 for results' }]; }), 'PROVIDER_RESIDUE');
  refused(exportFiles(r => { Object.assign(r.ORG!, { name: 'Real Clinic Of Somewhere' }); r.L1!.note = [{ text: 'seen at Real Clinic Of Somewhere' }]; }), 'PROVIDER_RESIDUE');
  assert.ok(puts(exportFiles(r => { Object.assign(r.ORG!, { address: [{ line: ['12 Example Street'], city: 'Springfield' }] }); r.P!.address = [{ city: 'Springfield' }]; })).includes(`Patient/${P}`),
    'a removed address\'s town is not residue: patients share towns');
});

test('quickstart transform admits only numeric utilization provider extensions and self-id Synthea identifiers', () => {
  const utilization = 'http://synthetichealth.github.io/synthea/utilization-encounters-extension';
  for (const type of PROVIDERS) {
    const accepted = transformSyntheaExport(providerFiles(type, p => {
      p.identifier = [{ system: SYN, value: p.id }]; p.extension = [{ url: utilization, valueInteger: 67 }];
    }));
    const provider = lines(accepted.ndjson).map(line => parseFhirJson(line) as Rec).find(r => r.resourceType === type)!;
    assert.deepEqual(provider.extension, [{ url: utilization, valueInteger: 67 }], type);
    assert.deepEqual(provider.identifier, [{ system: SYN, value: provider.id }], type);
    for (const extension of [
      [{ url: 'https://example.org/provider-contact', valueContactPoint: { system: 'phone', value: '555-0199' } }],
      [{ url: 'https://example.org/provider-contact', valueString: 'DirectoryRoleContactCanary' }],
      [{ url: 'https://example.org/unknown', valueInteger: 67 }],
      [{ url: utilization, valueInteger: 67, valueString: 'Directory ContactCanary' }],
      [{ url: utilization, valueInteger: -1 }], [{ url: utilization, valueInteger: '67' }], { url: utilization, valueInteger: 67 },
    ]) refused(providerFiles(type, p => { p.extension = extension; }), 'PROVIDER_RESIDUE');
    for (const identifier of [
      [{ system: 'https://example.org/facility-register', value: 'FACILITY-CANARY-771' }],
      [{ system: 'https://example.org/facility-register', value: provider.id }],
      [{ system: SYN, value: 'DirectoryNameCanary' }], [{ system: SYN, value: provider.id, assigner: { display: 'DirectoryNameCanary' } }],
      [{ system: SYN, value: provider.id, type: { text: 'DirectoryNameCanary' } }],
      'unsupported identifier shape',
    ]) refused(providerFiles(type, p => { p.identifier = identifier; }), 'PROVIDER_RESIDUE');
    refused(providerFiles(type, p => { p.identifier = { system: SYN, value: p.id }; }), 'REFERENCE_LOGICAL');
  }
});

test('quickstart transform refuses unreviewed identifying provider fields and nonsynthetic Practitioner names', () => {
  for (const type of PROVIDERS) for (const extra of [{ description: 'Directory ContactCanary' }, { text: { status: 'generated', div: '<div>Directory ContactCanary</div>' } },
    { modifierExtension: [{ url: 'urn:example:provider-contact', valueString: 'Directory ContactCanary' }] }, { meta: { source: 'https://example.org/provider' } }])
    refused(providerFiles(type, p => { Object.assign(p, extra); }), 'PROVIDER_RESIDUE');
  for (const name of [[], [{ family: 'DirectoryNameCanary' }], [{ family: 'DirectoryNameCanary', given: ['Quick891'] }], [{ family: 'Clinician707', given: ['DirectoryNameCanary'] }],
    [{ family: 'Clinician707', given: [] }],
    [{ family: 'Clinician707', given: ['Quick891'], prefix: ['Dr.', 'DirectoryNameCanary'] }],
    [{ family: 'Clinician707', given: ['Quick891'], text: 'DirectoryNameCanary' }], 'DirectoryNameCanary'])
    refused(providerFiles('Practitioner', p => { p.name = name; }), 'PROVIDER_RESIDUE');
  for (const type of ['Organization', 'Location'] as const) for (const name of [[{ text: 'DirectoryNameCanary' }], '', '   '])
    refused(providerFiles(type, p => { p.name = name; }), 'PROVIDER_RESIDUE');
  refused(providerFiles('PractitionerRole', p => { p.name = 'DirectoryNameCanary'; }), 'PROVIDER_RESIDUE');
  assert.ok(transformSyntheaExport(providerFiles('Practitioner', p => { delete p.name; })).manifest.resources.some(r => r.type === 'Practitioner'), 'an unnamed synthetic dependency is admitted');
  for (const extra of [{ active: 'Directory ContactCanary' }, { gender: 'Directory ContactCanary' }])
    refused(providerFiles('Practitioner', p => { Object.assign(p, extra); }), 'PROVIDER_RESIDUE');
  for (const extra of [{ status: 'Directory ContactCanary' }, { mode: 'Directory ContactCanary' }])
    refused(providerFiles('Location', p => { Object.assign(p, extra); }), 'PROVIDER_RESIDUE');
  refused(providerFiles('Organization', p => { p.type = [{ text: 'Directory ContactCanary' }]; }), 'PROVIDER_RESIDUE');
  refused(providerFiles('PractitionerRole', p => { p.practitioner = { display: 'Directory ContactCanary' }; }), 'PROVIDER_RESIDUE');
  for (const practitioner of [{}, { ...ref(PR), extension: [{ url: 'urn:example:provider', valueString: 'Directory ContactCanary' }] }])
    refused(providerFiles('PractitionerRole', p => { p.practitioner = practitioner; }), 'PROVIDER_RESIDUE');
  refused(providerFiles('PractitionerRole', p => { p.location = [{ display: 'Directory ContactCanary' }]; }), 'PROVIDER_RESIDUE');
  refused(providerFiles('PractitionerRole', p => { p.location = ref(LOC); }), 'PROVIDER_RESIDUE');
});

test('quickstart transform binds synthetic Practitioner displays and refuses provider displays without a resolved identity', () => {
  const display = 'Dr. Quick891 Clinician707';
  const accepted = transformSyntheaExport(exportFiles(r => { r.L1!.performer = [{ ...ref(PR), display }]; }));
  assert.ok(accepted.ndjson.includes(display), 'the pinned synthetic naming convention is preserved');
  for (const display of ['Directory DisplayCanary', 'Dr. Other891 Clinician707', 7])
    refused(exportFiles(r => { r.L1!.performer = [{ ...ref(PR), display }]; }), 'PROVIDER_RESIDUE');
  refused(providerFiles('PractitionerRole', (_p, r) => { r.L1!.performer = [{ ...ref(ROLE), display: 'DirectoryRoleDisplayCanary' }]; }), 'PROVIDER_RESIDUE');
  for (const type of PROVIDERS) refused(exportFiles(r => { r.L1!.performer = [{ type, display: 'UnresolvedDirectoryCanary' }]; }), 'PROVIDER_RESIDUE');
  refused(exportFiles(r => { r.L1!.derivedFrom = [{ type: 'Organization', display: 'UnresolvedDirectoryCanary' }]; }), 'PROVIDER_RESIDUE');
  refused(exportFiles(r => { r.E!.serviceProvider = { display: 'UnresolvedDirectoryCanary' }; }), 'PROVIDER_RESIDUE');
  refused(exportFiles(r => { r.E!.serviceProvider = { type: 'Observation', display: 'UnresolvedDirectoryCanary' }; }), 'PROVIDER_RESIDUE');
  for (const reference of [{ display: 'UnresolvedDirectoryCanary' }, { type: 'http://hl7.org/fhir/StructureDefinition/Organization', display: 'UnresolvedDirectoryCanary' }])
    refused(exportFiles(r => { r.L1!.extension = [{ url: 'urn:example:reference', valueReference: reference }]; }), 'PROVIDER_RESIDUE');
  for (const type of ['Organization', 'Location'] as const) {
    const id = type === 'Organization' ? ORG : LOC;
    const clean = transformSyntheaExport(exportFiles(r => { r.L1!.performer = [{ ...ref(id), display: 'Directory DisplayCanary' }]; }));
    assert.ok(!clean.ndjson.includes('Directory DisplayCanary'), type);
    refused(exportFiles(r => { r.L1!.performer = [{ ...ref(id), display: 'Directory DisplayCanary' }]; r.L2!.note = [{ text: 'Seen at Directory DisplayCanary' }]; }), 'PROVIDER_RESIDUE');
  }
  const clinicalDisplay = transformSyntheaExport(exportFiles(r => { r.L1!.derivedFrom = [{ type: 'Observation', display: 'General laboratory observation' }]; }));
  assert.ok(clinicalDisplay.ndjson.includes('General laboratory observation'), 'a non-provider display-only reference remains admitted');
});

test('quickstart transform removes and inventories NPI values and provider aliases across every admitted provider type', () => {
  for (const type of PROVIDERS) {
    const edit = (p: Rec) => { p.identifier = [{ system: NPI, value: '9990000011' }]; p.alias = ['Directory AliasCanary']; };
    const clean = transformSyntheaExport(providerFiles(type, edit));
    assert.ok(!clean.ndjson.includes('9990000011') && !clean.ndjson.includes('Directory AliasCanary'), type);
    for (const text of ['Provider number 9990000011', 'Seen at Directory AliasCanary', 'Directory AliasCanary'])
      refused(providerFiles(type, (p, r) => { edit(p); r.L1!.note = [{ text }]; }), 'PROVIDER_RESIDUE');
    assert.ok(transformSyntheaExport(providerFiles(type, (p, r) => { edit(p); r.L1!.note = [{ text: 'Other number 99900000112; another facility' }]; })).ndjson.includes('99900000112'), type);
    refused(providerFiles(type, p => { p.identifier = [{ system: NPI, value: 9990000011 }]; }), 'PROVIDER_RESIDUE');
    refused(providerFiles(type, p => { p.identifier = [{ system: NPI, value: '   ' }]; }), 'PROVIDER_RESIDUE');
    refused(providerFiles(type, p => { p.identifier = [{ system: NPI, value: '9990000011', type: { text: 'Directory ContactCanary' } }]; }), 'PROVIDER_RESIDUE');
    refused(providerFiles(type, (p, r) => { p.identifier = [{ system: NPI, value: ' 9990000011 ' }]; r.L1!.note = [{ text: 'Provider number 9990000011' }]; }), 'PROVIDER_RESIDUE');
    refused(providerFiles(type, p => { p.alias = [771]; }), 'PROVIDER_RESIDUE');
  }
});

test('quickstart transform matches reformatted provider telecom values without matching different or longer numbers', () => {
  for (const type of PROVIDERS) {
    const edit = (p: Rec) => { p.telecom = [{ system: 'phone', value: '555-010-0199' }, { system: 'email', value: 'directory@example.org' }]; };
    const clean = transformSyntheaExport(providerFiles(type, edit));
    assert.ok(!clean.ndjson.includes('555-010-0199') && !clean.ndjson.includes('directory@example.org'), type);
    for (const text of ['Telephone (555) 010-0199', 'Call 555.010.0199', 'Call 5550100199', 'Email directory@example.org'])
      refused(providerFiles(type, (p, r) => { edit(p); r.L1!.note = [{ text }]; }), 'PROVIDER_RESIDUE');
    for (const text of ['Other telephone 555-010-0198', 'Longer token 55501001990'])
      assert.ok(transformSyntheaExport(providerFiles(type, (p, r) => { edit(p); r.L1!.note = [{ text }]; })).ndjson.includes(text), text);
    refused(providerFiles(type, p => { p.telecom = [{ system: 'phone', value: 'dial Directory ContactCanary' }]; }), 'PROVIDER_RESIDUE');
    refused(providerFiles(type, p => { p.telecom = [{ system: 'phone', value: '123' }]; }), 'PROVIDER_RESIDUE');
    refused(providerFiles(type, p => { p.telecom = [{ system: 'phone', value: 5550100199 }]; }), 'PROVIDER_RESIDUE');
    for (const system of ['fax', 'sms', 'pager'])
      refused(providerFiles(type, (p, r) => { p.telecom = [{ system, value: '555-010-0199' }]; r.L1!.note = [{ text: 'Telephone (555) 010-0199' }]; }), 'PROVIDER_RESIDUE');
  }
  const alternatives = (p: Rec) => { p.telecom = [{ system: 'phone', value: '555-010-0199 or 555-010-0198' }]; };
  assert.ok(!transformSyntheaExport(providerFiles('Organization', alternatives)).ndjson.includes('555-010-0199'));
  for (const text of ['Telephone (555) 010-0199', 'Telephone (555) 010-0198'])
    refused(providerFiles('Organization', (p, r) => { alternatives(p); r.L1!.note = [{ text }]; }), 'PROVIDER_RESIDUE');
});

test('quickstart transform inventories single and array Address lines and nested provider contacts but permits shared geography', () => {
  for (const address of [{ line: ['12 Canary Avenue'], city: 'Sharedtown' }, { line: '12 Canary Avenue', city: 'Sharedtown' },
    [{ line: ['12 Canary Avenue'], city: 'Sharedtown' }], { text: '12 Canary Avenue' }]) {
    const edit = (p: Rec, r: Record<string, Rec>) => { p.address = address; r.P!.address = [{ city: 'Sharedtown' }]; };
    const clean = transformSyntheaExport(providerFiles('Location', edit));
    assert.ok(!clean.ndjson.includes('12 Canary Avenue') && clean.ndjson.includes('Sharedtown'));
    refused(providerFiles('Location', (p, r) => { edit(p, r); r.L1!.note = [{ text: 'Seen at 12 Canary Avenue' }]; }), 'PROVIDER_RESIDUE');
    refused(providerFiles('Location', (p, r) => { edit(p, r); r.L1!.text = { div: '<div>Seen at 12 Canary <b>Avenue</b></div>' }; }), 'PROVIDER_RESIDUE');
  }
  const contact = [{ name: { family: 'Directory ContactCanary' }, telecom: [{ system: 'phone', value: '555-010-0199' }], address: { line: ['12 Canary Avenue'] } }];
  assert.ok(!transformSyntheaExport(providerFiles('Organization', p => { p.contact = contact; })).ndjson.includes('Directory ContactCanary'));
  for (const text of ['Seen by Directory ContactCanary', 'Telephone (555) 010-0199', 'Seen at 12 Canary Avenue'])
    refused(providerFiles('Organization', (p, r) => { p.contact = contact; r.L1!.note = [{ text }]; }), 'PROVIDER_RESIDUE');
  refused(providerFiles('Location', p => { p.address = { line: [1234] }; }), 'PROVIDER_RESIDUE');
  refused(providerFiles('Organization', p => { p.contact = [{ name: { family: 771 } }]; }), 'PROVIDER_RESIDUE');
});

test('quickstart transform refuses single-token provider names and matches every admitted removed name as a bounded value everywhere', () => {
  for (const name of ['General', 'DirectoryCanary']) for (const note of ['General laboratory observation', 'Referral to DirectoryCanary for tests.', ''])
    refused(exportFiles(r => { r.ORG!.name = name; r.L1!.note = [{ text: note }]; }), 'PROVIDER_RESIDUE');
  for (const text of ['Referral to Directory Canary for tests.', 'Directory Canary', 'Preface: Directory Canary.'])
    refused(exportFiles(r => { r.ORG!.name = 'Directory Canary'; r.L1!.note = [{ text }]; }), 'PROVIDER_RESIDUE');
  assert.ok(transformSyntheaExport(exportFiles(r => { r.ORG!.name = 'Directory Canary'; r.L1!.note = [{ text: 'General laboratory observation' }]; })).ndjson.includes('General laboratory observation'));
});

test('quickstart transform sanitizes PractitionerRole contacts even when no other provider is reached', () => {
  const clean = transformSyntheaExport(exportFiles(r => {
    delete r.E!.participant; delete r.E!.serviceProvider; delete r.E!.location;
    r.XRole = { resourceType: 'PractitionerRole', id: ROLE, telecom: [{ system: 'phone', value: '555-0199' }] };
    r.L1!.performer = [ref(ROLE)];
  }));
  const role = lines(clean.ndjson).map(line => parseFhirJson(line) as Rec).find(r => r.resourceType === 'PractitionerRole')!;
  assert.deepEqual(role, { resourceType: 'PractitionerRole', id: ROLE });
  assert.equal(clean.manifest.providers.sanitized, 1);
});

test('quickstart transform seed contract independently refuses identifying providers and unbound provider displays', () => {
  const clean = transformSyntheaExport(providerFiles('PractitionerRole', () => {}));
  const parsed = () => lines(clean.ndjson).map(line => parseFhirJson(line) as Rec);
  const contractRefuses = (edit: (rows: Rec[]) => void) => {
    const rows = parsed(); edit(rows);
    assert.throws(() => checkSeedContract(rows, clean.manifest), (e: unknown) => e instanceof TransformError && e.code === 'SEED_CONTRACT');
  };
  for (const type of PROVIDERS) for (const extra of [{ extension: [{ url: 'urn:example:contact', valueString: 'Directory ContactCanary' }] },
    { identifier: [{ system: 'https://example.org/facility-register', value: 'FACILITY-CANARY-771' }] }, { telecom: [{ system: 'phone', value: '555-0199' }] }])
    contractRefuses(rows => { Object.assign(rows.find(r => r.resourceType === type)!, extra); });
  contractRefuses(rows => { rows.find(r => r.resourceType === 'Practitioner')!.name = [{ family: 'DirectoryNameCanary' }]; });
  contractRefuses(rows => { rows.find(r => r.resourceType === 'Organization')!.name = 'Synthetic location 1'; });
  contractRefuses(rows => { rows.find(r => r.resourceType === 'Organization')!.name = 'Synthetic organization 0'; });
  contractRefuses(rows => { rows.find(r => r.resourceType === 'Observation')!.performer = [{ reference: `Practitioner/${PR}`, display: 'Directory DisplayCanary' }]; });
  contractRefuses(rows => { rows.find(r => r.resourceType === 'Observation')!.performer = [{ type: 'Organization', display: 'UnresolvedDirectoryCanary' }]; });
  contractRefuses(rows => { rows.find(r => r.resourceType === 'Observation')!.performer = [{ reference: `PractitionerRole/${ROLE}`, display: 'DirectoryRoleDisplayCanary' }]; });
  checkSeedContract(parsed(), clean.manifest);
});
