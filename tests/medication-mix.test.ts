/**
 * Reference-only medication mixes. A shared Medication with no `code` may carry
 * `ingredient` only when every identifier is in an operator-listed system (privacy.sharedIdentifierSystems, empty by default)
 * and each of 1 to 32 ingredients is only `itemReference: { reference: 'Medication/<id>' }`, an optional boolean `isActive` and
 * an optional `strength` Ratio of two simple Quantities. With the default empty list no mix is classified.
 * All fixtures are hand-written synthetic shapes; the identifier systems are invented example.org URIs.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { FhirGateway, WARNING_MESSAGES, type GatewayConfig, type GatewayEnvelope } from '../packages/core/src/index.js';
import { FhirDecimal } from '../packages/core/src/decimal.js';
import { authorizeRecord, MAX_MIX_INGREDIENTS, sharedInstanceAllowed, sharedPolicyFrom, SHARED_INSTANCE_POLICY } from '../packages/core/src/privacy.js';
import { MEDICATION_LISTED_IDENTIFIERS_SUMMARY, supportForType } from '../packages/core/src/support.js';
import catalog from '../packages/core/src/generated/r4-search-parameters.json' with { type: 'json' };

type R = Record<string, any>;
const A = 'syn-patient-a';
const REASON = 'SHARED_RECORDS_WITHHELD_BY_POLICY';
const MIX = 'http://example.org/fhir/medication-mix';
const OTHER = 'http://example.org/fhir/other-product';
const base = new URL('http://127.0.0.1:4321/fhir/');
const UCUM = 'http://unitsofmeasure.org';
const quantity = (value: unknown, unit = 'mg'): R => ({ value, unit, system: UCUM, code: unit });
const strength = (): R => ({ numerator: quantity(10), denominator: quantity(100, 'mL') });
const ingredient = (id = 'syn-drug-a', extra: R = {}): R => ({ itemReference: { reference: `Medication/${id}` }, isActive: true, strength: strength(), ...extra });
const mix = (id = 'mix-1', extra: R = {}): R => ({ resourceType: 'Medication', id, status: 'active',
  identifier: [{ system: MIX, value: 'Synthetic Drug A 10 mg / Synthetic Diluent 100 mL' }],
  ingredient: [ingredient('syn-drug-a'), { itemReference: { reference: 'Medication/syn-diluent' }, isActive: false }], ...extra });
const withIngredient = (item: unknown, id = 'mix-t'): R => mix(id, { ingredient: [item] });
const component = (id: string): R => ({ resourceType: 'Medication', id, status: 'active', code: { coding: [{ system: 'urn:synthetic:drug', code: id }] } });
const listedPrivacy = { sharedIdentifierSystems: [MIX] };
const listed = sharedPolicyFrom(listedPrivacy);
const ids = (envelope: GatewayEnvelope) => ((envelope.data as { resources?: R[] }).resources ?? []).map(r => r.id);
const assertSharedSignal = (envelope: GatewayEnvelope, label: string) => {
  assert.equal(envelope.error, undefined, label);
  assert.equal(envelope.coverage.state, 'partial', label);
  assert.ok(envelope.coverage.reasons.includes(REASON), `${label}: reason`);
  assert.deepEqual(envelope.warnings.find(warning => warning.code === REASON), { code: REASON, message: WARNING_MESSAGES[REASON] }, `${label}: warning`);
};
const assertNotPartialForMix = (envelope: GatewayEnvelope, label: string) => {
  assert.equal(envelope.error, undefined, `${label}: ${JSON.stringify(envelope.error)}`);
  assert.notEqual(envelope.coverage.state, 'partial', `${label}: ${JSON.stringify(envelope.coverage.reasons)}`);
  assert.equal(envelope.coverage.reasons.includes(REASON), false, label);
  assert.equal(envelope.warnings.some(warning => warning.code === REASON), false, label);
};

// ---------------------------------------------------------------------------------------------------------------
// Unit verdicts.
// ---------------------------------------------------------------------------------------------------------------

test('1c mix rule: a listed mix is classified; the default empty list withholds it with the shared signal', () => {
  assert.equal(SHARED_INSTANCE_POLICY.version, '2026-11-14.3');
  assert.equal(MAX_MIX_INGREDIENTS, 32);
  assert.equal(sharedInstanceAllowed(mix(), listed), true);
  assert.equal(authorizeRecord(mix() as never, A, base, listedPrivacy).kind, 'deliver');
  assert.equal(sharedInstanceAllowed(mix()), false, 'no policy');
  assert.equal(sharedInstanceAllowed(mix(), sharedPolicyFrom({})), false, 'empty list');
  assert.equal(sharedInstanceAllowed(mix(), sharedPolicyFrom({ sharedIdentifierSystems: [] })), false, 'explicit empty list');
  assert.equal(authorizeRecord(mix() as never, A, base, {}).kind, 'shared_withheld');
  // The narrow shapes that still pass.
  for (const [label, record] of [
    ['one ingredient, reference only', withIngredient({ itemReference: { reference: 'Medication/syn-drug-a' } })],
    ['isActive false', withIngredient(ingredient('syn-drug-a', { isActive: false }))],
    ['exact decimal strength values', withIngredient(ingredient('syn-drug-a', { strength: { numerator: { value: new FhirDecimal('10.0') }, denominator: { value: new FhirDecimal('1e2') } } }))],
    ['quantities with a value only', withIngredient(ingredient('syn-drug-a', { strength: { numerator: { value: 1 }, denominator: { value: 2 } } }))],
    ['32 ingredients', mix('mix-32', { ingredient: Array.from({ length: MAX_MIX_INGREDIENTS }, (_, i) => ingredient(`syn-drug-${i}`)) })],
    ['an id with dots and dashes', withIngredient({ itemReference: { reference: 'Medication/syn.drug-a.1' } })],
    ['two listed identifiers', mix('mix-2', { identifier: [{ system: MIX, value: 'a' }, { system: MIX, value: 'b', use: 'official' }] })],
  ] as const) assert.equal(sharedInstanceAllowed(record, listed), true, label);
  // A coded Medication keeps the existing rule: its ingredients need no mix shape.
  assert.equal(sharedInstanceAllowed(component('syn-drug-a')), true);
  assert.equal(sharedInstanceAllowed({ ...component('syn-coded'), ingredient: [{ itemCodeableConcept: { coding: [{ system: 'urn:synthetic:drug', code: 'part' }] } }] }), true);
});

test('1c mix rule: one failing twin for each rule term', () => {
  const twins: [string, R][] = [
    // Item: a reference only, never a concept.
    ['itemCodeableConcept beside itemReference', withIngredient(ingredient('syn-drug-a', { itemCodeableConcept: { text: 'Synthetic' } }))],
    ['itemCodeableConcept instead of itemReference', withIngredient({ itemCodeableConcept: { coding: [{ system: 'urn:synthetic:drug', code: 'x' }] }, isActive: true })],
    ['no item at all', withIngredient({ isActive: true })],
    // Reference form: exactly Medication/<id>.
    ['absolute same-source reference', withIngredient({ itemReference: { reference: `${base.href}Medication/syn-drug-a` } })],
    ['absolute URL on another host', withIngredient({ itemReference: { reference: 'https://example.org/fhir/Medication/syn-drug-a' } })],
    ['versioned reference', withIngredient({ itemReference: { reference: 'Medication/syn-drug-a/_history/2' } })],
    ['urn reference', withIngredient({ itemReference: { reference: 'urn:uuid:5b1f2c3d-0000-4000-8000-000000000001' } })],
    ['contained reference', withIngredient({ itemReference: { reference: '#syn-drug-a' } })],
    ['conditional reference', withIngredient({ itemReference: { reference: 'Medication?code=x' } })],
    ['trailing space', withIngredient({ itemReference: { reference: 'Medication/syn-drug-a ' } })],
    ['id over 64 characters', withIngredient({ itemReference: { reference: `Medication/${'a'.repeat(65)}` } })],
    ['empty id', withIngredient({ itemReference: { reference: 'Medication/' } })],
    ['lower-case type', withIngredient({ itemReference: { reference: 'medication/syn-drug-a' } })],
    ['reference not a string', withIngredient({ itemReference: { reference: 42 } })],
    ['itemReference with no reference', withIngredient({ itemReference: {} })],
    ['itemReference not an object', withIngredient({ itemReference: 'Medication/syn-drug-a' })],
    // Target type: only Medication.
    ['Patient target', withIngredient({ itemReference: { reference: 'Patient/x' } })],
    ['Substance target', withIngredient({ itemReference: { reference: 'Substance/syn-substance' } })],
    ['Organization target', withIngredient({ itemReference: { reference: 'Organization/syn-org' } })],
    // itemReference carries only `reference`.
    ['display on itemReference', withIngredient({ itemReference: { reference: 'Medication/syn-drug-a', display: 'Synthetic Drug A' } })],
    ['identifier on itemReference', withIngredient({ itemReference: { reference: 'Medication/syn-drug-a', identifier: { system: MIX, value: 'x' } } })],
    ['type on itemReference', withIngredient({ itemReference: { reference: 'Medication/syn-drug-a', type: 'Medication' } })],
    ['_reference companion', withIngredient({ itemReference: { reference: 'Medication/syn-drug-a', _reference: { id: 'r1' } } })],
    // Ingredient keys: no extension, modifierExtension or other element.
    ['empty extension on an ingredient', withIngredient(ingredient('syn-drug-a', { extension: [] }))],
    ['extension on an ingredient', withIngredient(ingredient('syn-drug-a', { extension: [{ url: 'http://example.org/fhir/ext', valueString: 'x' }] }))],
    ['modifierExtension on an ingredient', withIngredient(ingredient('syn-drug-a', { modifierExtension: [{ url: 'http://example.org/fhir/ext', valueBoolean: true }] }))],
    ['id on an ingredient', withIngredient(ingredient('syn-drug-a', { id: 'free text' }))],
    ['_isActive companion', withIngredient(ingredient('syn-drug-a', { _isActive: { id: 'x' } }))],
    // Ingredient count: 1 to 32, as an array of objects.
    ['33 ingredients', mix('mix-33', { ingredient: Array.from({ length: MAX_MIX_INGREDIENTS + 1 }, (_, i) => ingredient(`syn-drug-${i}`)) })],
    ['no ingredients', mix('mix-0', { ingredient: [] })],
    ['ingredient not an array', mix('mix-o', { ingredient: ingredient() })],
    ['ingredient a string', mix('mix-s', { ingredient: 'Medication/syn-drug-a' })],
    ['a null ingredient', withIngredient(null)],
    ['an array ingredient', withIngredient([ingredient()])],
    ['_ingredient companion', mix('mix-u', { _ingredient: [{ id: 'free text' }] })],
    // Identifiers: at least one, every one listed.
    ['no identifier', mix('mix-n', { identifier: undefined })],
    ['unlisted system', mix('mix-x', { identifier: [{ system: OTHER, value: 'Synthetic' }] })],
    ['listed and unlisted systems', mix('mix-y', { identifier: [{ system: MIX, value: 'a' }, { system: OTHER, value: 'b' }] })],
    ['identifier with a type', mix('mix-z', { identifier: [{ system: MIX, value: 'a', type: { text: 'Synthetic' } }] })],
    // No code: an uncoded concept or a code companion is not a mix.
    ['text-only code', mix('mix-c', { code: { text: 'Synthetic mix' } })],
    ['_code companion', mix('mix-k', { _code: { id: 'c1' } })],
    // isActive: a boolean.
    ['isActive string', withIngredient(ingredient('syn-drug-a', { isActive: 'true' }))],
    ['isActive null', withIngredient(ingredient('syn-drug-a', { isActive: null }))],
    // strength: a Ratio of two simple Quantities.
    ['strength comparator', withIngredient(ingredient('syn-drug-a', { strength: { numerator: { ...quantity(10), comparator: '<' }, denominator: quantity(100, 'mL') } }))],
    ['strength string value', withIngredient(ingredient('syn-drug-a', { strength: { numerator: quantity('10'), denominator: quantity(100, 'mL') } }))],
    ['strength missing value', withIngredient(ingredient('syn-drug-a', { strength: { numerator: { unit: 'mg' }, denominator: quantity(100, 'mL') } }))],
    ['strength missing denominator', withIngredient(ingredient('syn-drug-a', { strength: { numerator: quantity(10) } }))],
    ['strength missing numerator', withIngredient(ingredient('syn-drug-a', { strength: { denominator: quantity(100, 'mL') } }))],
    ['strength numeric unit', withIngredient(ingredient('syn-drug-a', { strength: { numerator: { value: 10, unit: 10 }, denominator: quantity(100, 'mL') } }))],
    ['strength numeric system', withIngredient(ingredient('syn-drug-a', { strength: { numerator: { value: 10, system: 1 }, denominator: quantity(100, 'mL') } }))],
    ['strength numeric code', withIngredient(ingredient('syn-drug-a', { strength: { numerator: { value: 10, code: 1 }, denominator: quantity(100, 'mL') } }))],
    ['strength extension on a Quantity', withIngredient(ingredient('syn-drug-a', { strength: { numerator: { ...quantity(10), extension: [] }, denominator: quantity(100, 'mL') } }))],
    ['strength extension on the Ratio', withIngredient(ingredient('syn-drug-a', { strength: { ...strength(), extension: [] } }))],
    ['strength _value companion', withIngredient(ingredient('syn-drug-a', { strength: { numerator: { ...quantity(10), _value: { id: 'v' } }, denominator: quantity(100, 'mL') } }))],
    ['strength not a Ratio', withIngredient(ingredient('syn-drug-a', { strength: quantity(10) }))],
    ['strength array', withIngredient(ingredient('syn-drug-a', { strength: [strength()] }))],
    ['strength a decimal scalar', withIngredient(ingredient('syn-drug-a', { strength: new FhirDecimal('1.0') }))],
    ['strength infinite value', withIngredient(ingredient('syn-drug-a', { strength: { numerator: quantity(Number.POSITIVE_INFINITY), denominator: quantity(100, 'mL') } }))],
  ];
  for (const [label, record] of twins) {
    assert.equal(sharedInstanceAllowed(record, listed), false, label);
    assert.notEqual(authorizeRecord(record as never, A, base, listedPrivacy).kind, 'deliver', `${label}: authorizeRecord`);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// A loopback source with `_id` search and read.
// ---------------------------------------------------------------------------------------------------------------

const declarations = (type: string) => [
  { name: '_id', type: 'token', source_description_present: false },
  ...catalog.definitions.filter(d => d.base.includes(type)).map(d => ({ name: d.code, type: d.type, source_description_present: false })),
];
const records = (): R[] => [
  { resourceType: 'Patient', id: A, active: true },
  mix('mix-1'), component('syn-drug-a'), component('syn-diluent'),
  withIngredient({ itemReference: { reference: 'Medication/syn-drug-a', display: 'Synthetic Drug A' } }, 'mix-display'),
];
async function startSource(t: TestContext) {
  const db = records();
  const requests: URL[] = [];
  let baseUrl = '';
  const server = createServer((req, res) => {
    const url = new URL(req.url!, baseUrl);
    requests.push(url);
    res.setHeader('content-type', 'application/fhir+json');
    if (url.pathname === '/fhir/metadata') {
      res.end(JSON.stringify({ resourceType: 'CapabilityStatement', status: 'active', kind: 'instance', fhirVersion: '4.0.1', format: ['json'], software: { name: 'medication mix source' },
        rest: [{ mode: 'server', resource: ['Patient', 'Medication'].map(type => ({ type, interaction: [{ code: 'read' }, { code: 'search-type' }], searchParam: declarations(type) })) }] }));
      return;
    }
    const parts = url.pathname.replace(/^\/fhir\//, '').split('/');
    if (parts.length === 2) {
      const found = db.find(r => r.resourceType === parts[0] && r.id === parts[1]);
      if (!found) { res.statusCode = 404; res.end(JSON.stringify({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'not-found' }] })); return; }
      res.end(JSON.stringify(found)); return;
    }
    let selected = db.filter(r => r.resourceType === parts[0]);
    const idList = url.searchParams.get('_id');
    if (idList !== null) selected = selected.filter(r => idList.split(',').includes(r.id));
    res.end(JSON.stringify({ resourceType: 'Bundle', type: 'searchset', link: [{ relation: 'self', url: url.href }], entry: selected.map(resource => ({ resource, search: { mode: 'match' } })) }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/fhir/`;
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return { base: baseUrl, requests };
}
const output = { format: 'fhir', max_bytes: 24576 } as const;
async function gatewayFor(t: TestContext, privacy?: GatewayConfig['privacy']) {
  const source = await startSource(t);
  const gateway = new FhirGateway({ mode: 'synthetic', source: { alias: 'mix', baseUrl: source.base }, patientId: A, contextId: 'mix-context', ...(privacy ? { privacy } : {}) });
  t.after(() => gateway.close());
  const byId = (id: string) => gateway.execute('fhir_search', { resource_type: 'Medication', params: [{ name: '_id', value: id }], output });
  const read = (id: string) => gateway.execute('fhir_read', { resource_type: 'Medication', id, output });
  return { gateway, byId, read };
}

test('1c gateway: a listed mix is found by _id and read with its references; the default withholds it with the shared signal', async t => {
  const listedGateway = await gatewayFor(t, listedPrivacy);
  const found = await listedGateway.byId('mix-1');
  assert.deepEqual(ids(found), ['mix-1']);
  assertNotPartialForMix(found, 'listed _id search');
  const delivered = (found.data.resources as R[])[0]!;
  assert.deepEqual(delivered.ingredient.map((item: R) => item.itemReference), [{ reference: 'Medication/syn-drug-a' }, { reference: 'Medication/syn-diluent' }]);
  assert.deepEqual(delivered.identifier, mix().identifier);
  assert.equal(delivered.code, undefined);
  const read = await listedGateway.read('mix-1');
  assert.equal(read.error, undefined, JSON.stringify(read.error));
  assert.deepEqual(ids(read), ['mix-1']);
  // A twin that fails one term is still withheld and signalled, and its display never leaves the gateway.
  const twin = await listedGateway.byId('mix-display');
  assert.deepEqual(ids(twin), []);
  assertSharedSignal(twin, 'listed list, display twin');
  assert.equal(JSON.stringify(twin).includes('Synthetic Drug A'), false);
  assert.equal((await listedGateway.read('mix-display')).error?.code, 'NOT_FOUND');
  const support = await listedGateway.gateway.execute('fhir_capabilities', { topic: 'resource', resource_type: 'Medication' });
  assert.equal((support.data as R).instance_policy, MEDICATION_LISTED_IDENTIFIERS_SUMMARY);

  const defaults = await gatewayFor(t);
  const withheld = await defaults.byId('mix-1');
  assert.deepEqual(ids(withheld), []);
  assertSharedSignal(withheld, 'default empty list');
  assert.equal((await defaults.read('mix-1')).error?.code, 'NOT_FOUND');
  const defaultSupport = await defaults.gateway.execute('fhir_capabilities', { topic: 'resource', resource_type: 'Medication' });
  assert.equal((defaultSupport.data as R).instance_policy, supportForType('Medication').instance_policy);
  assert.ok(MEDICATION_LISTED_IDENTIFIERS_SUMMARY.length <= 120);
});

// ---------------------------------------------------------------------------------------------------------------
// Real MCP SDK stdio, both protocol eras.
// ---------------------------------------------------------------------------------------------------------------

for (const era of ['modern', 'legacy'] as const) test(`1c stdio ${era}: a listed mix is searched and read; a failing twin is withheld with the shared signal`, async t => {
  const source = await startSource(t);
  const dir = await mkdtemp(join(tmpdir(), 'w1c-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({ mode: 'synthetic', source: { alias: 'mix', baseUrl: source.base }, patientId: A, privacy: listedPrivacy }));
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'packages/server/src/cli.ts', '--config', configPath],
    env: { ...getDefaultEnvironment(), TMPDIR: tmpdir() }, stderr: 'pipe' });
  const client = new Client({ name: 'medication-mix', version: '1' }, era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : undefined);
  await client.connect(transport);
  t.after(() => client.close());
  const call = async (name: string, args: R) => ((await client.callTool({ name, arguments: { ...args, output } })) as { structuredContent?: GatewayEnvelope }).structuredContent!;
  const found = await call('fhir_search', { resource_type: 'Medication', params: [{ name: '_id', value: 'mix-1' }] });
  assert.deepEqual(ids(found), ['mix-1']);
  assertNotPartialForMix(found, `${era} search`);
  assert.deepEqual((found.data.resources as R[])[0]!.ingredient[0].itemReference, { reference: 'Medication/syn-drug-a' });
  const read = await call('fhir_read', { resource_type: 'Medication', id: 'mix-1' });
  assert.equal(read.error, undefined, JSON.stringify(read.error));
  assert.deepEqual(ids(read), ['mix-1']);
  const twin = await call('fhir_search', { resource_type: 'Medication', params: [{ name: '_id', value: 'mix-display' }] });
  assert.deepEqual(ids(twin), []);
  assertSharedSignal(twin, `${era} display twin`);
  assert.equal((await call('fhir_read', { resource_type: 'Medication', id: 'mix-display' })).error?.code, 'NOT_FOUND');
});
