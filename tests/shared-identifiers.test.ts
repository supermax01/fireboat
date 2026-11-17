/**
 * The shared identifier rule. A shared Medication may carry identifiers only in operator-listed
 * product identifier systems (privacy.sharedIdentifierSystems, empty by default). Configuration refuses patient and well-known
 * person identifier systems. All fixtures are hand-written synthetic shapes.
 */
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { test } from 'node:test';
import { FhirGateway, type GatewayConfig, type GatewayEnvelope } from '../packages/core/src/index.js';
import { authorizeRecord, sharedInstanceAllowed, sharedPolicyFrom } from '../packages/core/src/privacy.js';
import { MEDICATION_LISTED_IDENTIFIERS_SUMMARY, supportForType } from '../packages/core/src/support.js';

type Rec = Record<string, unknown>;
const A = 'synthetic-patient-a';
const PRODUCT = 'urn:synthetic:w1:product', OTHER = 'urn:synthetic:w1:other-product', MRN = 'urn:synthetic:w1:mrn';
const base = new URL('http://127.0.0.1:4321/fhir/');
const coded = { coding: [{ system: 'urn:synthetic:drug', code: 'synthetic-drug-1' }] };
const medication = (extra: Rec = {}): Rec => ({ resourceType: 'Medication', id: 'med1', status: 'active', code: coded, ...extra });
const listed = (value = 'SYNTHETIC-PRODUCT-1') => ({ system: PRODUCT, value });
const resources = (envelope: GatewayEnvelope) => envelope.data.resources as Rec[];

const config = (privacy?: GatewayConfig['privacy']): GatewayConfig => ({ mode: 'synthetic', source: { alias: 'w1', baseUrl: 'http://127.0.0.1:9/fhir/' }, patientId: A, ...(privacy ? { privacy } : {}) });
const refusesConfig = (privacy: Rec, label: string) => assert.throws(() => new FhirGateway(config(privacy as GatewayConfig['privacy'])), { code: 'INVALID_CONFIG' }, label);

test('A3 config: shared identifier systems are validated and never patient or person identifier systems', () => {
  const accepted = new FhirGateway(config({ patientIdentifierSystems: [MRN], sharedIdentifierSystems: [PRODUCT, 'http://example.invalid/product-codes'] }));
  accepted.close();
  for (const [label, privacy] of [
    ['exact overlap with a patient system', { patientIdentifierSystems: [MRN], sharedIdentifierSystems: [MRN] }],
    ['case-insensitive overlap', { patientIdentifierSystems: ['http://example.invalid/mrn'], sharedIdentifierSystems: ['HTTP://EXAMPLE.INVALID/MRN'] }],
    ['overlap after URL serialisation', { patientIdentifierSystems: ['http://example.invalid/mrn'], sharedIdentifierSystems: ['http://example.invalid:80/mrn'] }],
    ['duplicate', { sharedIdentifierSystems: [PRODUCT, PRODUCT] }],
    ['33 entries', { sharedIdentifierSystems: Array.from({ length: 33 }, (_, i) => `urn:synthetic:w1:p${i}`) }],
    ['empty string', { sharedIdentifierSystems: [''] }],
    ['leading whitespace', { sharedIdentifierSystems: [` ${PRODUCT}`] }],
    ['inner whitespace', { sharedIdentifierSystems: ['urn:synthetic:w1 product'] }],
    ['not a URI', { sharedIdentifierSystems: ['synthetic-product'] }],
    ['data: scheme', { sharedIdentifierSystems: ['data:x'] }],
    ['query', { sharedIdentifierSystems: ['https://x.invalid/s?q'] }],
    ['fragment', { sharedIdentifierSystems: ['https://x.invalid/s#f'] }],
    ['userinfo', { sharedIdentifierSystems: ['https://u:p@x.invalid/s'] }],
    ['urn with nothing after the colon', { sharedIdentifierSystems: ['urn:'] }],
    ['US SSN URI', { sharedIdentifierSystems: ['http://hl7.org/fhir/sid/us-ssn'] }],
    ['US SSN OID', { sharedIdentifierSystems: ['urn:oid:2.16.840.1.113883.4.1'] }],
    ['US MBI', { sharedIdentifierSystems: ['http://hl7.org/fhir/sid/us-mbi'] }],
    ['passport family', { sharedIdentifierSystems: ['http://hl7.org/fhir/sid/passport-USA'] }],
    ['driver licence OID family', { sharedIdentifierSystems: ['urn:oid:2.16.840.1.113883.4.3.25'] }],
    ['person system in another case', { sharedIdentifierSystems: ['HTTP://HL7.ORG/FHIR/SID/US-SSN'] }],
    ['unknown privacy key', { sharedIdentifierSystem: [PRODUCT] }],
  ] as const) refusesConfig(privacy, label);
});

