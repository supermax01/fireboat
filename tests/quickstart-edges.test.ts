import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, constants, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseFhirJson, stringifyFhir } from '../packages/core/src/decimal.js';
import { EdgeError, mergeEdges, runEdgesCli, type EdgeFault, type SeedFiles } from '../scripts/quickstart/edges.js';
import { QUICKSTART_SELECTION, type SeedManifest } from '../scripts/quickstart/transform-synthea.js';

type Rec = Record<string, unknown>;
const SHIPPED = readFileSync(new URL('../packages/evals/fixtures/quickstart/edges.json', import.meta.url));
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const P = '00000000-0000-4000-8000-000000000001', L = '00000000-0000-4000-8000-000000000020';
const lab = [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'laboratory' }] }];
const hba1c = { coding: [{ system: 'http://loinc.org', code: '4548-4' }] };
const naturalLab = (id: string, extra: Rec = {}): Rec => ({ resourceType: 'Observation', id, status: 'final', category: lab, code: hba1c, subject: { reference: `Patient/${P}` }, effectiveDateTime: '2023-01-01T00:00:00Z', ...extra });
const natural = (): Rec[] => [{ resourceType: 'Patient', id: P, gender: 'female' }, naturalLab(L)];
/** A natural seed in the transform's exact output shape: one NDJSON line per row, hashed, rows labelled natural, typed from the bodies unless `rows` says otherwise. */
function seedOf(resources: Rec[] = natural(), options: { lines?: string[]; selection?: SeedManifest['selection'] } = {}): SeedFiles {
  const lines = options.lines ?? resources.map(r => JSON.stringify(r)), ndjson = lines.map(line => `${line}\n`).join('');
  const counts: Record<string, number> = {};
  for (const r of resources) counts[r.resourceType as string] = (counts[r.resourceType as string] ?? 0) + 1;
  const manifest: SeedManifest = { schema: 'fireboat-quickstart-seed/1', inputs: [{ name: 'x.json', bytes: 1, sha256: hash('x') }], selection: options.selection ?? QUICKSTART_SELECTION,
    patient: `Patient/${P}`, counts, dropped_patient_identifiers: { SS: 0, DL: 0, PPN: 0 }, providers: { sanitized: 0, npi_identifiers_dropped: 0 },
    resources: lines.map((line, i) => ({ type: resources[i]!.resourceType as string, id: resources[i]!.id as string, bytes: Buffer.byteLength(line), sha256: hash(line), origin: 'natural' })),
    ndjson_sha256: hash(ndjson) };
  return { ndjson, manifest };
}
const edgeFile = (resources: unknown[], extra: Rec = {}) => Buffer.from(stringifyFhir({ schema: 'fireboat-quickstart-edges/1', note: 'test', resources, ...extra }));
const entry = (resource: Rec, purpose = 'test') => ({ purpose, resource });
const obs = (id: string, extra: Rec = {}): Rec => ({ resourceType: 'Observation', id, status: 'final', category: lab, code: hba1c,
  subject: { reference: 'Patient/$natural' }, effectiveDateTime: '2025-11-03T08:30:00Z', valueQuantity: { value: 5.5, unit: '%' }, ...extra });
const doc = (id: string, content: unknown, extra: Rec = {}): Rec => ({ resourceType: 'DocumentReference', id, status: 'current', subject: { reference: 'Patient/$natural' }, content, ...extra });
const attachment = (data: unknown = 'U3ludGhldGlj', contentType: unknown = 'text/plain') => ({ attachment: { contentType, data } });
const patient = (id = 'qs-edge-p', extra: Rec = {}) => entry({ resourceType: 'Patient', id, gender: 'unknown', ...extra });
const without = (r: Rec, key: string): Rec => { const copy = { ...r }; delete copy[key]; return copy; };
const refused = (bytes: Uint8Array, code: EdgeFault, seed = seedOf()) =>
  assert.throws(() => mergeEdges(seed, bytes), (e: unknown) => e instanceof EdgeError && e.code === code && e.message === code, code);
const one = (resource: Rec) => edgeFile([entry(resource)]);
const put = (r: { type: string; id: string }) => `${r.type}/${r.id}`;
const merged = (bytes: Uint8Array, seed = seedOf()) => mergeEdges(seed, bytes).manifest.resources.filter(r => r.origin === 'edge').map(put);

