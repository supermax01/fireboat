import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { test } from 'node:test';
import { FhirGateway, type GatewayEnvelope } from '../packages/core/src/index.js';
// Namespace import: these tests also run against earlier module revisions when proving that they fail before a fix.
import * as privacy from '../packages/core/src/privacy.js';
import * as decimal from '../packages/core/src/decimal.js';
import type { FhirResource } from '../packages/core/src/contracts.js';
import * as schema from '../packages/core/src/schema.js';
import catalog from '../packages/core/src/generated/r4-index.json' with { type: 'json' };

const a = 'synthetic-patient-a';
const b = 'synthetic-patient-b';
const base = new URL('http://127.0.0.1:4321/fhir/');
const ok = (resource: FhirResource) => privacy.authorized(resource, a, base);
const obs = (extra: Record<string, unknown> = {}): FhirResource => ({ resourceType: 'Observation', id: 'o1', meta: { versionId: '3' }, status: 'final', code: { coding: [{ system: 'http://loinc.org', code: '4548-4' }], text: 'HbA1c' }, subject: { reference: `Patient/${a}` }, effectiveDateTime: '2026-01-02T10:00:00Z', ...extra });
const json = (value: unknown) => JSON.stringify(value);
/** Best (min) process CPU ms over 3 runs after a warmup. CPU time measures this process's own
 *  work, so linearity budgets stay meaningful when parallel suite copies inflate wall time. */
function cpuMs(fn: () => void): number {
  fn();
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 3; i++) {
    const start = process.cpuUsage();
    fn();
    const used = process.cpuUsage(start);
    best = Math.min(best, (used.user + used.system) / 1000);
  }
  return best;
}
const resources = (envelope: GatewayEnvelope) => envelope.data.resources as Record<string, unknown>[];

/** Loopback synthetic source: `reads` maps `Type/id` to a body; `searches` maps a type to its searchset entries. */
async function source(reads: Record<string, unknown>, searches: Record<string, unknown[]> = {}) {
  let baseUrl = '';
  const types = ['Patient', 'Observation', 'Medication', 'MedicationRequest', 'ServiceRequest', 'DocumentReference', 'DiagnosticReport', 'AllergyIntolerance', 'Coverage', 'Encounter', 'Condition', 'Location'];
  const metadata = { resourceType: 'CapabilityStatement', fhirVersion: '4.0.1', rest: [{ mode: 'server', resource: types.map(type => ({ type, interaction: [{ code: 'read' }, { code: 'search-type' }], searchParam: ['patient', 'subject', 'beneficiary', 'code'].map(name => ({ name })) })) }] };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url!, baseUrl);
    res.setHeader('content-type', 'application/fhir+json');
    const path = url.pathname.slice('/fhir/'.length);
    if (path === 'metadata') { res.end(json(metadata)); return; }
    if (!path.includes('/')) { res.end(json({ resourceType: 'Bundle', type: 'searchset', link: [{ relation: 'self', url: url.href }], entry: (searches[path] ?? []).map(resource => ({ resource, search: { mode: 'match' } })) })); return; }
    if (!Object.hasOwn(reads, path)) { res.statusCode = 404; res.end('{}'); return; }
    res.end(json(reads[path]));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind');
  baseUrl = `http://127.0.0.1:${address.port}/fhir/`;
  return { baseUrl, gateway: () => new FhirGateway({ mode: 'synthetic', source: { alias: 'fixture', baseUrl }, patientId: a }), close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }) };
}

// ---------------------------------------------------------------- J-3 ------

test('J-3: Patient references are classified once with case-insensitive scheme/host and normalized history', () => {
  const parse = (value: string) => privacy.parseReference(value, base);
  assert.deepEqual(parse(`Patient/${a}/_history/3`), { form: 'relative', type: 'Patient', id: a, version: '3', sameSource: true, patientLike: true });
  assert.deepEqual(parse(`HTTP://127.0.0.1:4321/fhir/Patient/${b}`), { form: 'absolute', type: 'Patient', id: b, sameSource: true, patientLike: true });
  assert.equal(parse(`https://other.example/fhir/Patient/${a}`).sameSource, false);
  assert.equal(parse('Patient?identifier=urn:mrn|B').form, 'conditional');
  assert.equal(parse('urn:uuid:00000000-0000-0000-0000-000000000001').form, 'urn');
  assert.equal(parse('#med1').form, 'contained');
  assert.deepEqual(parse('patient/B'), { form: 'unsupported', patientLike: true });
  assert.equal(parse(`http://127.0.0.1:4321/fhir/%50atient/${b}`).patientLike, true);
  assert.equal(parse(`Patient:${b}`).patientLike, true);
  assert.deepEqual(parse('https://patient-portal.example/fhir/Observation/o1'), { form: 'absolute', type: 'Observation', id: 'o1', sameSource: false, patientLike: false });
});

test('J-3: the bound patient is recognized in versioned, absolute and mixed-case forms', () => {
  for (const reference of [`Patient/${a}/_history/3`, `HTTP://127.0.0.1:4321/fhir/Patient/${a}`, `http://127.0.0.1:4321/fhir/Patient/${a}/_history/2`, `http://127.0.0.1:4321/fhir/x/../Patient/${a}`]) {
    assert.equal(ok(obs({ subject: { reference } })), true, reference);
    assert.equal(ok(obs({ performer: [{ reference }] })), true, reference);
  }
});

test('J-3: foreign, conditional, logical, urn, contained and unsupported Patient forms are denied, never resolved', () => {
  const denied: unknown[] = [
    { reference: `HTTP://127.0.0.1:4321/fhir/Patient/${b}`, display: 'SYNTHETIC_B_PRIVATE' },
    { reference: `http://127.0.0.1:4321/fhir/Patient/${b}/_history/1` },
    { reference: `Patient/${b}/_history/1` },
    { reference: `patient/${b}` },
    { reference: `PATIENT/${a}` },
    { reference: 'Patient?identifier=urn:synthetic:mrn|B' },
    { reference: `https://other.example/fhir/Patient/${a}` },
    { reference: `http://127.0.0.1:4321/fhir/Patient/${a}?x=1` },
    { reference: `http://127.0.0.1:4321/fhir/%50atient/${b}` },
    { reference: ` Patient/${a}` },
    { type: 'Patient', identifier: { system: 'urn:synthetic:mrn', value: 'B' } },
    { type: 'http://hl7.org/fhir/StructureDefinition/Patient', display: 'SYNTHETIC_B_PRIVATE' },
    { identifier: { system: 'urn:synthetic:mrn', value: 'B' } },
    { reference: 'urn:uuid:00000000-0000-0000-0000-000000000001' },
    { reference: `Patient/${a}`, type: 'Practitioner' },
    { reference: 'Practitioner/p1', type: 'Patient' },
    { reference: 'not a reference' },
  ];
  for (const performer of denied) assert.equal(ok(obs({ performer: [performer] })), false, json(performer));
  assert.equal(ok(obs({ subject: { reference: 'Patient?identifier=urn:synthetic:mrn|A' } })), false);
  assert.equal(ok(obs({ subject: { type: 'Patient', identifier: { value: 'A' } } })), false);
  assert.equal(ok(obs({ contained: [{ resourceType: 'Patient', id: a }], performer: [{ reference: `#${a}` }] })), false, 'a contained Patient is never the trusted record');
  // A raw Patient-shaped reference outside a declared Reference element is still judged.
  assert.equal(ok(obs({ code: { text: 'x', reference: `Patient/${b}` } })), false);
});