test('A3 instance rule: only listed systems, only system/value/use, at most eight, never batch', () => {
  const shared = sharedPolicyFrom({ sharedIdentifierSystems: [PRODUCT] });
  assert.equal(sharedInstanceAllowed(medication({ identifier: [listed()] })), false, 'the default empty list keeps identifiers unclassified');
  assert.equal(sharedInstanceAllowed(medication({ identifier: [listed()] }), shared), true);
  assert.equal(sharedInstanceAllowed(medication({ identifier: [{ ...listed(), use: 'official' }] }), shared), true);
  assert.equal(sharedInstanceAllowed(medication(), shared), true, 'no identifier stays allowed');
  for (const [label, identifier] of [
    ['mixed listed and unlisted', [listed(), { system: OTHER, value: 'x' }]],
    ['unlisted only', [{ system: OTHER, value: 'x' }]],
    ['missing system', [{ value: 'x' }]],
    ['assigner', [{ ...listed(), assigner: { reference: 'Organization/o1' } }]],
    ['type', [{ ...listed(), type: { text: 'Synthetic' } }]],
    ['period', [{ ...listed(), period: { start: '2020-01-01' } }]],
    ['_value companion', [{ ...listed(), _value: { extension: [] } }]],
    ['bad use', [{ ...listed(), use: 'temp' }]],
    ['empty value', [listed('')]],
    ['value over 256 characters', [listed('x'.repeat(257))]],
    ['nine identifiers', Array.from({ length: 9 }, (_, i) => listed(`p${i}`))],
    ['empty array', []],
    ['not an array', listed()],
  ] as const) assert.equal(sharedInstanceAllowed(medication({ identifier }), shared), false, label);
  assert.equal(sharedInstanceAllowed(medication({ identifier: [listed()], _identifier: [{ extension: [] }] }), shared), false, '_identifier');
  assert.equal(sharedInstanceAllowed(medication({ identifier: [listed()], batch: { lotNumber: 'L1' } }), shared), false, 'batch stays forbidden');
  // A contained listed Medication inside the bound patient's order follows the same configured rule.
  const order = { resourceType: 'MedicationRequest', id: 'm1', status: 'active', intent: 'order', subject: { reference: `Patient/${A}` },
    medicationReference: { reference: '#med1' }, contained: [medication({ identifier: [listed()] })] };
  assert.equal(authorizeRecord(order, A, base, { sharedIdentifierSystems: [PRODUCT] }).kind, 'deliver');
  assert.equal(authorizeRecord(order, A, base, {}).kind, 'own_withheld', 'without the list the contained identifier withholds the patient\'s own order');
});