test('quickstart edges: the reviewed fixture merges after the natural rows as labelled edges, with $natural rewritten and lexemes kept', () => {
  const seed = seedOf();
  const { ndjson, manifest } = mergeEdges(seed, SHIPPED);
  assert.deepEqual(manifest.resources.map(put), [`Patient/${P}`, `Observation/${L}`, 'Patient/qs-edge-other-patient', 'DocumentReference/qs-edge-document',
    'Observation/qs-edge-hba1c-corrected', 'Observation/qs-edge-hba1c-entered-in-error', 'Observation/qs-edge-other-hba1c']);
  assert.deepEqual(manifest.resources.map(r => r.origin), ['natural', 'natural', 'edge', 'edge', 'edge', 'edge', 'edge']);
  assert.ok(ndjson.startsWith(seed.ndjson), 'natural lines are unchanged and first');
  const lines = ndjson.trimEnd().split('\n');
  lines.forEach((line, i) => {
    assert.equal(manifest.resources[i]!.sha256, hash(line));
    assert.equal(manifest.resources[i]!.bytes, Buffer.byteLength(line));
  });
  assert.equal(manifest.ndjson_sha256, hash(ndjson));
  assert.deepEqual(manifest.edges, { sha256: hash(SHIPPED), count: 5 });
  assert.deepEqual(manifest.counts, { Patient: 2, Observation: 4, DocumentReference: 1 });
  assert.equal(manifest.patient, seed.manifest.patient);
  assert.deepEqual(manifest.selection, seed.manifest.selection);
  assert.deepEqual(manifest.inputs, seed.manifest.inputs);
  assert.ok(!ndjson.includes('$natural'));
  const byPut = new Map(lines.map(line => parseFhirJson(line) as Rec).map(r => [`${r.resourceType}/${r.id}`, r]));
  assert.deepEqual(byPut.get('Observation/qs-edge-hba1c-corrected')!.subject, { reference: `Patient/${P}` });
  assert.deepEqual(byPut.get('DocumentReference/qs-edge-document')!.subject, { reference: `Patient/${P}` });
  assert.deepEqual(byPut.get('Observation/qs-edge-other-hba1c')!.subject, { reference: 'Patient/qs-edge-other-patient' });
  assert.match(ndjson, /"value":7\.00,/);
  assert.match(ndjson, /"value":6\.10,/);
});

test('quickstart edges: the shipped fixture covers the packaged tasks\' status, lexeme, wrong-patient and payload cases', () => {
  const file = parseFhirJson(SHIPPED.toString('utf8')) as { resources: { purpose: string; resource: Rec }[] };
  assert.ok(file.resources.every(e => typeof e.purpose === 'string' && e.purpose.length > 0));
  const resources = file.resources.map(e => e.resource);
  const mine = resources.filter(r => r.resourceType === 'Observation' && (r.subject as Rec).reference === 'Patient/$natural');
  assert.deepEqual(mine.map(r => r.status).sort(), ['corrected', 'entered-in-error']);
  assert.match(SHIPPED.toString('utf8'), /"value": 7\.00,/, 'a trailing-zero lexeme in the source');
  const other = resources.filter(r => r.resourceType === 'Patient');
  assert.equal(other.length, 1);
  assert.ok(!('identifier' in other[0]!));
  const foreign = resources.filter(r => r.resourceType === 'Observation' && (r.subject as Rec).reference === `Patient/${other[0]!.id as string}`);
  assert.equal(foreign.length, 1);
  assert.deepEqual((foreign[0]!.code as { coding: Rec[] }).coding.map(c => c.code), ['4548-4'], 'same code as the bound patient\'s HbA1c');
  const documents = resources.filter(r => r.resourceType === 'DocumentReference');
  assert.equal(documents.length, 1);
  const document = documents[0]!, content = (document.content as Rec[])[0]!.attachment as Rec;
  assert.equal(document.status, 'current');
  assert.deepEqual((document.type as { coding: Rec[] }).coding.map(c => c.code), ['11506-3']);
  assert.equal(content.title, 'Synthetic quickstart note', 'the metadata the payload task must still show');
  assert.equal(content.contentType, 'text/plain');
  assert.equal(Buffer.from(content.data as string, 'base64').toString('base64'), content.data);
  mergeEdges(seedOf(), SHIPPED);
});