test('J-3: non-Patient targets keep working, including elements that cannot target a Patient', () => {
  const allowed: [string, unknown][] = [
    ['performer', [{ reference: 'Practitioner/p1', display: 'Synthetic clinician' }]],
    ['performer', [{ reference: 'https://other.example/fhir/Practitioner/p1' }]],
    ['performer', [{ reference: 'urn:uuid:00000000-0000-0000-0000-000000000002', type: 'Practitioner' }]],
    ['performer', [{ display: 'Synthetic clinician' }]],
    ['performer', [{ identifier: { system: 'http://hl7.org/fhir/sid/us-npi', value: '0000000000' }, type: 'Practitioner' }]],
    ['device', { reference: 'urn:uuid:00000000-0000-0000-0000-000000000003' }],
    ['device', { identifier: { value: 'synthetic-device' } }],
    ['hasMember', [{ reference: '#local-observation' }]],
    ['extension', [{ url: 'http://hl7.org/fhir/StructureDefinition/cqf-expression', valueExpression: { language: 'text/cql', reference: 'http://example.org/Library/synthetic#Expr' } }]],
    ['meta', { versionId: '1', compartment: [{ reference: `Patient/${a}` }, { reference: 'Project/synthetic' }] }],
  ];
  for (const [key, value] of allowed) assert.equal(ok(obs({ [key]: value })), true, `${key} ${json(value)}`);
});

test('J-3: the bound Patient record is returned despite Patient.link while the foreign link stays withheld', async t => {
  const patient = { resourceType: 'Patient', id: a, active: true, name: [{ family: 'SyntheticA' }], link: [{ other: { reference: `Patient/${b}`, display: 'SYNTHETIC_B_PRIVATE' }, type: 'replaced-by' }] };
  assert.equal(ok(patient), true);
  const sanitized = privacy.sanitize(patient);
  assert.equal(sanitized.requiresStructuralView, true, 'Patient.link is a modifier and its target was withheld');
  assert.ok(sanitized.manifests.some(manifest => manifest.reason === 'FOREIGN_PATIENT_REFERENCE_WITHHELD' && manifest.path === '/link/0/other'));
  assert.deepEqual((sanitized.resource.link as unknown[])[0], { type: 'replaced-by' });
  const f = await source({ [`Patient/${a}`]: patient }); t.after(f.close);
  const gateway = f.gateway();
  const read = await gateway.execute('fhir_read', { resource_type: 'Patient', id: a });
  assert.equal(read.error, undefined);
  assert.ok(read.warnings.some(warning => warning.code === 'UNINTERPRETED_MODIFIER'));
  const projected = await gateway.execute('fhir_result', { handle: read.result!.handle, action: 'project', fields: ['link', 'name'] });
  assert.equal(projected.error, undefined);
  for (const envelope of [read, projected]) { assert.ok(!json(envelope).includes(b)); assert.ok(!json(envelope).includes('SYNTHETIC_B_PRIVATE')); }
});

test('J-3: foreign Coverage subscriber and policyHolder keep the default deny', () => {
  const coverage = { resourceType: 'Coverage', id: 'c1', status: 'active', beneficiary: { reference: `Patient/${a}` }, payor: [{ reference: 'Organization/o1' }] };
  assert.equal(ok(coverage), true);
  assert.equal(ok({ ...coverage, subscriber: { reference: `Patient/${b}` } }), false);
  assert.equal(ok({ ...coverage, policyHolder: { reference: `Patient/${b}` } }), false);
});

test('J-3: gateway read and search refuse case-variant foreign references and accept versioned subjects', async t => {
  const leaky = obs({ id: 'o-leak', performer: [{ reference: '', display: 'SYNTHETIC_B_PRIVATE' }] });
  const versioned = obs({ id: 'o-versioned', subject: { reference: `Patient/${a}/_history/7` } });
  const f = await source({ 'Observation/o-leak': leaky, 'Observation/o-versioned': versioned }, { Observation: [versioned, leaky] });
  t.after(f.close);
  (leaky.performer as { reference: string }[])[0]!.reference = `${f.baseUrl.toUpperCase().replace('/FHIR/', '/fhir/')}Patient/${b}`;
  const gateway = f.gateway();
  const denied = await gateway.execute('fhir_read', { resource_type: 'Observation', id: 'o-leak', output: { format: 'fhir' } });
  assert.equal(denied.error?.code, 'NOT_FOUND');
  const read = await gateway.execute('fhir_read', { resource_type: 'Observation', id: 'o-versioned' });
  assert.equal(read.error, undefined);
  const search = await gateway.execute('fhir_search', { resource_type: 'Observation', output: { format: 'fhir' } });
  assert.equal(search.error, undefined);
  assert.deepEqual(resources(search).map(resource => resource.id), ['o-versioned']);
  const retained = await gateway.execute('fhir_result', { handle: search.result!.handle, action: 'project', fields: ['performer', 'subject'], output: { format: 'fhir' } });
  for (const envelope of [denied, search, retained]) { assert.ok(!json(envelope).includes(b)); assert.ok(!json(envelope).includes('SYNTHETIC_B_PRIVATE')); }
});

// ---------------------------------------------------------------- J-4 ------

const negated = { resourceType: 'MedicationRequest', id: 'mr1', meta: { versionId: '2' }, status: 'active', intent: 'order', doNotPerform: true, medicationCodeableConcept: { coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '0000' }], text: 'Synthetic drug' }, subject: { reference: `Patient/${a}` }, authoredOn: '2026-01-01', note: [{ text: 'synthetic note' }] };

test('J-4: compact keeps negation, status and intent modifiers with their facts', () => {
  const view = privacy.projection(negated, 'compact');
  assert.equal(view.resource.doNotPerform, true);
  assert.equal(view.resource.status, 'active');
  assert.equal(view.resource.intent, 'order');
  assert.deepEqual(view.resource.medicationCodeableConcept, negated.medicationCodeableConcept, 'code systems survive');
  assert.deepEqual(view.resource.meta, { versionId: '2' });
  assert.ok(view.omitted.includes('/note'));
  assert.match(String(view.recipe), /MedicationRequest\.compact/);
});

test('J-4: selected-field and retained projections add modifiers instead of silently dropping them', async t => {
  const view = privacy.projection(negated, 'compact', ['medicationCodeableConcept']);
  assert.equal(view.resource.doNotPerform, true);
  assert.equal(view.resource.intent, 'order');
  assert.ok(view.warnings?.some(warning => warning.code === 'MODIFIER_FIELDS_ADDED'));
  const allergy = { resourceType: 'AllergyIntolerance', id: 'al1', patient: { reference: `Patient/${a}` }, reaction: [{ severity: 'severe', modifierExtension: [{ url: 'http://example.org/refuted', valueBoolean: true }], description: 'x' }] };
  assert.deepEqual(privacy.projection(allergy, 'fhir', ['reaction.severity']).resource.reaction, [{ severity: 'severe', modifierExtension: allergy.reaction[0]!.modifierExtension }]);
  const f = await source({ 'MedicationRequest/mr1': negated }); t.after(f.close);
  const gateway = f.gateway();
  for (const output of [{ format: 'compact' }, { format: 'compact', fields: ['medicationCodeableConcept'] }]) {
    const read = await gateway.execute('fhir_read', { resource_type: 'MedicationRequest', id: 'mr1', output });
    assert.equal(read.error, undefined);
    assert.equal(resources(read)[0]?.doNotPerform, true, json(output));
    const retained = await gateway.execute('fhir_result', { handle: read.result!.handle, action: 'project', fields: ['authoredOn'] });
    assert.equal(resources(retained)[0]?.doNotPerform, true);
  }
});