async function fixture() {
  let baseUrl = '';
  const requests: URL[] = [];
  const records: Record<string, Rec> = {
    'Medication/med1': medication({ identifier: [listed()] }),
    'MedicationRequest/m1': { resourceType: 'MedicationRequest', id: 'm1', status: 'active', intent: 'order', subject: { reference: `Patient/${A}` },
      medicationReference: { reference: '#med1' }, contained: [medication({ identifier: [listed()] })] },
  };
  const metadata = { resourceType: 'CapabilityStatement', fhirVersion: '4.0.1', rest: [{ mode: 'server', resource: [
    { type: 'Patient', interaction: [{ code: 'read' }, { code: 'search-type' }], searchParam: [] },
    { type: 'MedicationRequest', interaction: [{ code: 'read' }, { code: 'search-type' }], searchParam: [{ name: 'patient', type: 'reference' }, { name: 'subject', type: 'reference' }] },
    { type: 'Medication', interaction: [{ code: 'read' }, { code: 'search-type' }], searchParam: [{ name: 'identifier', type: 'token' }, { name: 'code', type: 'token' }] },
  ] }] };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url!, baseUrl);
    requests.push(url);
    res.setHeader('content-type', 'application/fhir+json');
    const path = url.pathname.slice('/fhir/'.length);
    if (path === 'metadata') { res.end(JSON.stringify(metadata)); return; }
    if (path.includes('/')) { if (!records[path]) { res.statusCode = 404; res.end('{}'); return; } res.end(JSON.stringify(records[path])); return; }
    const entries = Object.values(records).filter(resource => resource.resourceType === path);
    res.end(JSON.stringify({ resourceType: 'Bundle', type: 'searchset', link: [{ relation: 'self', url: url.href }], entry: entries.map(resource => ({ resource, search: { mode: 'match' } })) }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/fhir/`;
  return {
    requests, clinical: () => requests.filter(url => !url.pathname.endsWith('/metadata')).length,
    gateway: (privacy?: GatewayConfig['privacy']) => new FhirGateway({ mode: 'synthetic', source: { alias: 'w1', baseUrl }, patientId: A, ...(privacy ? { privacy } : {}) }),
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

test('A3 gateway: listed product identifiers are delivered; the default keeps today\'s withholding', async t => {
  const f = await fixture(); t.after(f.close);
  const listedGateway = f.gateway({ patientIdentifierSystems: [MRN], sharedIdentifierSystems: [PRODUCT] }); t.after(() => listedGateway.close());
  const read = await listedGateway.execute('fhir_read', { resource_type: 'Medication', id: 'med1', output: { format: 'fhir' } });
  assert.equal(read.error, undefined);
  assert.deepEqual(resources(read)[0]!.identifier, [listed()]);
  const order = await listedGateway.execute('fhir_read', { resource_type: 'MedicationRequest', id: 'm1', output: { format: 'fhir' } });
  assert.equal(order.error, undefined);
  assert.deepEqual(((resources(order)[0]!.contained as Rec[])[0]!).identifier, [listed()]);
  const orders = await listedGateway.execute('fhir_search', { resource_type: 'MedicationRequest', output: { format: 'fhir' } });
  assert.equal(orders.coverage.reasons.includes('RECORDS_WITHHELD_BY_POLICY'), false);
  // Search: a listed system is admitted and sent once; any other system is refused before any clinical request.
  let before = f.clinical();
  const admitted = await listedGateway.execute('fhir_search', { resource_type: 'Medication', params: [{ name: 'identifier', value: `${PRODUCT}|SYNTHETIC-PRODUCT-1` }], output: { format: 'fhir' } });
  assert.equal(admitted.error, undefined);
  assert.equal(f.clinical(), before + 1);
  for (const value of [`${OTHER}|x`, `${MRN}|x`, `${PRODUCT}|x,${OTHER}|y`]) {
    before = f.clinical();
    const refused = await listedGateway.execute('fhir_search', { resource_type: 'Medication', params: [{ name: 'identifier', value }], output: { format: 'fhir' } });
    assert.equal(refused.error?.code, 'POLICY_DENIED', value);
    assert.equal(f.clinical(), before, value);
  }
  const support = await listedGateway.execute('fhir_capabilities', { topic: 'resource', resource_type: 'Medication' });
  assert.equal((support.data as Rec).instance_policy, MEDICATION_LISTED_IDENTIFIERS_SUMMARY, 'the support row shows that an operator list is in effect');

  const defaultGateway = f.gateway(); t.after(() => defaultGateway.close());
  assert.equal((await defaultGateway.execute('fhir_read', { resource_type: 'Medication', id: 'med1', output: { format: 'fhir' } })).error?.code, 'NOT_FOUND');
  assert.equal((await defaultGateway.execute('fhir_read', { resource_type: 'MedicationRequest', id: 'm1', output: { format: 'fhir' } })).error?.code, 'NOT_FOUND');
  const withheld = await defaultGateway.execute('fhir_search', { resource_type: 'MedicationRequest', output: { format: 'fhir' } });
  assert.deepEqual(resources(withheld), []);
  assert.ok(withheld.coverage.reasons.includes('RECORDS_WITHHELD_BY_POLICY'), 'the patient\'s own order is withheld because of its contained identifier');
  before = f.clinical();
  assert.equal((await defaultGateway.execute('fhir_search', { resource_type: 'Medication', params: [{ name: 'identifier', value: `${PRODUCT}|x` }], output: { format: 'fhir' } })).error?.code, 'POLICY_DENIED',
    'with the default empty list every Medication identifier predicate is refused');
  assert.equal(f.clinical(), before);
  const defaultSupport = await defaultGateway.execute('fhir_capabilities', { topic: 'resource', resource_type: 'Medication' });
  assert.equal((defaultSupport.data as Rec).instance_policy, supportForType('Medication').instance_policy);
  assert.ok(MEDICATION_LISTED_IDENTIFIERS_SUMMARY.length <= 120);
});