test('quickstart edges: a seed whose hashes, rows, bodies, patient, graph or bounds do not match is refused before any merge', () => {
  const variants: ((s: SeedFiles) => void)[] = [
    s => { s.manifest.ndjson_sha256 = '0'.repeat(64); },
    s => { s.manifest.resources[0]!.sha256 = '0'.repeat(64); },
    s => { s.manifest.resources[1]!.bytes += 1; },
    s => { (s.manifest.resources[1] as { origin: string }).origin = 'edge'; },
    s => { s.manifest.resources.pop(); },
    s => { s.manifest.resources.push({ ...s.manifest.resources[1]! }); },
    s => { (s.manifest.resources as unknown[])[1] = null; },
    s => { (s.manifest.resources[1] as unknown as Rec).extra = 1; },
    s => { s.manifest.resources[1]!.id = 'qs-edge-hba1c-corrected'; },
    s => { s.manifest.resources[1]!.type = 'Condition'; },
    s => { s.ndjson = s.ndjson.slice(0, -1); s.manifest.ndjson_sha256 = hash(s.ndjson); },
    s => { (s.manifest as { schema: string }).schema = 'fireboat-quickstart-seed/0'; },
    s => { s.manifest.patient = 'Patient/../x'; },
    s => { s.manifest.patient = 'Patient/qs-edge-other-patient'; },
    s => { s.manifest.patient = `Observation/${L}`; },
    s => { delete (s.manifest as Partial<SeedManifest>).selection; },
    s => { s.manifest.selection = { ...s.manifest.selection, window: { start: '2020-01-01', end: '2026-13-01' } }; },
    s => { s.manifest.selection = { ...s.manifest.selection, window: { start: '2026-01-01', end: '2020-01-01' } }; },
    s => { s.manifest.selection = { ...s.manifest.selection, maxResources: 1 }; },
    s => { s.manifest.selection = { ...s.manifest.selection, maxBytes: 10 }; },
  ];
  for (const [i, edit] of variants.entries()) {
    const seed = structuredClone(seedOf());
    edit(seed);
    assert.throws(() => mergeEdges(seed, SHIPPED), (e: unknown) => e instanceof EdgeError && e.code === 'SEED_INVALID', `variant ${i}`);
  }
  const resources = natural();
  const shaped = (rs: Rec[], lines?: string[]) => refused(SHIPPED, 'SEED_INVALID', seedOf(rs, lines ? { lines } : {}));
  shaped([resources[0]!, resources[1]!], [JSON.stringify(resources[0]), '{"resourceType":"Observation",']);
  shaped([resources[0]!, resources[1]!, resources[1]!]);
  shaped([resources[1]!]);
  shaped([...resources, { resourceType: 'Patient', id: 'other', gender: 'male' }]);
  shaped([resources[0]!, naturalLab(L, { subject: { reference: 'Patient/other' } })]);
  shaped([resources[0]!, naturalLab(L, { performer: [{ reference: 'Practitioner/absent' }] })]);
  shaped([resources[0]!, naturalLab(L, { subject: { identifier: { system: 'https://example.org/mrn', value: 'synthetic-1' } } })]);
  // The transform's own contract (checkSeedContract): what a natural seed cannot contain even when its hashes agree.
  const patientRow = resources[0]!;
  for (const [label, rows] of [
    ['an unadmitted type', [patientRow, { resourceType: 'MedicationRequest', id: 'm1', status: 'active', subject: { reference: `Patient/${P}` } }]],
    ['an out-of-window lab', [patientRow, naturalLab(L, { effectiveDateTime: '2019-06-01T00:00:00Z' })]],
    ['a non-laboratory Observation', [patientRow, naturalLab(L, { category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs' }] }] })]],
    ['a lab without a subject', [patientRow, without(naturalLab(L), 'subject')]],
    ['a lab owned by an Organization', [{ resourceType: 'Organization', id: 'o1', name: 'Synthetic organization 1' }, patientRow, naturalLab(L, { subject: { reference: 'Organization/o1' } })]],
    ['a disagreeing Reference.type', [patientRow, naturalLab(L, { subject: { reference: `Patient/${P}`, type: 'Group' } })]],
    ['a referrer before its target', [naturalLab(L), patientRow]],
    ['a self-reference', [patientRow, naturalLab(L, { hasMember: [{ reference: `Observation/${L}` }] })]],
    ['a contained resource', [patientRow, naturalLab(L, { contained: [{ resourceType: 'Patient', id: 'p2' }] })]],
    ['a deceased Patient', [{ ...patientRow, deceasedDateTime: '2024-01-01T00:00:00Z' }, naturalLab(L)]],
    ['a government identifier', [{ ...patientRow, identifier: [{ system: 'http://hl7.org/fhir/sid/us-ssn', value: '999-00-0000' }] }, naturalLab(L)]],
    ['provider contact data', [{ resourceType: 'Organization', id: 'o1', name: 'Synthetic organization 1', telecom: [{ system: 'phone', value: '555-0100' }] }, patientRow, naturalLab(L)]],
    ['an NPI identifier', [{ resourceType: 'Practitioner', id: 'pr1', identifier: [{ system: 'http://hl7.org/fhir/sid/us-npi', value: '9990000001' }] }, patientRow, naturalLab(L)]],
    ['an organisation name that is not a stand-in', [{ resourceType: 'Organization', id: 'o1', name: 'Fitchburg Outpatient Clinic' }, patientRow, naturalLab(L)]],
    ['a lab report without results', [patientRow, naturalLab(L), { resourceType: 'DiagnosticReport', id: 'd1', status: 'final', category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0074', code: 'LAB' }] }],
      subject: { reference: `Patient/${P}` }, effectiveDateTime: '2023-01-01T00:00:00Z' }]],
    ['an Encounter without a subject', [patientRow, { resourceType: 'Encounter', id: 'e1', status: 'finished' }, naturalLab(L)]],
    ['a logical reference', [patientRow, naturalLab(L, { performer: [{ identifier: { system: 'https://example.org/npi', value: 'synthetic' } }] })]],
    ['a lab report with an empty result list', [patientRow, naturalLab(L), { resourceType: 'DiagnosticReport', id: 'd1', status: 'final', category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0074', code: 'LAB' }] }],
      subject: { reference: `Patient/${P}` }, effectiveDateTime: '2023-01-01T00:00:00Z', result: [] }]],
    ['an organisation display', [{ resourceType: 'Organization', id: 'o1', name: 'Synthetic organization 1' }, patientRow, naturalLab(L, { performer: [{ reference: 'Organization/o1', display: 'Synthetic organization 1' }] })]],
  ] as [string, Rec[]][]) assert.throws(() => mergeEdges(seedOf(rows), SHIPPED), (e: unknown) => e instanceof EdgeError && e.code === 'SEED_INVALID', label);
  for (const edit of [(m: Rec) => { delete m.inputs; }, (m: Rec) => { m.inputs = []; }, (m: Rec) => { delete m.counts; }, (m: Rec) => { delete m.providers; }, (m: Rec) => { m.counts = { Patient: 1 }; }]) {
    const seed = structuredClone(seedOf());
    edit(seed.manifest as unknown as Rec);
    refused(SHIPPED, 'SEED_INVALID', seed);
  }
  const labFree = seedOf([patientRow], { selection: { ...QUICKSTART_SELECTION, window: { start: '2026-01-01', end: '2020-01-01' } } });
  refused(SHIPPED, 'SEED_INVALID', labFree);
  const provider = { resourceType: 'Organization', id: 'o1', name: 'Synthetic organization 1' };
  const report = { resourceType: 'DiagnosticReport', id: 'd1', status: 'final', category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0074', code: 'LAB' }] }],
    subject: { reference: `Patient/${P}` }, effectiveDateTime: '2023-01-01T00:00:00Z', result: [{ reference: `Observation/${L}` }] };
  assert.equal(mergeEdges(seedOf([patientRow, { resourceType: 'Encounter', id: 'e1', status: 'finished', subject: { reference: `Patient/${P}` } }, naturalLab(L), report]), SHIPPED).manifest.edges.count, 5,
    'a lab report of in-seed results and an Encounter of the patient are admitted');
  assert.equal(mergeEdges(seedOf([provider, patientRow, naturalLab(L, { performer: [{ reference: 'Organization/o1' }] })]), SHIPPED).manifest.edges.count, 5,
    'a sanitised provider and an undisplayed reference to it are admitted');
});

test('quickstart edges: malformed edge files and entries are refused', () => {
  const good = one(obs('qs-edge-a')).toString('utf8');
  const [head, tail] = good.split('"note":"test"') as [string, string];
  refused(Buffer.concat([Buffer.from(`${head}"note":"te`), Buffer.from([0xff]), Buffer.from(`st"${tail}`)]), 'EDGES_INVALID');
  refused(Buffer.from('{"schema":'), 'EDGES_INVALID');
  refused(edgeFile([entry(obs('qs-edge-a'))], { extra: 1 }), 'EDGES_INVALID');
  refused(edgeFile([entry(obs('qs-edge-a'))], { schema: 'fireboat-quickstart-edges/0' }), 'EDGES_INVALID');
  refused(edgeFile([]), 'EDGES_INVALID');
  refused(edgeFile(Array.from({ length: 65 }, (_, i) => entry(obs(`qs-edge-a${i}`)))), 'EDGES_INVALID');
  refused(edgeFile([{ ...entry(obs('qs-edge-a')), note: 'x' }]), 'EDGES_INVALID');
  refused(edgeFile([entry(obs('qs-edge-a'), '')]), 'EDGES_INVALID');
  refused(edgeFile([entry(obs('qs-edge-a'), 'x'.repeat(201))]), 'EDGES_INVALID');
  refused(one(obs('qs-edge-a', { meta: { versionId: '1' } })), 'EDGES_INVALID');
  refused(one(obs('qs-edge-a', { contained: [{ resourceType: 'Patient', id: 'p' }] })), 'EDGES_INVALID');
  assert.equal(mergeEdges(seedOf(), edgeFile(Array.from({ length: 64 }, (_, i) => entry(obs(`qs-edge-a${i}`))))).manifest.edges.count, 64);
});

test('quickstart edges: Observations and documents need their minimal reviewed shape', () => {
  refused(one(obs('qs-edge-a', { category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs' }] }] })), 'EDGE_SHAPE_INVALID');
  for (const status of [undefined, '', 'done', 5]) refused(one(status === undefined ? without(obs('qs-edge-a'), 'status') : obs('qs-edge-a', { status })), 'EDGE_SHAPE_INVALID');
  for (const code of [undefined, {}, { coding: [] }, { coding: [{ system: 'http://loinc.org' }] }, { coding: [{ system: 'http://loinc.org', code: '' }] }, { text: 'HbA1c' }])
    refused(one(code === undefined ? without(obs('qs-edge-a'), 'code') : obs('qs-edge-a', { code })), 'EDGE_SHAPE_INVALID');
  for (const status of [undefined, 'final', ''])
    refused(one(status === undefined ? without(doc('qs-edge-d', [attachment()]), 'status') : doc('qs-edge-d', [attachment()], { status })), 'EDGE_SHAPE_INVALID');
  for (const status of ['registered', 'preliminary', 'final', 'amended', 'corrected', 'cancelled', 'entered-in-error', 'unknown'])
    assert.equal(merged(one(obs('qs-edge-a', { status }))).length, 1, status);
});

test('quickstart edges: ids must be qs-edge-* of an allowed type and unique across the edges and the natural seed', () => {
  for (const id of ['other-a', 'qs-edge-', 'qs-edge-A', `qs-edge-${'a'.repeat(49)}`, 5]) refused(one(obs('x', { id })), 'EDGE_ID_INVALID');
  refused(one(without(obs('qs-edge-a'), 'id')), 'EDGE_ID_INVALID');
  assert.equal(mergeEdges(seedOf(), one(obs(`qs-edge-${'a'.repeat(48)}`))).manifest.edges.count, 1);
  refused(one({ resourceType: 'Condition', id: 'qs-edge-c', subject: { reference: 'Patient/$natural' } }), 'EDGE_TYPE_NOT_ALLOWED');
  refused(one(without(obs('qs-edge-a'), 'resourceType')), 'EDGE_TYPE_NOT_ALLOWED');
  refused(edgeFile([entry(obs('qs-edge-a')), entry(obs('qs-edge-a', { status: 'amended' }))]), 'EDGE_DUPLICATE');
  const colliding = seedOf([...natural(), naturalLab('qs-edge-a')]);
  refused(one(obs('qs-edge-a')), 'EDGE_DUPLICATE', colliding);
});

test('quickstart edges: references name only the natural patient token or another edge, with a matching type', () => {
  for (const subject of [{ reference: `Patient/${P}` }, { reference: 'Patient/qs-edge-missing' }, { reference: `urn:uuid:${P}` }, { reference: '#p' }, { reference: 'Patient/$natural', type: 'Group' }])
    refused(one(obs('qs-edge-a', { subject })), 'EDGE_REFERENCE_INVALID');
  for (const subject of [{ reference: 5 }, { identifier: { system: 'https://example.org/mrn', value: 'synthetic-1' } }, { reference: 'Patient/$natural', identifier: { value: 'x' } }])
    refused(one(obs('qs-edge-a', { subject })), 'EDGE_SHAPE_INVALID');
  refused(one(obs('qs-edge-a', { hasMember: [{ reference: `Observation/${L}` }] })), 'EDGE_REFERENCE_INVALID');
  refused(one(obs('qs-edge-a', { derivedFrom: [{ reference: 'DocumentReference/qs-edge-missing' }] })), 'EDGE_REFERENCE_INVALID');
  for (const extra of [{ performer: [{ identifier: { system: 'https://example.org/npi', value: '9990000001' } }] }, { extension: [{ url: 'https://example.org/x', valueReference: { reference: 'Practitioner/qs-edge-p' } }] },
    { modifierExtension: [{ url: 'https://example.org/x', valueReference: { reference: 'Patient/qs-edge-missing' } }] }])
    refused(one(obs('qs-edge-a', extra)), 'EDGE_SHAPE_INVALID');
  refused(one(without(obs('qs-edge-a'), 'subject')), 'EDGE_SUBJECT_INVALID');
  refused(one(without(doc('qs-edge-d', [attachment()]), 'subject')), 'EDGE_SUBJECT_INVALID');
  refused(edgeFile([entry(obs('qs-edge-a', { subject: { reference: 'Observation/qs-edge-b' } })), entry(obs('qs-edge-b'))]), 'EDGE_SUBJECT_INVALID');
});

test('quickstart edges: links stay inside one patient\'s graph, and the edge Patient links nothing', () => {
  const other = (id: string, extra: Rec = {}) => entry(obs(id, { subject: { reference: 'Patient/qs-edge-p' }, ...extra }));
  refused(edgeFile([patient(), other('qs-edge-b'), entry(obs('qs-edge-z', { hasMember: [{ reference: 'Observation/qs-edge-b', type: 'Observation', display: 'Synthetic other-patient HbA1c 9.9%' }] }))]), 'EDGE_OWNER_MISMATCH');
  refused(edgeFile([patient(), other('qs-edge-b', { hasMember: [{ reference: 'Observation/qs-edge-z' }] }), entry(obs('qs-edge-z'))]), 'EDGE_OWNER_MISMATCH');
  refused(edgeFile([patient(), other('qs-edge-b', { derivedFrom: [{ reference: 'Patient/$natural' }] })]), 'EDGE_OWNER_MISMATCH');
  refused(edgeFile([patient(), entry(obs('qs-edge-z', { derivedFrom: [{ reference: 'Patient/qs-edge-p' }] }))]), 'EDGE_OWNER_MISMATCH');
  refused(edgeFile([patient('qs-edge-p', { managingOrganization: { reference: 'Patient/$natural' } })]), 'EDGE_SHAPE_INVALID');
  refused(edgeFile([patient('qs-edge-p', { generalPractitioner: [{ reference: 'Patient/qs-edge-p' }] })]), 'EDGE_SHAPE_INVALID');
  assert.deepEqual(merged(edgeFile([patient(), other('qs-edge-b'), other('qs-edge-c', { hasMember: [{ reference: 'Observation/qs-edge-b' }] })])),
    ['Patient/qs-edge-p', 'Observation/qs-edge-b', 'Observation/qs-edge-c'], 'same-patient links are allowed');
});

test('quickstart edges: edges are written targets first and reference cycles are refused', () => {
  const linked = mergeEdges(seedOf(), edgeFile([entry(obs('qs-edge-a', { hasMember: [{ reference: 'Observation/qs-edge-b', type: 'Observation' }] })),
    entry(obs('qs-edge-b', { subject: { reference: 'Patient/$natural', type: 'Patient' } }))]));
  assert.deepEqual(linked.manifest.resources.filter(r => r.origin === 'edge').map(put), ['Observation/qs-edge-b', 'Observation/qs-edge-a'], 'the target before its referrer');
  assert.match(linked.ndjson, /"hasMember":\[\{"reference":"Observation\/qs-edge-b","type":"Observation"\}\]/);
  assert.deepEqual(merged(edgeFile([entry(obs('qs-edge-a', { hasMember: [{ reference: 'Observation/qs-edge-c' }] })), entry(obs('qs-edge-b', { hasMember: [{ reference: 'Observation/qs-edge-a' }] })),
    entry(obs('qs-edge-c'))])), ['Observation/qs-edge-c', 'Observation/qs-edge-a', 'Observation/qs-edge-b']);
  refused(one(obs('qs-edge-a', { hasMember: [{ reference: 'Observation/qs-edge-a' }] })), 'EDGE_REFERENCE_CYCLE');
  refused(edgeFile([entry(obs('qs-edge-a', { hasMember: [{ reference: 'Observation/qs-edge-b' }] })), entry(obs('qs-edge-b', { hasMember: [{ reference: 'Observation/qs-edge-a' }] }))]), 'EDGE_REFERENCE_CYCLE');
});

test('quickstart edges: edges use only reviewed elements and datatypes, so nothing outside Reference.reference can address a resource', () => {
  for (const extra of [{ extension: [{ url: 'https://example.org/x', valueUri: 'Patient/synthetic-foreign' }] },
    { extension: [{ url: 'https://example.org/StructureDefinition/synthetic', valueRelatedArtifact: { type: 'derived-from', resource: 'https://example.org/fhir/Library/foreign' } }] },
    { extension: [{ url: 'https://example.org/x', valueDataRequirement: { profile: ['https://example.org/fhir/StructureDefinition/foreign'] } }] },
    { text: { status: 'generated', div: '<div xmlns="http://www.w3.org/1999/xhtml"><a href="https://example.org/fhir/Patient/foreign">x</a></div>' } },
    { implicitRules: 'https://example.org/rules' }, { performer: [{ reference: 'Patient/$natural' }] }, { identifier: [{ system: 'https://example.org/lab', value: 'x' }] },
    { code: { coding: [{ system: 'CodeSystem/local', code: '4548-4' }] } }, { code: { coding: [{ system: '', code: '4548-4' }] } }, { valueQuantity: { value: 5.5, unit: ' ' } },
    { note: [{ text: 'HbA1c', authorString: 'x' }] }, { note: [{ text: '   ' }] }])
    refused(one(obs('qs-edge-a', extra)), 'EDGE_SHAPE_INVALID');
  for (const content of [[{ attachment: { contentType: 'text/plain', url: 'Binary/synthetic' } }], [{ attachment: { contentType: 'text/plain', data: 'U3k=', url: 'https://example.org/n' } }],
    [{ attachment: { contentType: ' ', data: 'U3k=' } }], [], ['x'], [attachment(5)], [attachment('U3ludGhldGlj', '')]])
    refused(one(doc('qs-edge-d', content)), 'EDGE_SHAPE_INVALID');
  assert.equal(merged(one(obs('qs-edge-a', { code: { coding: [{ system: 'urn:uuid:00000000-0000-4000-8000-000000000010', code: 'local-1', display: 'Synthetic local code' }], text: 'Local' },
    interpretation: [{ coding: [{ system: 'urn:oid:2.16.840.1.113883.5.83', code: 'H' }], text: 'Patient/example and https://example.org/fhir/Patient/x are plain string values' }] }))).length, 1,
    'URN and OID code systems and ordinary string text are admitted');
});

test('quickstart edges: annotations refuse Markdown links and autolinks while plain string fields admit resource-looking text', () => {
  // Annotation.text is markdown; the reviewed tasks and shipped resources do not need this datatype.
  for (const text of ['[chart](https://example.org/fhir/Patient/foreign)', '<https://example.org/fhir/Patient/foreign>',
    '[chart](Patient/foreign)', '[chart][target]\n\n[target]: Patient/foreign', '![chart](Patient/foreign)',
    '<a href="Patient/foreign">chart</a>', 'Patient/example', 'ordinary annotation'])
    refused(one(obs('qs-edge-a', { note: [{ text }] })), 'EDGE_SHAPE_INVALID');
  for (const text of ['Patient/example', 'General laboratory observation', 'https://example.org/fhir/Patient/x'])
    assert.equal(merged(one(obs('qs-edge-a', { code: { ...hba1c, text } }))).length, 1, text);
  const shipped = parseFhirJson(SHIPPED.toString('utf8')) as { resources: { resource: Rec }[] };
  assert.ok(shipped.resources.every(({ resource }) => !('note' in resource)), 'the pinned edges require no annotations');
});

test('quickstart edges: lab Observations carry exactly a valid effectiveDateTime wholly inside the seed\'s half-open UTC window', () => {
  for (const extra of [{}, { effectiveDateTime: '2025-02-30' }, { effectiveDateTime: '2025-01-01T10:00:00' }])
    refused(one({ ...without(obs('qs-edge-a'), 'effectiveDateTime'), ...extra }), 'EDGE_DATE_INVALID');
  refused(one({ ...without(obs('qs-edge-a'), 'effectiveDateTime'), effectivePeriod: { start: '2025-01-01T00:00:00Z', end: '2025-01-02T00:00:00Z' } }), 'EDGE_SHAPE_INVALID');
  for (const extra of [{ effectivePeriod: { start: '1990-01-01', end: '1991-01-01' } }, { effectiveInstant: '1990-01-01T00:00:00Z' }, { effectiveTiming: { event: ['1990-01-01'] } }])
    refused(one(obs('qs-edge-a', extra)), 'EDGE_SHAPE_INVALID');
  for (const effectiveDateTime of ['2026-01-01T00:00:00Z', '2026', '2019-12-31T23:59:59Z', '2020-01-01T01:00:00+02:00', '2025-12-31T23:30:00-05:00'])
    refused(one(obs('qs-edge-a', { effectiveDateTime })), 'EDGE_OUTSIDE_WINDOW');
  for (const effectiveDateTime of ['2020-01-01T00:00:00Z', '2025', '2025-12-31T23:59:59.999Z', '2020-01-01T00:00:00-05:00'])
    assert.equal(mergeEdges(seedOf(), one(obs('qs-edge-a', { effectiveDateTime }))).manifest.edges.count, 1, effectiveDateTime);
  for (const date of ['2025-13-01', 'yesterday', '2025', '2025-11-03', '2025-11-03T09:00Z', '2025-11-03T09:00:00', '2025-02-30T09:00:00Z']) refused(one(doc('qs-edge-d', [attachment()], { date })), 'EDGE_DATE_INVALID');
  refused(one(doc('qs-edge-d', [attachment()], { date: 5 })), 'EDGE_SHAPE_INVALID');
  assert.equal(merged(one(doc('qs-edge-d', [attachment()], { date: '2019-01-01T00:00:00Z' }))).length, 1, 'a document date is validated, not windowed');
});

test('quickstart edges: documents carry canonical base64 inline data with a content type in every attachment', () => {
  for (const content of [undefined, [attachment('')], [attachment('abc')], [attachment('U3ludGhl dGlj')], [attachment('AB==')],
    [{ attachment: { data: 'U3ludGhldGlj' } }], [attachment(), { attachment: { contentType: 'text/plain' } }]])
    refused(one(doc('qs-edge-d', content)), 'EDGE_PAYLOAD_INVALID');
  assert.equal(mergeEdges(seedOf(), one(doc('qs-edge-d', [attachment(), attachment('U3k=', 'application/pdf')]))).manifest.edges.count, 1);
});

test('quickstart edges: at most one edge Patient, with no identifiers or links', () => {
  refused(edgeFile([patient('qs-edge-p1'), patient('qs-edge-p2')]), 'EDGE_PATIENT_INVALID');
  refused(edgeFile([patient('qs-edge-p1', { identifier: [{ system: 'https://example.org/mrn', value: 'synthetic-1' }] })]), 'EDGE_PATIENT_INVALID');
  refused(edgeFile([patient('qs-edge-p1', { link: [{ other: { reference: 'Patient/$natural' }, type: 'seealso' }] })]), 'EDGE_PATIENT_INVALID');
  assert.equal(mergeEdges(seedOf(), edgeFile([patient('qs-edge-p1')])).manifest.counts.Patient, 2);
});

test('quickstart edges: merged rows stay within the helper manifest\'s body, row, type and total limits', () => {
  refused(one(doc('qs-edge-d', [attachment('QUFB'.repeat(262_200))])), 'SEED_LIMIT_EXCEEDED');
  const selection = { ...QUICKSTART_SELECTION, maxResources: 5000, maxBytes: 8_000_000 };
  const big = [natural()[0]!, ...Array.from({ length: 2045 }, (_, i) => naturalLab(`n${i}`))];
  assert.equal(mergeEdges(seedOf(big, { selection }), edgeFile([entry(obs('qs-edge-a')), entry(obs('qs-edge-b'))])).manifest.resources.length, 2048);
  refused(edgeFile([entry(obs('qs-edge-a')), entry(obs('qs-edge-b')), entry(obs('qs-edge-c'))]), 'SEED_LIMIT_EXCEEDED', seedOf(big, { selection }));
  const heavy = Array.from({ length: 9 }, (_, i) => entry(doc(`qs-edge-d${i}`, [attachment('QUFB'.repeat(240_000))])));
  refused(edgeFile(heavy), 'SEED_LIMIT_EXCEEDED');
  assert.equal(merged(edgeFile(heavy.slice(0, 8))).length, 8, 'eight documents of about 0.96 MB stay within the total');
});

test('quickstart edges CLI: writes the merged seed into a new directory and refuses usage, missing, non-regular, oversized and non-empty paths with codes only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qs-edges-'));
  try {
    const seed = seedOf(), seedDir = join(dir, 'seed'), edgesPath = join(dir, 'edges.json');
    mkdirSync(seedDir);
    writeFileSync(join(seedDir, 'resources.ndjson'), seed.ndjson);
    writeFileSync(join(seedDir, 'seed-manifest.json'), `${JSON.stringify(seed.manifest, null, 2)}\n`);
    writeFileSync(edgesPath, SHIPPED);
    const out = join(dir, 'out'), result = mergeEdges(seed, SHIPPED);
    assert.deepEqual(runEdgesCli([seedDir, edgesPath, out]), { code: 0, line: `quickstart-edges: 7 resources (5 edge); ndjson sha256 ${result.manifest.ndjson_sha256}` });
    assert.equal(readFileSync(join(out, 'resources.ndjson'), 'utf8'), result.ndjson);
    assert.deepEqual(JSON.parse(readFileSync(join(out, 'seed-manifest.json'), 'utf8')), JSON.parse(JSON.stringify(result.manifest)));
    const emptyOut = join(dir, 'empty-out');
    mkdirSync(emptyOut);
    assert.equal(runEdgesCli([seedDir, edgesPath, emptyOut]).code, 0, 'an existing empty directory is replaced by the published output');
    const failed = (code: string) => ({ code: 1, line: `quickstart-edges: ${code}` });
    assert.deepEqual(runEdgesCli([seedDir, edgesPath, out]), failed('OUT_NOT_EMPTY'));
    assert.deepEqual(runEdgesCli([seedDir, edgesPath, edgesPath]), failed('OUT_NOT_EMPTY'));
    const fresh = join(dir, 'fresh');
    assert.deepEqual(runEdgesCli([seedDir, edgesPath]), failed('USAGE'));
    assert.deepEqual(runEdgesCli([seedDir, edgesPath, fresh, 'extra']), failed('USAGE'));
    assert.deepEqual(runEdgesCli([seedDir, join(dir, 'absent.json'), fresh]), failed('INPUT_MISSING'));
    const link = join(dir, 'link.json');
    symlinkSync(edgesPath, link);
    assert.deepEqual(runEdgesCli([seedDir, link, fresh]), failed('INPUT_MISSING'));
    assert.deepEqual(runEdgesCli([seedDir, seedDir, fresh]), failed('INPUT_MISSING'));
    const big = join(dir, 'big.json');
    writeFileSync(big, Buffer.concat([SHIPPED, Buffer.alloc(262_145 - SHIPPED.byteLength, 0x20)]));
    assert.deepEqual(runEdgesCli([seedDir, big, fresh]), failed('INPUT_TOO_LARGE'));
    const badId = join(dir, 'bad-id.json');
    writeFileSync(badId, one(obs('not-an-edge')));
    assert.deepEqual(runEdgesCli([seedDir, badId, fresh]), failed('EDGE_ID_INVALID'));
    const brokenSeed = join(dir, 'broken');
    mkdirSync(brokenSeed);
    writeFileSync(join(brokenSeed, 'resources.ndjson'), seed.ndjson);
    writeFileSync(join(brokenSeed, 'seed-manifest.json'), '{');
    assert.deepEqual(runEdgesCli([brokenSeed, edgesPath, fresh]), failed('SEED_INVALID'));
    const unreadable = join(dir, 'unreadable.json');
    writeFileSync(unreadable, SHIPPED);
    chmodSync(unreadable, 0o000);
    assert.deepEqual(runEdgesCli([seedDir, unreadable, fresh]), failed('IO_FAILED'), 'an I/O error surfaces as a fixed code without its path or message');
    let writes = 0;
    const flaky = (path: string, text: string) => { if (++writes === 2) throw new Error(`EIO: injected at ${path}`); writeFileSync(path, text); };
    assert.deepEqual(runEdgesCli([seedDir, edgesPath, fresh], { write: flaky }), failed('IO_FAILED'), 'a failed second write is a fixed code');
    assert.ok(!existsSync(fresh), 'no failed run creates the output directory');
    assert.deepEqual(readdirSync(dir).filter(name => name.includes('staging')), [], 'a failed run leaves no staging directory');
    assert.equal(runEdgesCli([seedDir, edgesPath, fresh]).code, 0, 'the identical retry succeeds');
    assert.equal(runEdgesCli([seedDir, edgesPath, join(dir, 'absent-parent', 'nested', 'out')]).code, 0, 'a missing output parent is created');
    // Each input is opened once, without following a link or blocking on a special file, and read only to its descriptor's size.
    const flags: number[] = [], fds = new Map<number, string>();
    const watched = { open: (path: string, f: number) => { flags.push(f); const fd = openSync(path, f); fds.set(fd, path); return fd; } };
    assert.equal(runEdgesCli([seedDir, edgesPath, join(dir, 'flags')], watched).code, 0);
    assert.equal(flags.length, 3);
    for (const f of flags) assert.ok((f & constants.O_NOFOLLOW) && (f & constants.O_NONBLOCK) && (f & 3) === constants.O_RDONLY, 'O_RDONLY | O_NOFOLLOW | O_NONBLOCK');
    const grown = { ...watched, fstat: (fd: number) => { const stat = fstatSync(fd); return fds.get(fd) === edgesPath ? { isFile: () => true, size: stat.size - 1 } : stat; } };
    assert.deepEqual(runEdgesCli([seedDir, edgesPath, join(dir, 'grown')], grown), failed('INPUT_CHANGED'), 'a file that grows after its size is read refuses');
    const shrunk = { ...watched, fstat: (fd: number) => { const stat = fstatSync(fd); return fds.get(fd) === edgesPath ? { isFile: () => true, size: stat.size + 1 } : stat; } };
    assert.deepEqual(runEdgesCli([seedDir, edgesPath, join(dir, 'shrunk')], shrunk), failed('INPUT_CHANGED'));
    const special = { ...watched, fstat: (fd: number) => fds.get(fd) === edgesPath ? { isFile: () => false, size: 0 } : fstatSync(fd) };
    assert.deepEqual(runEdgesCli([seedDir, edgesPath, join(dir, 'special')], special), failed('INPUT_MISSING'), 'a descriptor that is not a regular file refuses');
    // The output appears only complete: nothing at the target while files are written, both files staged before the rename.
    const visible = join(dir, 'visible'), staged: string[] = [];
    const publishing = { write: (path: string, data: string) => { assert.ok(!existsSync(visible), 'nothing published before both files are written'); writeFileSync(path, data); staged.push(path); },
      rename: (from: string, to: string) => { assert.ok(staged.length === 2 && staged.every(path => existsSync(path)), 'both files staged before the rename'); renameSync(from, to); } };
    assert.equal(runEdgesCli([seedDir, edgesPath, visible], publishing).code, 0);
    assert.deepEqual(readdirSync(visible).sort(), ['resources.ndjson', 'seed-manifest.json']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