test('J-4: choice elements are kept whole and types without a reviewed recipe fall back to the full view', () => {
  for (const effective of [{ effectiveInstant: '2026-01-02T10:00:00.000Z' }, { effectiveTiming: { event: ['2026-01-02'] } }, { effectivePeriod: { start: '2026-01-02' } }]) {
    const resource = obs({ effectiveDateTime: undefined, ...effective });
    delete resource.effectiveDateTime;
    assert.deepEqual(Object.keys(effective).map(key => privacy.projection(resource, 'compact').resource[key]), Object.values(effective));
  }
  const condition = { resourceType: 'Condition', id: 'c1', clinicalStatus: { coding: [{ code: 'resolved' }] }, code: { text: 'x' }, subject: { reference: `Patient/${a}` }, abatementDateTime: '2020-01-01' };
  assert.equal(privacy.projection(condition, 'compact').resource.abatementDateTime, '2020-01-01');
  const service = { resourceType: 'ServiceRequest', id: 's1', status: 'active', intent: 'order', doNotPerform: true, code: { text: 'Synthetic procedure' }, subject: { reference: `Patient/${a}` }, note: [{ text: 'kept' }] };
  const view = privacy.projection(service, 'compact');
  assert.deepEqual(view.resource, service);
  assert.ok(view.warnings?.some(warning => warning.code === 'COMPACT_RECIPE_UNAVAILABLE'));
});

test('J-4: a policy-withheld modifier value prohibits a confident clinical view', () => {
  const withheldModifier = privacy.sanitize(obs({ status: 'https://x.invalid/status?token=MODIFIER_VALUE_SECRET' }));
  assert.equal(withheldModifier.resource.status, undefined);
  assert.equal(withheldModifier.requiresStructuralView, true);
  const withheldOrdinary = privacy.sanitize(obs({ extension: [{ url: 'http://example.org/u', valueUri: 'relative?x=ORDINARY_SECRET' }] }));
  assert.equal(withheldOrdinary.manifests.length, 1);
  assert.equal(withheldOrdinary.requiresStructuralView, false);
});

test('J-4: every reviewed recipe names real R4 elements and keeps every root modifier', () => {
  const recipes = privacy.COMPACT_RECIPES;
  assert.ok(Object.keys(recipes).length >= 8);
  for (const [type, recipe] of Object.entries(recipes)) {
    const names = schema.elementNames(type);
    for (const field of recipe.fields) assert.ok(names.includes(field), `${type}.${field}`);
    // Nested modifiers are either modifierExtension (forces the structural view) or live inside a kept element.
    const elements = (catalog.definitions as Record<string, { elements: Record<string, { modifier?: boolean }> }>)[type]!.elements;
    for (const [path, element] of Object.entries(elements)) {
      if (!element.modifier || !path.includes('.')) continue;
      assert.ok(path.endsWith('.modifierExtension') || recipe.fields.includes(path.split('.')[0]!), `${type}.${path}`);
    }
    const resource: FhirResource = { resourceType: type, id: 'x' };
    for (const modifier of schema.modifierElements(type)) {
      if (modifier === 'modifierExtension' || modifier === 'implicitRules') continue;
      resource[modifier.replace('[x]', 'Boolean')] = modifier.endsWith('[x]') ? true : modifier === 'link' ? [{ type: 'seealso' }] : 'synthetic-modifier-value';
    }
    const view = privacy.projection(resource, 'compact');
    for (const key of Object.keys(resource)) assert.ok(Object.hasOwn(view.resource, key), `${type} compact dropped modifier ${key}`);
  }
});

// ---------------------------------------------------------------- J-10 -----

const catalogMedication = { resourceType: 'Medication', id: 'synthetic-med-1', meta: { versionId: '1' }, status: 'active', code: { coding: [{ system: 'http://example.invalid/synthetic-rx', code: 'synthetic-rx-001', display: 'Synthetic Medication One' }], text: 'Synthetic Medication One' }, form: { coding: [{ system: 'http://example.invalid/synthetic-form', code: 'tablet' }] } };

test('J-10: shared access needs an explicit versioned instance policy, not a type name', () => {
  assert.equal(privacy.resourceClass('Medication'), 'shared');
  assert.equal(privacy.SHARED_INSTANCE_POLICY.version, '2026-10-19.1');
  const positives: Record<string, unknown>[] = [
    catalogMedication,
    { resourceType: 'Medication', id: 'combo', code: catalogMedication.code, ingredient: [{ itemCodeableConcept: { coding: [{ system: 'http://example.invalid/synthetic-rx', code: 'part' }] } }] },
    { resourceType: 'Organization', id: 'org1', active: true, name: 'Synthetic Clinic', identifier: [{ system: 'http://example.invalid/org', value: '1' }] },
    { resourceType: 'Location', id: 'loc1', status: 'active', name: 'Synthetic Ward', physicalType: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/location-physical-type', code: 'wa' }] } },
    { resourceType: 'Practitioner', id: 'pr1', name: [{ family: 'Synthetic' }] },
    { resourceType: 'ValueSet', id: 'vs1', status: 'active', url: 'http://example.invalid/vs', compose: { include: [{ system: 'http://loinc.org' }] } },
  ];
  for (const resource of positives) { assert.equal(privacy.sharedInstanceAllowed(resource), true, json(resource)); assert.equal(ok(resource as FhirResource), true); }
  const negatives: Record<string, unknown>[] = [
    { ...catalogMedication, identifier: [{ system: 'urn:synthetic:compounding', value: `${b}-compound` }] },
    { resourceType: 'Medication', id: 'compound', code: { text: `Compounded for ${b}` } },
    { resourceType: 'Medication', id: 'compound2', ingredient: [{ itemCodeableConcept: { text: 'x' } }] },
    { ...catalogMedication, batch: { lotNumber: 'synthetic-lot' } },
    { ...catalogMedication, extension: [{ url: 'http://example.invalid/patient-note', valueString: b }] },
    { ...catalogMedication, code: { ...catalogMedication.code, coding: [{ ...catalogMedication.code.coding[0], extension: [{ url: 'http://example.invalid/x', valueString: 'y' }] }] } },
    { ...catalogMedication, modifierExtension: [{ url: 'http://example.invalid/m', valueBoolean: true }] },
    { ...catalogMedication, implicitRules: 'http://example.invalid/rules' },
    { ...catalogMedication, meta: { security: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-Confidentiality', code: 'R' }] } },
    { ...catalogMedication, meta: { profile: ['http://example.invalid/StructureDefinition/patient-compound'] } },
    { resourceType: 'Location', id: 'home', type: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-RoleCode', code: 'PTRES' }] }] },
    { resourceType: 'Location', id: 'house', physicalType: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/location-physical-type', code: 'ho' }] } },
    { resourceType: 'Organization', id: 'org2', contact: [{ name: { family: 'Private' } }] },
    { resourceType: 'Substance', id: 'sub1' },
  ];
  for (const resource of negatives) { assert.equal(privacy.sharedInstanceAllowed(resource), false, json(resource)); assert.equal(ok(resource as FhirResource), false, json(resource)); }
  assert.equal(ok(obs({ contained: [{ resourceType: 'Medication', id: 'm1', code: { text: `Compounded for ${b}` } }] })), false, 'policy also applies to contained shared resources');
});

test('J-10: a patient-specific Medication instance is unavailable through the gateway while catalog entries stay readable', async t => {
  const f = await source({ 'Medication/synthetic-med-1': catalogMedication, 'Medication/med-b': { resourceType: 'Medication', id: 'med-b', code: { text: `Compound for ${b}` }, identifier: [{ value: `${b}-compound` }] } }); t.after(f.close);
  const gateway = f.gateway();
  assert.equal((await gateway.execute('fhir_read', { resource_type: 'Medication', id: 'synthetic-med-1' })).error, undefined);
  const denied = await gateway.execute('fhir_read', { resource_type: 'Medication', id: 'med-b' });
  assert.equal(denied.error?.code, 'NOT_FOUND');
  assert.ok(!json(denied).includes(b));
});

// ---------------------------------------------------------------- J-11 -----

test('J-11: withheld-payload manifests use only independently validated metadata', () => {
  const secret = 'MANIFEST_SECRET';
  // The URL-shaped contentType and hash are screened out of the resource; manifests must not copy them back.
  const hostile = { resourceType: 'DocumentReference', id: 'd1', status: 'current', subject: { reference: `Patient/${a}` }, content: [
    { attachment: { contentType: `https://files.invalid/doc?token=${secret}`, data: 'QUJD', hash: `https://files.invalid/h?token=${secret}`, size: -5 } },
    { attachment: { contentType: 'text/plain; x="QUOTED_PARAMETER"', data: 'QUJD', hash: 'c3ludGhldGljLWhhc2g=', size: 2147483648 } },
    { attachment: { contentType: 'text/plain', url: 'https://files.invalid/d', size: 1.5 } },
    { attachment: { contentType: 'text/plain', data: 'QUJD', size: '12' } },
  ] };
  const result = privacy.sanitize(hostile);
  assert.ok(!json(result.manifests).includes(secret));
  assert.ok(!json(result).includes(secret));
  assert.ok(!json(result.manifests).includes('QUOTED_PARAMETER'));
  assert.ok(!json(result.manifests).includes('c3ludGhldGljLWhhc2g='), 'wrong-length hash is not a SHA-1');
  for (const manifest of result.manifests) { assert.equal(manifest.size, undefined); assert.equal(manifest.hash, undefined); }
  assert.ok(result.manifests.filter(manifest => manifest.content_type === 'text/plain').length >= 2);
  const hash = Buffer.alloc(20, 7).toString('base64');
  const valid = privacy.sanitize({ resourceType: 'DocumentReference', id: 'd2', content: [{ attachment: { contentType: 'Application/PDF; charset=UTF-8; name=x', data: 'QUJD', size: 1234, hash } }] });
  assert.deepEqual(valid.manifests, [{ path: '/content/0/attachment/data', reason: 'V1_PAYLOAD_WITHHELD', content_type: 'application/pdf; charset=utf-8', size: 1234, hash }]);
});

test('J-11: hostile manifest metadata never reaches the envelope or a retained projection', async t => {
  const doc = { resourceType: 'DocumentReference', id: 'd1', status: 'current', subject: { reference: `Patient/${a}` }, content: [{ attachment: { contentType: 'https://files.invalid/doc?token=MANIFEST_ENVELOPE_SECRET', data: 'QUJD', hash: 'https://files.invalid/h#MANIFEST_ENVELOPE_SECRET' } }] };
  const f = await source({ 'DocumentReference/d1': doc }); t.after(f.close);
  const gateway = f.gateway();
  const read = await gateway.execute('fhir_read', { resource_type: 'DocumentReference', id: 'd1', output: { format: 'fhir' } });
  assert.equal(read.error, undefined);
  assert.ok(read.transform.withheld_payloads.length >= 2);
  const projected = await gateway.execute('fhir_result', { handle: read.result!.handle, action: 'project', fields: ['content'], output: { format: 'fhir' } });
  assert.equal(projected.error, undefined);
  assert.ok(!json([read, projected]).includes('MANIFEST_ENVELOPE_SECRET'));
});

// ---------------------------------------------------------------- J-12 -----

const masked = { extension: [{ url: 'http://hl7.org/fhir/StructureDefinition/data-absent-reason', valueCode: 'masked' }] };

test('J-12: extension-only primitives survive field selection at root, nested and in aligned arrays', () => {
  const patient = { resourceType: 'Patient', id: a, _birthDate: masked, name: [{ family: 'Synthetic', _given: [masked] }, { given: ['Alpha', null], _given: [null, masked] }], identifier: [{ value: 'x' }] };
  const root = privacy.projection(patient, 'fhir', ['birthDate']);
  assert.deepEqual(root.unresolved, []);
  assert.deepEqual(root.resource._birthDate, masked);
  assert.equal(Object.hasOwn(root.resource, 'birthDate'), false, 'no value is fabricated');
  const nested = privacy.projection(patient, 'fhir', ['name.given']);
  assert.deepEqual(nested.unresolved, []);
  assert.deepEqual(nested.resource.name, [{ _given: [masked] }, { given: ['Alpha', null], _given: [null, masked] }]);
  assert.deepEqual(privacy.projection(patient, 'fhir', ['birthDate.extension']).resource._birthDate, masked);
  assert.deepEqual(privacy.projection(patient, 'compact').resource._birthDate, masked);
});

test('J-12: read and retained projections keep a masked birth date distinguishable from an unknown one', async t => {
  const f = await source({ [`Patient/${a}`]: { resourceType: 'Patient', id: a, _birthDate: masked, gender: 'female' } }); t.after(f.close);
  const gateway = f.gateway();
  const read = await gateway.execute('fhir_read', { resource_type: 'Patient', id: a, output: { format: 'fhir', fields: ['birthDate'] } });
  assert.equal(read.error, undefined);
  assert.deepEqual(resources(read)[0]?._birthDate, masked);
  assert.deepEqual(read.transform.unresolved_fields, []);
  const retained = await gateway.execute('fhir_result', { handle: read.result!.handle, action: 'project', fields: ['birthDate'] });
  assert.deepEqual(resources(retained)[0]?._birthDate, masked);
  assert.ok(!retained.warnings.some(warning => warning.code === 'UNRESOLVED_FIELDS'));
});

// ---------------------------------------------------------------- J-24 -----

test('J-24: prose keeps clinical shorthand and redacts only URL spans', () => {
  const kept = ['Sig: 1 tab PO q6h PRN pain #30', 'Assessment: #1 HTN', 'History: ?MI in 2019', 'Sig: 1 tab PO daily', 'Data: 120/80 at rest', 'Patient file: reviewed'];
  const kept_ = privacy.sanitize(obs({ note: kept.map(text => ({ text })) }));
  assert.deepEqual((kept_.resource.note as { text: string }[]).map(note => note.text), kept);
  assert.deepEqual(kept_.manifests, []);
  const secret = 'PROSE_LINK_SECRET';
  const prose: [string, string][] = [
    [`Take 1 tab https://x.invalid/a?token=${secret} daily`, `Take 1 tab ${privacy.TEXT_LINK_PLACEHOLDER} daily`],
    [`See HTTPS://files.invalid/${secret}.`, `See ${privacy.TEXT_LINK_PLACEHOLDER}.`],
    [`Portal //files.invalid/p?k=${secret} now`, `Portal ${privacy.TEXT_LINK_PLACEHOLDER} now`],
    [`Visit www.files.invalid/${secret} today`, `Visit ${privacy.TEXT_LINK_PLACEHOLDER} today`],
    [`Click  JaVaScRiPt:alert('${secret}')`, `Click  ${privacy.TEXT_LINK_PLACEHOLDER}`],
    [`Image DATA:text/html;base64,${secret}`, `Image ${privacy.TEXT_LINK_PLACEHOLDER}`],
    [`Open file:///tmp/${secret} later`, `Open ${privacy.TEXT_LINK_PLACEHOLDER} later`],
    [`Blob blob:https://x.invalid/${secret}`, `Blob ${privacy.TEXT_LINK_PLACEHOLDER}`],
    [`Mail mailto:${secret}@x.invalid please`, `Mail ${privacy.TEXT_LINK_PLACEHOLDER} please`],
    [`[portal](https://x.invalid/a?t=${secret}) for results`, `[portal](${privacy.TEXT_LINK_PLACEHOLDER}) for results`],
  ];
  const result = privacy.sanitize(obs({ note: prose.map(([text]) => ({ text })), valueString: `Result at https://x.invalid/r?sig=${secret}` }));
  assert.deepEqual((result.resource.note as { text: string }[]).map(note => note.text), prose.map(([, expected]) => expected));
  assert.ok(!json(result).includes(secret));
  assert.equal(result.resource.valueString, `Result at ${privacy.TEXT_LINK_PLACEHOLDER}`);
  assert.ok(result.manifests.every(manifest => manifest.reason === 'PROTECTED_LINK_IN_TEXT'));
  assert.equal(result.manifests.length, prose.length + 1);
});

test('J-24: typed URI elements keep strict whole-value screening', () => {
  const result = privacy.sanitize(obs({ extension: [{ url: 'http://example.org/u', valueUri: 'relative?x=TYPED_URI_SECRET' }, { url: 'http://example.org/c', valueCanonical: 'http://example.org/vs|1' }] }));
  assert.ok(!json(result).includes('TYPED_URI_SECRET'));
  assert.ok(result.manifests.some(manifest => manifest.reason === 'PROTECTED_LINK' && manifest.path === '/extension/0/valueUri'));
  assert.equal((result.resource.extension as Record<string, unknown>[])[1]?.valueCanonical, 'http://example.org/vs|1');
});

test('J-24: Sig prose survives a gateway read while an embedded capability URL does not', async t => {
  const f = await source({ 'Observation/o1': obs({ note: [{ text: 'Sig: 1 tab PO q6h PRN pain #30' }, { text: 'Take 1 tab https://x.invalid/a?token=GATEWAY_PROSE_SECRET daily' }] }) }); t.after(f.close);
  const read = await f.gateway().execute('fhir_read', { resource_type: 'Observation', id: 'o1', output: { format: 'fhir' } });
  assert.equal(read.error, undefined);
  assert.deepEqual(resources(read)[0]?.note, [{ text: 'Sig: 1 tab PO q6h PRN pain #30' }, { text: `Take 1 tab ${privacy.TEXT_LINK_PLACEHOLDER} daily` }]);
  assert.ok(!json(read).includes('GATEWAY_PROSE_SECRET'));
});

// ---------------------------------------------------------------- J-36 -----

test('J-36: Attachment URLs are withheld from schema context even without contentType or a query', async t => {
  const capability = 'https://files.invalid/p/ATTACHMENT_CAPABILITY_PATH';
  const patient = { resourceType: 'Patient', id: a, photo: [{ url: capability, title: 'portrait' }] };
  const report = { resourceType: 'DiagnosticReport', id: 'r1', status: 'final', code: { text: 'x' }, subject: { reference: `Patient/${a}` }, presentedForm: [{ url: `${capability}/report` }] };
  for (const resource of [patient, report]) {
    const result = privacy.sanitize(resource);
    assert.ok(!json(result).includes('ATTACHMENT_CAPABILITY_PATH'), resource.resourceType);
    assert.equal(result.manifests[0]?.reason, 'PROTECTED_LINK');
  }
  assert.equal((privacy.sanitize(obs({ extension: [{ url: 'http://example.org/info', valueUrl: 'https://example.org/info' }] })).resource.extension as Record<string, unknown>[])[0]?.valueUrl, 'https://example.org/info', 'ordinary query-free URL elements stay usable');
  const f = await source({ [`Patient/${a}`]: patient, 'DiagnosticReport/r1': report }); t.after(f.close);
  const gateway = f.gateway();
  for (const [type, id, field] of [['Patient', a, 'photo'], ['DiagnosticReport', 'r1', 'presentedForm']] as const) {
    const read = await gateway.execute('fhir_read', { resource_type: type, id, output: { format: 'fhir' } });
    assert.equal(read.error, undefined);
    const retained = await gateway.execute('fhir_result', { handle: read.result!.handle, action: 'project', fields: [field] });
    assert.ok(!json([read, retained]).includes('ATTACHMENT_CAPABILITY_PATH'));
  }
});

// ---------------------------------------------------------------- J-13 -----

test('J-13: a canonical under a primitive companion reaches neither the read envelope nor a retained projection', async t => {
  const resource = obs({ _status: { extension: [{ url: 'http://example.org/artifact', valueRelatedArtifact: { type: 'depends-on', resource: 'Library/x?sig=COMPANION_GATEWAY_SECRET' } }, { url: 'http://example.org/oid', valueOid: 'urn:oid:1.2.3?COMPANION_GATEWAY_SECRET' }] } });
  const f = await source({ 'Observation/o1': resource }); t.after(f.close);
  const gateway = f.gateway();
  for (const format of ['compact', 'fhir'] as const) {
    const read = await gateway.execute('fhir_read', { resource_type: 'Observation', id: 'o1', output: { format } });
    assert.equal(read.error, undefined);
    const retained = await gateway.execute('fhir_result', { handle: read.result!.handle, action: 'project', fields: ['status'], output: { format } });
    assert.equal(retained.error, undefined);
    assert.ok(Object.hasOwn(resources(retained)[0]!, '_status'));
    assert.ok(!json([read, retained]).includes('COMPANION_GATEWAY_SECRET'));
  }
});

// ------------------------------------------------------ J-18 egress tests --

test('J-18: data:, javascript: and file: schemes are withheld even when padded, mixed-case and query-free', () => {
  const values = ['  JaVaScRiPt:alert(1)', '\tDaTa:text/html,<b>SCHEME_SENTINEL</b>', 'FILE:///etc/SCHEME_SENTINEL', ' data:,SCHEME_SENTINEL', 'java\tscript:alert(1)', '\u0000javascript:alert(1)'];
  for (const value of values) {
    for (const extension of [{ url: 'http://example.org/u', valueUri: value }, { url: 'http://example.org/l', valueUrl: value }]) {
      const result = privacy.sanitize(obs({ extension: [extension] }));
      assert.equal((result.resource.extension as Record<string, unknown>[])[0]?.valueUri ?? (result.resource.extension as Record<string, unknown>[])[0]?.valueUrl, undefined, json(value));
      assert.ok(result.manifests.some(manifest => manifest.reason === 'PROTECTED_LINK'));
    }
    const coding = privacy.sanitize(obs({ code: { coding: [{ system: value, code: 'x' }] } }));
    assert.equal((coding.resource.code as { coding: Record<string, unknown>[] }).coding[0]?.system, undefined, json(value));
  }
  const unknown = privacy.sanitize(obs({ vendorField: '\u0001javascript:alert(1)' }));
  assert.equal(unknown.resource.vendorField, undefined, 'leading control characters cannot hide a scheme in an untyped value');
  assert.deepEqual(privacy.sanitize(obs({ extension: [{ url: 'http://example.org/u', valueUri: 'https://example.org/plain' }] })).manifests, []);
});

test('J-18: narrative is omitted on resources, contained resources and Bundle entries while CodeableConcept.text survives', async t => {
  const narrative = { status: 'generated', div: '<div xmlns="http://www.w3.org/1999/xhtml">NARRATIVE_SENTINEL</div>' };
  const resource = obs({ text: narrative, contained: [{ resourceType: 'Practitioner', id: 'pr1', text: narrative, name: [{ text: 'Practitioner text survives' }] }], note: [{ text: 'Annotation text survives' }] });
  const result = privacy.sanitize(resource);
  assert.ok(!json(result).includes('NARRATIVE_SENTINEL'));
  assert.ok(result.omitted.includes('/text'));
  assert.ok(result.omitted.includes('/contained/0/text'));
  assert.equal((result.resource.code as { text: string }).text, 'HbA1c');
  assert.equal((result.resource.note as { text: string }[])[0]?.text, 'Annotation text survives');
  assert.equal(((result.resource.contained as Record<string, unknown>[])[0]?.name as { text: string }[])[0]?.text, 'Practitioner text survives');
  const bundle = privacy.sanitize({ resourceType: 'Bundle', type: 'searchset', entry: [{ resource: obs({ text: narrative }) }] });
  assert.ok(!json(bundle).includes('NARRATIVE_SENTINEL'));
  assert.ok(bundle.omitted.includes('/entry/0/resource/text'));
  const f = await source({}, { Observation: [obs({ id: 'o-n1', text: narrative }), obs({ id: 'o-n2', contained: [{ resourceType: 'Practitioner', id: 'pr1', text: narrative }] })] }); t.after(f.close);
  const search = await f.gateway().execute('fhir_search', { resource_type: 'Observation', output: { format: 'fhir' } });
  assert.equal(search.error, undefined);
  assert.equal(resources(search).length, 2);
  assert.ok(!json(search).includes('NARRATIVE_SENTINEL'));
  assert.equal((resources(search)[0]?.code as { text: string }).text, 'HbA1c');
});

// ------------------------------------------------- M3a repair B (V-ids) --

const narrativeFlag = (sanitized: unknown) => (sanitized as { narrativeOmitted?: boolean }).narrativeOmitted;

test('V-6 timing: link-span trailing-bracket stripping is linear at 200k brackets', () => {
  for (const bracket of [')', ']', '>']) {
    const tail = bracket.repeat(200_000);
    const result = privacy.redactTextLinks(`see http://x.invalid/${tail}`);
    const elapsed = cpuMs(() => { privacy.redactTextLinks(`see http://x.invalid/${tail}`); });
    assert.ok(elapsed < 500, `${bracket} took ${elapsed.toFixed(1)}ms of CPU`);
    assert.equal(result.text, `see ${privacy.TEXT_LINK_PLACEHOLDER}${tail}`);
    assert.equal(result.spans, 1);
  }
});

test('V-6: trailing-prose stripping matches the reference bracket-count semantics', () => {
  // Reference: the original recount-per-strip algorithm, kept here on short inputs only.
  const count = (text: string, char: string) => text.split(char).length - 1;
  const reference = (span: string) => {
    let end = span.length;
    while (end > 1) {
      const char = span[end - 1]!, body = span.slice(0, end);
      const open = ({ ')': '(', ']': '[', '>': '<' } as Record<string, string>)[char];
      if ('.,;:!?'.includes(char) || (open && count(body, char) > count(body, open))) end--; else break;
    }
    return span.slice(end);
  };
  let state = 0x2e8912c7;
  const next = () => { state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff; return state; };
  const alphabet = 'ab()[]<>.,;:!?-';
  for (let i = 0; i < 3000; i++) {
    const tail = Array.from({ length: next() % 15 }, () => alphabet[next() % alphabet.length]).join('');
    const span = `http://x.invalid/${tail}`;
    assert.equal(privacy.redactTextLinks(`see ${span}`).text, `see ${privacy.TEXT_LINK_PLACEHOLDER}${reference(span)}`, span);
  }
  assert.equal(privacy.redactTextLinks('See (https://x.invalid/a(b)) end').text, `See (${privacy.TEXT_LINK_PLACEHOLDER}) end`);
});

test('V-7: protocol-relative spans need a host-like signal, clinical // shorthand survives', () => {
  const kept = ['Hx: HTN, DM2 //no known allergies', 'Metoprolol 25 BID //HOLD if HR<55', 'Lasix 40mg PO daily //hold for SBP<90', 'Allergies: //none.'];
  const result = privacy.sanitize(obs({ note: kept.map(text => ({ text })) }));
  assert.deepEqual((result.resource.note as { text: string }[]).map(note => note.text), kept);
  assert.deepEqual(result.manifests, []);
  const secret = 'PROTOCOL_RELATIVE_SECRET';
  for (const text of [`//localhost/${secret}`, `Portal //fhir.example.org/x?token=${secret} now`, `Go //evil.com/${secret}`, `Intranet //intranet?k=${secret}`, `Auth //u:p@h/${secret}`, `V6 //[::1]/${secret}`, `Port //host:8080/${secret}`]) {
    const redacted = privacy.redactTextLinks(text);
    assert.ok(!redacted.text.includes(secret), text);
    assert.ok(redacted.spans >= 1, text);
  }
});

test('V-8: glued-scheme, WHATWG and autolink credential URLs in prose are redacted', () => {
  const secret = 'GLUED_SECRET';
  const prose = [
    `Sig #30https://files.invalid/a?token=${secret} daily`,
    `1.https://portal.invalid/r?token=${secret}`,
    `Take -https://files.invalid/a?token=${secret} now`,
    `Take +https://files.invalid/a?token=${secret} now`,
    `Odd https:/files.invalid/a?token=${secret} here`,
    `Odd https:files.invalid/a?token=${secret} here`,
    `Odd https:\\files.invalid\\a?token=${secret} here`,
    `Auto <https:files.invalid/a?token=${secret}> here`,
    `Ftp xftp is not a link but 9ftp://files.invalid/a?token=${secret} is`,
  ];
  const result = privacy.sanitize(obs({ note: prose.map(text => ({ text })), valueString: 'Note: http status 200, https ok' }));
  assert.ok(!json(result).includes(secret));
  assert.equal(result.resource.valueString, 'Note: http status 200, https ok', 'a bare scheme word without a colon target is prose');
  for (const note of result.resource.note as { text: string }[]) assert.ok(note.text.includes(privacy.TEXT_LINK_PLACEHOLDER), note.text);
});

test('V-8 timing: 100 KB of scheme-like filler stays linear', () => {
  const text = 'a1'.repeat(50_000);
  const result = privacy.redactTextLinks(text);
  assert.ok(cpuMs(() => { privacy.redactTextLinks(text); }) < 500);
  assert.equal(result.spans, 0);
  assert.equal(result.text, text);
});

test('V-8: link spans in non-prose, non-URI strings withhold the whole value in every format', async t => {
  const secret = 'OPAQUE_LINK_SECRET';
  const resource = obs({
    vendorNote: `see https://files.invalid/v?token=${secret}`,
    code: { coding: [{ system: 'http://loinc.org', code: `see https://files.invalid/c?token=${secret}` }], text: 'HbA1c' },
    component: [{ code: { text: 'panel' }, vendorBlob: { text: `nested https://files.invalid/n?token=${secret}` } }],
  });
  const sanitized = privacy.sanitize(resource);
  assert.ok(!json(sanitized).includes(secret));
  assert.equal(sanitized.resource.vendorNote, undefined, 'undeclared vendor text is withheld whole, never rewritten');
  assert.equal((sanitized.resource.code as { coding: Record<string, unknown>[] }).coding[0]?.code, undefined, 'a code carrying a link is withheld whole');
  assert.equal(((sanitized.resource.component as Record<string, unknown>[])[0]?.vendorBlob as Record<string, unknown>)?.text, undefined);
  assert.ok(sanitized.manifests.some(manifest => manifest.reason === 'PROTECTED_LINK' && manifest.path === '/vendorNote'));
  const f = await source({ 'Observation/o1': resource }); t.after(f.close);
  const gateway = f.gateway();
  for (const format of ['compact', 'fhir'] as const) {
    const read = await gateway.execute('fhir_read', { resource_type: 'Observation', id: 'o1', output: { format } });
    assert.equal(read.error, undefined, format);
    const retained = await gateway.execute('fhir_result', { handle: read.result!.handle, action: 'project', fields: ['code', 'component'], output: { format } });
    assert.equal(retained.error, undefined, format);
    assert.ok(!json([read, retained]).includes(secret), format);
  }
});

test('V-12: compact keeps contained resources referenced by kept elements', async t => {
  const medRequest = {
    resourceType: 'MedicationRequest', id: 'mr-contained', status: 'active', intent: 'order',
    contained: [{ resourceType: 'Medication', id: 'med1', status: 'inactive', code: { coding: [{ system: 'http://example.invalid/synthetic-rx', code: 'amlodipine-synthetic' }], text: 'Synthetic Amlodipine' } }],
    medicationReference: { reference: '#med1' }, subject: { reference: `Patient/${a}` }, authoredOn: '2026-01-01',
  };
  const view = privacy.projection(medRequest, 'compact');
  assert.equal((view.resource.contained as Record<string, unknown>[])[0]?.status, 'inactive', 'contained modifier status survives');
  assert.equal(((view.resource.contained as Record<string, unknown>[])[0]?.code as { text: string }).text, 'Synthetic Amlodipine');
  assert.ok(!view.omitted.includes('/contained'));
  assert.equal((view.resource.medicationReference as { reference: string }).reference, '#med1');
  const report = {
    resourceType: 'DiagnosticReport', id: 'dr-contained', status: 'final', code: { text: 'panel' }, subject: { reference: `Patient/${a}` },
    contained: [{ resourceType: 'Observation', id: 'obs-contained', status: 'preliminary', code: { text: 'Synthetic glucose' }, subject: { reference: `Patient/${a}` } }],
    result: [{ reference: '#obs-contained' }],
  };
  const reportView = privacy.projection(report, 'compact');
  assert.equal(((reportView.resource.contained as Record<string, unknown>[])[0]?.code as { text: string }).text, 'Synthetic glucose');
  assert.ok(!reportView.omitted.includes('/contained'));
  const unreferenced = privacy.projection({ ...medRequest, medicationReference: { reference: 'Medication/external' } }, 'compact');
  assert.equal(unreferenced.resource.contained, undefined, 'unreferenced contained resources stay out of compact');
  assert.ok(unreferenced.omitted.includes('/contained'));
  const f = await source({ 'MedicationRequest/mr-contained': medRequest }, { MedicationRequest: [medRequest] }); t.after(f.close);
  const gateway = f.gateway();
  for (const envelope of [await gateway.execute('fhir_read', { resource_type: 'MedicationRequest', id: 'mr-contained', output: { format: 'compact' } }), await gateway.execute('fhir_search', { resource_type: 'MedicationRequest', output: { format: 'compact' } })]) {
    assert.equal(envelope.error, undefined);
    assert.equal(((resources(envelope)[0]?.contained as Record<string, unknown>[])[0]?.code as { text: string }).text, 'Synthetic Amlodipine');
    assert.ok(!(envelope.transform.omitted_fields as string[]).includes('/contained'));
    assert.deepEqual(envelope.warnings.filter(warning => warning.code === 'DANGLING_CONTAINED_REFERENCE'), []);
  }
});

test('V-13: selected fields into contained resources keep resourceType, id and modifiers', async t => {
  const report = {
    resourceType: 'DiagnosticReport', id: 'dr1', status: 'final', code: { text: 'panel' }, subject: { reference: `Patient/${a}` },
    contained: [{ resourceType: 'Observation', id: 'obs-in', status: 'entered-in-error', code: { coding: [{ system: 'http://loinc.org', code: '2345-7' }] }, subject: { reference: `Patient/${a}` }, valueQuantity: { value: 250, unit: 'mg/dL' } }],
    result: [{ reference: '#obs-in' }],
  };
  const view = privacy.projection(report, 'fhir', ['contained.code', 'contained.valueQuantity']);
  assert.deepEqual((view.resource.contained as Record<string, unknown>[])[0], {
    resourceType: 'Observation', id: 'obs-in', status: 'entered-in-error',
    code: { coding: [{ system: 'http://loinc.org', code: '2345-7' }] }, valueQuantity: { value: 250, unit: 'mg/dL' },
  });
  assert.ok(view.warnings?.some(warning => warning.code === 'MODIFIER_FIELDS_ADDED'));
  const encounter = {
    resourceType: 'Encounter', id: 'e1', status: 'finished', class: { code: 'AMB' }, subject: { reference: `Patient/${a}` },
    contained: [{ resourceType: 'Condition', id: 'cond-in', clinicalStatus: { coding: [{ code: 'active' }] }, verificationStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status', code: 'refuted' }] }, code: { text: 'Synthetic refuted condition' }, subject: { reference: `Patient/${a}` } }],
  };
  const encounterView = privacy.projection(encounter, 'fhir', ['contained.code']);
  const containedCondition = (encounterView.resource.contained as Record<string, unknown>[])[0]!;
  assert.equal(containedCondition.resourceType, 'Condition');
  assert.equal(containedCondition.id, 'cond-in');
  assert.deepEqual(containedCondition.verificationStatus, encounter.contained[0]!.verificationStatus);
  const order = {
    resourceType: 'DiagnosticReport', id: 'dr2', status: 'final', code: { text: 'panel' }, subject: { reference: `Patient/${a}` },
    contained: [{ resourceType: 'MedicationRequest', id: 'mr-in', status: 'active', intent: 'order', doNotPerform: true, medicationCodeableConcept: { text: 'Synthetic drug' }, subject: { reference: `Patient/${a}` } }],
  };
  assert.equal((privacy.projection(order, 'fhir', ['contained.medicationCodeableConcept']).resource.contained as Record<string, unknown>[])[0]?.doNotPerform, true, 'a contained negated order is never returned as affirmative');
  const f = await source({ 'DiagnosticReport/dr1': report }); t.after(f.close);
  const gateway = f.gateway();
  const read = await gateway.execute('fhir_read', { resource_type: 'DiagnosticReport', id: 'dr1', output: { format: 'fhir', fields: ['contained.code', 'contained.valueQuantity'] } });
  assert.equal(read.error, undefined);
  assert.equal((resources(read)[0]?.contained as Record<string, unknown>[])[0]?.status, 'entered-in-error');
  const retained = await gateway.execute('fhir_result', { handle: read.result!.handle, action: 'project', fields: ['contained.valueQuantity'] });
  assert.equal(retained.error, undefined);
  const retainedContained = (resources(retained)[0]?.contained as Record<string, unknown>[])[0]!;
  assert.equal(retainedContained.resourceType, 'Observation');
  assert.equal(retainedContained.status, 'entered-in-error');
});

test('V-19: Location sharing is an affirmative facility allowlist; unclassified instances are denied', () => {
  const roleCode = 'http://terminology.hl7.org/CodeSystem/v3-RoleCode';
  const roleCodeOid = 'urn:oid:2.16.840.1.113883.5.111';
  const physical = 'http://terminology.hl7.org/CodeSystem/location-physical-type';
  const denied: Record<string, unknown>[] = [
    { resourceType: 'Location', id: 'oid-ptres', type: [{ coding: [{ system: roleCodeOid, code: 'PTRES' }] }] },
    { resourceType: 'Location', id: 'untyped', status: 'active', name: 'Somewhere', description: `Home of ${b}`, address: { line: ['1 Synthetic Street'] } },
    { resourceType: 'Location', id: 'text-only', type: [{ text: "Patient's residence" }] },
    { resourceType: 'Location', id: 'work', type: [{ coding: [{ system: roleCode, code: 'WORK' }] }] },
    { resourceType: 'Location', id: 'accident', type: [{ coding: [{ system: roleCode, code: 'ACC' }] }] },
    { resourceType: 'Location', id: 'school', type: [{ coding: [{ system: roleCodeOid, code: 'SCHOOL' }] }] },
    { resourceType: 'Location', id: 'unknown-code', type: [{ coding: [{ system: roleCode, code: 'SYNTHETIC-UNKNOWN' }] }] },
    { resourceType: 'Location', id: 'unknown-system', type: [{ coding: [{ system: 'http://example.invalid/loc', code: 'HOSP' }] }] },
    { resourceType: 'Location', id: 'vehicle', physicalType: { coding: [{ system: physical, code: 've' }] } },
    { resourceType: 'Location', id: 'mixed', type: [{ coding: [{ system: roleCode, code: 'HOSP' }, { system: roleCode, code: 'PTRES' }] }] },
  ];
  for (const resource of denied) { assert.equal(privacy.sharedInstanceAllowed(resource), false, json(resource)); assert.equal(ok(resource as FhirResource), false, json(resource)); }
  const allowed: Record<string, unknown>[] = [
    { resourceType: 'Location', id: 'ward', status: 'active', name: 'Synthetic Ward', physicalType: { coding: [{ system: physical, code: 'wa' }] } },
    { resourceType: 'Location', id: 'hospital', type: [{ coding: [{ system: roleCode, code: 'HOSP' }] }] },
    { resourceType: 'Location', id: 'er-oid', type: [{ coding: [{ system: roleCodeOid, code: 'ER' }] }], physicalType: { coding: [{ system: physical, code: 'si' }] } },
  ];
  for (const resource of allowed) { assert.equal(privacy.sharedInstanceAllowed(resource), true, json(resource)); assert.equal(ok(resource as FhirResource), true, json(resource)); }
});

test('V-20: logical foreign-Patient shapes on non-Reference contexts are denied', async t => {
  const foreign = { type: 'Patient', identifier: { system: 'urn:synthetic:mrn', value: 'SYNTHETIC_B_MRN' }, display: 'Synthetic Patient B' };
  assert.equal(ok(obs({ _status: foreign })), false, '_status companion');
  assert.equal(ok(obs({ valueString: 'x', _valueString: foreign })), false, '_valueString companion');
  assert.equal(ok(obs({ code: foreign })), false, 'CodeableConcept context');
  assert.equal(ok(obs({ code: { coding: [foreign] } })), false, 'Coding context');
  // Conformant shapes whose keys are declared on their own datatype stay allowed.
  const encounter = { resourceType: 'Encounter', id: 'e1', status: 'finished', class: { code: 'AMB' }, type: [{ coding: [{ system: 'http://example.invalid/enc', code: 'visit' }] }], identifier: [{ system: 'urn:synthetic:visit', value: 'v1' }], subject: { reference: `Patient/${a}` } };
  assert.equal(ok(encounter), true, 'Encounter type+identifier are declared elements');
  assert.equal(ok(obs({ extension: [{ url: 'http://example.org/artifact', valueRelatedArtifact: { type: 'documentation', display: 'Synthetic guidance' } }] })), true, 'RelatedArtifact type+display are declared elements');
  assert.equal(ok(obs({ identifier: [{ type: { coding: [{ system: 'http://example.invalid/id', code: 'lab' }] }, value: 'x1' }] })), true, 'Identifier.type is a declared element');
  const f = await source({ 'Observation/o1': obs({ _status: foreign }) }); t.after(f.close);
  const denied = await f.gateway().execute('fhir_read', { resource_type: 'Observation', id: 'o1', output: { format: 'fhir' } });
  assert.equal(denied.error?.code, 'NOT_FOUND');
  assert.ok(!json(denied).includes('SYNTHETIC_B_MRN'));
});

test('V-22: unknown JSON property names never reach resources, manifests or omitted fields', async t => {
  const secret = 'KEY_SECRET';
  const hostileKey = `https://files.invalid/k?token=${secret}`;
  for (const resource of [obs({ [hostileKey]: 'data:,x' }), obs({ [hostileKey]: 'harmless' }), obs({ code: { text: 'HbA1c', [hostileKey]: 'harmless' } })]) {
    const result = privacy.sanitize(resource);
    assert.ok(!json(result).includes(secret));
    assert.ok(result.manifests.some(manifest => manifest.reason === 'UNDECLARED_PROPERTY_WITHHELD'));
    assert.ok(result.manifests.every(manifest => !String(manifest.path).includes('files.invalid')));
    assert.ok(result.omitted.every(path => !path.includes('files.invalid')));
  }
  const f = await source({ 'Observation/o1': obs({ [hostileKey]: 'data:,x' }) }); t.after(f.close);
  const gateway = f.gateway();
  for (const format of ['compact', 'fhir'] as const) {
    const read = await gateway.execute('fhir_read', { resource_type: 'Observation', id: 'o1', output: { format } });
    assert.equal(read.error, undefined, format);
    const retained = await gateway.execute('fhir_result', { handle: read.result!.handle, action: 'project', fields: ['code'], output: { format } });
    assert.equal(retained.error, undefined, format);
    assert.ok(!json([read, retained]).includes(secret), format);
  }
});

test('V-23: sanitize reports narrative omission only for resource narrative, never for redacted prose', () => {
  const narrative = { status: 'generated', div: '<div xmlns="http://www.w3.org/1999/xhtml">x</div>' };
  assert.equal(narrativeFlag(privacy.sanitize(obs({ text: narrative }))), true, 'root narrative');
  assert.equal(narrativeFlag(privacy.sanitize(obs({ contained: [{ resourceType: 'Practitioner', id: 'pr1', text: narrative }] }))), true, 'contained narrative');
  assert.equal(narrativeFlag(privacy.sanitize(obs())), false, 'no narrative');
  const codeText = privacy.sanitize(obs({ code: { coding: [{ system: 'http://loinc.org', code: '4548-4' }], text: 'See https://x.invalid/a?token=NARRATIVE_FP_SECRET' } }));
  assert.equal(narrativeFlag(codeText), false, 'redacted code.text is not narrative');
  assert.ok(codeText.manifests.some(manifest => manifest.reason === 'PROTECTED_LINK_IN_TEXT' && manifest.path === '/code/text'));
  const noteText = privacy.sanitize(obs({ note: [{ text: 'See https://x.invalid/a?token=NARRATIVE_FP_SECRET' }] }));
  assert.equal(narrativeFlag(noteText), false, 'redacted note.text is not narrative');
  const containedName = privacy.sanitize(obs({ contained: [{ resourceType: 'Practitioner', id: 'pr1', name: [{ text: 'See https://x.invalid/a?token=NARRATIVE_FP_SECRET' }] }] }));
  assert.equal(narrativeFlag(containedName), false, 'redacted contained name text is not narrative');
  assert.ok(!json([codeText, noteText, containedName]).includes('NARRATIVE_FP_SECRET'));
  // J-4 view warnings at privacy level (m4c/m4e mutants).
  const service = { resourceType: 'ServiceRequest', id: 's1', status: 'active', intent: 'order', code: { text: 'Synthetic procedure' }, subject: { reference: `Patient/${a}` } };
  assert.ok(privacy.projection(service, 'compact').warnings?.some(warning => warning.code === 'COMPACT_RECIPE_UNAVAILABLE'));
  assert.ok(privacy.projection(negated, 'compact', ['medicationCodeableConcept']).warnings?.some(warning => warning.code === 'MODIFIER_FIELDS_ADDED'));
  assert.match(String(privacy.projection(negated, 'compact').recipe), /MedicationRequest\.compact/);
});

test('V-33: field selection treats FhirDecimal as an opaque leaf', () => {
  const resource = obs({ valueQuantity: { value: new decimal.FhirDecimal('7.0'), unit: '%' } });
  const into = privacy.projection(resource, 'fhir', ['valueQuantity.value.lexeme']);
  assert.deepEqual(into.unresolved, ['valueQuantity.value.lexeme']);
  assert.ok(!json(into.resource).includes('lexeme'), json(into.resource));
  const at = privacy.projection(resource, 'fhir', ['valueQuantity.value']);
  assert.deepEqual(at.unresolved, []);
  assert.ok(decimal.isFhirDecimal((at.resource.valueQuantity as { value: unknown }).value), 'the exact lexeme scalar is kept whole');
  assert.equal(((at.resource.valueQuantity as { value: decimal.FhirDecimal }).value).lexeme, '7.0');
  assert.deepEqual(privacy.projection(obs({ valueQuantity: { value: 7.1 } }), 'fhir', ['valueQuantity.value.lexeme']).unresolved, ['valueQuantity.value.lexeme']);
  const fault = obs({ valueQuantity: { value: new decimal.FhirPrecisionFault() } });
  assert.deepEqual(privacy.projection(fault, 'fhir', ['valueQuantity.value.precisionFault']).unresolved, ['valueQuantity.value.precisionFault']);
});
