import assert from 'node:assert/strict';
import { test } from 'node:test';
// Namespace imports: these tests also run against the pre-fix module revision to prove that they fail there.
import * as privacy from '../packages/core/src/privacy.js';
import * as decimal from '../packages/core/src/decimal.js';
import * as schema from '../packages/core/src/schema.js';
import catalog from '../packages/core/src/generated/r4-index.json' with { type: 'json' };
import type { FhirResource } from '../packages/core/src/contracts.js';
import { lab, output, patient, withGateway, withSdk, type Rec } from './s57-sdk-helpers.js';

// Same-class follow-ups to R1/R2 (synthetic only): malformed upstream shapes that bypassed the linkage decision or
// the payload screen. Each block names the fix it pins; the SDK tests drive the real client through every path.

const a = patient;
const foreign = 'synthetic-b-sameclass';
const B = `Patient/${foreign}`;
const base = new URL('http://127.0.0.1:4321/fhir/');
const json = (value: unknown) => JSON.stringify(value);
const ok = (resource: FhirResource) => privacy.authorized(resource, a, base);
const obs = (extra: Rec = {}): FhirResource => ({ resourceType: 'Observation', id: 'o1', status: 'final', code: { coding: [{ system: 'http://loinc.org', code: '4548-4' }], text: 'HbA1c' },
  subject: { reference: `Patient/${a}` }, effectiveDateTime: '2026-01-02T10:00:00Z', ...extra });
const encounter = (extra: Rec = {}): FhirResource => ({ resourceType: 'Encounter', id: 'e1', status: 'finished', class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB' },
  subject: { reference: `Patient/${a}` }, ...extra });
const withheldAt = (result: privacy.Sanitized, path: string, reason: string) => result.manifests.some(m => m.path === path && m.reason === reason);
const originOf = (result: privacy.Sanitized, path: string, reason: string) => result.manifestOrigins[result.manifests.findIndex(m => m.path === path && m.reason === reason)];
const CANARY = Buffer.from('SAME_CLASS_PAYLOAD_CANARY').toString('base64');

// ------------------------------------------------- 1: unreadable members --

// kills: same-class-unreadable-reference-member
test('same-class 1: an unreadable (non-string) Reference.reference or Reference.type is refused and withheld, even where Patient is not a legal target', () => {
  const cases: [string, FhirResource, string][] = [
    ['device type array beside a foreign identifier (Device targets only)', obs({ device: { type: ['Patient'], identifier: { system: 'urn:synthetic:mrn', value: foreign } } }), '/device'],
    ['device reference array', obs({ device: { reference: [B] } }), '/device'],
    ['device reference object', obs({ device: { reference: { value: B } } }), '/device'],
    ['performer type object', obs({ performer: [{ reference: 'Practitioner/p1', type: { text: 'Patient' }, display: foreign }] }), '/performer/0'],
    ['the bound subject with an unreadable type', obs({ subject: { reference: `Patient/${a}`, type: ['Patient'] } }), '/subject'],
    ['unknown-context reference-like node', obs({ vendorRef: { type: { text: 'Patient' }, display: foreign } }), '/vendorRef'],
    ['loose node on a known context', obs({ code: { text: 'x', reference: [B] } }), '/code'],
  ];
  for (const [label, resource, path] of cases) {
    assert.equal(ok(resource), false, `authorization refuses: ${label}`);
    const result = privacy.sanitize(resource);
    assert.ok(withheldAt(result, path, 'MALFORMED_LINKAGE_WITHHELD'), `${label}: ${json(result.manifests)}`);
    assert.ok(!json(result.resource).includes(foreign), `${label}: ${json(result.resource)}`);
  }
  // A shared record's unreadable reference is withheld whole by the standalone layer too.
  const shared = privacy.sanitize({ resourceType: 'Organization', id: 'org1', name: 'Synthetic Org', partOf: { type: ['Patient'], display: foreign } });
  assert.ok(withheldAt(shared, '/partOf', 'MALFORMED_LINKAGE_WITHHELD'), json(shared.manifests));
  assert.ok(!json(shared.resource).includes(foreign));
});

test('same-class 1 control: string members and declared non-string members of their own context are unchanged', () => {
  assert.equal(ok(obs({ performer: [{ reference: 'Practitioner/p1', type: 'Practitioner', display: 'Synthetic clinician' }] })), true);
  const eob: FhirResource = { resourceType: 'ExplanationOfBenefit', id: 'eob1', status: 'active', type: { text: 'Synthetic' }, use: 'claim', patient: { reference: `Patient/${a}` }, created: '2025-01-01',
    insurer: { reference: 'Organization/o1' }, provider: { reference: 'Practitioner/p1' }, outcome: 'complete', insurance: [{ focal: true, coverage: { reference: 'Coverage/c1' } }],
    related: [{ reference: { system: 'urn:synthetic:claims', value: 'claim-1' } }] };
  assert.deepEqual(schema.resolveElement(schema.resolveElement(schema.resourceTypeContext('ExplanationOfBenefit'), 'related').context, 'reference').types, ['Identifier']);
  assert.equal(ok(eob), true, 'EOB.related.reference is a declared Identifier, not an unreadable reference');
  assert.deepEqual(privacy.sanitize(eob).resource.related, eob.related);
  const participant = encounter({ participant: [{ type: [{ text: 'attender' }], individual: { reference: 'Practitioner/p1' } }] });
  assert.equal(ok(participant), true, 'a CodeableConcept type on a backbone is its own declared element');
  assert.deepEqual(privacy.sanitize(participant).resource.participant, (participant as Rec).participant);
});

// ---------------------------------- 2: scalar Identifier / linkage carrier --

// kills: same-class-linkage-carrying-members-off
test('same-class 2: a scalar Identifier inside a Reference, or any scalar where a linkage-carrying structure is declared, is refused', () => {
  const cases: [string, FhirResource, string][] = [
    ['Reference.identifier scalar where Patient is not a legal target', obs({ device: { identifier: B } }), '/device/identifier'],
    ['Reference.identifier scalar beside a type', obs({ device: { type: 'Device', identifier: foreign } }), '/device/identifier'],
    ['Observation.identifier scalar (Identifier carries assigner)', obs({ identifier: [foreign] }), '/identifier/0'],
    ['extension scalar (Extension.value[x] admits Reference)', obs({ extension: [B] }), '/extension/0'],
    ['note scalar (Annotation.author[x] admits Reference)', obs({ note: [B] }), '/note/0'],
    ['backbone with a Reference member', encounter({ participant: [B] }), '/participant/0'],
  ];
  for (const [label, resource, path] of cases) {
    assert.equal(ok(resource), false, `authorization refuses: ${label}`);
    const result = privacy.sanitize(resource);
    assert.ok(withheldAt(result, path, 'MALFORMED_LINKAGE_WITHHELD'), `${label}: ${json(result.manifests)}`);
    assert.ok(!json(result.resource).includes(foreign), label);
  }
  assert.equal(ok(obs({ device: { identifier: { system: 'http://example.org/devices', value: 'synthetic-device' } } })), true, 'a well-formed Identifier is unchanged');
});

// ----------------------------------------- 3: complex `_x` companions -----

// kills: same-class-complex-companion-as-element
test('same-class 3: `_x` beside a complex element is judged by that element, not as an Element companion', () => {
  const observation = schema.resourceTypeContext('Observation');
  assert.deepEqual(schema.resolveElement(observation, '_focus'), schema.resolveElement(observation, 'focus'));
  assert.deepEqual(schema.resolveElement(observation, '_code'), schema.resolveElement(observation, 'code'));
  assert.equal(schema.resolveElement(observation, '_status').context?.definition, 'Element', 'a primitive keeps its Element companion');
  for (const [label, resource, path] of [['_focus scalar', obs({ _focus: B }), '/_focus'], ['_focus string array', obs({ _focus: [B] }), '/_focus/0'],
    ['_performer nested', obs({ _performer: [[B]] }), '/_performer/0/0']] as [string, FhirResource, string][]) {
    assert.equal(ok(resource), false, `authorization refuses: ${label}`);
    const result = privacy.sanitize(resource);
    assert.ok(withheldAt(result, path, 'MALFORMED_LINKAGE_WITHHELD'), `${label}: ${json(result.manifests)}`);
    assert.ok(!json(result.resource).includes(foreign), label);
  }
  const code = privacy.sanitize(obs({ _code: B }));
  assert.ok(withheldAt(code, '/_code', 'MALFORMED_STRUCTURE_WITHHELD'), json(code.manifests));
  assert.ok(!json(code.resource).includes(foreign));
  const masked = { extension: [{ url: 'http://hl7.org/fhir/StructureDefinition/data-absent-reason', valueCode: 'masked' }] };
  const companion = privacy.sanitize(obs({ _status: masked, _effectiveDateTime: masked }));
  assert.deepEqual([companion.manifests, companion.resource._status, companion.resource._effectiveDateTime], [[], masked, masked], 'primitive companions are unchanged');
});

// -------------------------------------- 4: canonical/uri (pinned) --------

// kills: same-class-canonical-judged-as-linkage
test('same-class 4 (pinned decision): canonical and uri strings that spell Patient/x are not linkage and pass unchanged', () => {
  // Evidence from the pinned R4 index: Patient has no `url` element and no canonical element targets Patient.
  const definitions = (catalog as { definitions: Record<string, { elements: Record<string, { types: string[]; targets?: string[] }> }> }).definitions;
  assert.equal(Object.hasOwn(definitions.Patient!.elements, 'url'), false);
  const canonical = Object.values(definitions).flatMap(definition => Object.values(definition.elements)).filter(element => element.types.includes('canonical'));
  assert.ok(canonical.length > 50);
  assert.equal(canonical.filter(element => element.targets?.some(target => target.endsWith('/Patient'))).length, 0);
  const resource = obs({ meta: { source: B, profile: [B] }, extension: [
    { url: 'http://example.org/c', valueCanonical: B }, { url: 'http://example.org/u', valueUri: B }, { url: 'http://example.org/l', valueUrl: B }] });
  assert.equal(ok(resource), true);
  const result = privacy.sanitize(resource);
  assert.deepEqual(result.manifests, []);
  assert.deepEqual(result.resource.extension, (resource as Rec).extension);
  assert.deepEqual(result.resource.meta, (resource as Rec).meta);
  // The existing conservative screen on uri `reference` members still applies.
  assert.equal(ok(obs({ extension: [{ url: 'http://example.org/e', valueExpression: { language: 'text/cql', reference: B } }] })), false);
});

// ------------------------------------------- 5: complex-type scalars -----

// kills: same-class-complex-scalar-passthrough
test('same-class 5: any other scalar where a complex type is declared is withheld (as a payload for an Attachment), not passed through', () => {
  const cases: [string, FhirResource, string, string, string][] = [
    ['CodeableConcept string', obs({ code: B }), '/code', 'MALFORMED_STRUCTURE_WITHHELD', 'policy'],
    ['Quantity number', obs({ valueQuantity: 6.1 }), '/valueQuantity', 'MALFORMED_STRUCTURE_WITHHELD', 'policy'],
    ['Quantity lossless decimal', obs({ valueQuantity: new decimal.FhirDecimal('6.10') }), '/valueQuantity', 'MALFORMED_STRUCTURE_WITHHELD', 'policy'],
    ['CodeableConcept array of strings', obs({ category: [foreign] }), '/category/0', 'MALFORMED_STRUCTURE_WITHHELD', 'policy'],
    ['Meta boolean', obs({ meta: true }), '/meta', 'MALFORMED_STRUCTURE_WITHHELD', 'policy'],
    ['Element companion string', obs({ _status: foreign }), '/_status', 'MALFORMED_STRUCTURE_WITHHELD', 'policy'],
    ['Attachment string', { resourceType: 'DiagnosticReport', id: 'r1', status: 'final', code: { text: 'x' }, subject: { reference: `Patient/${a}` }, presentedForm: [CANARY] }, '/presentedForm/0', 'V1_PAYLOAD_WITHHELD', 'payload'],
  ];
  for (const [label, resource, path, reason, origin] of cases) {
    assert.equal(ok(resource), true, `${label}: not linkage-carrying, so authorization still decides by linkage`);
    const result = privacy.sanitize(resource);
    assert.ok(withheldAt(result, path, reason), `${label}: ${json(result.manifests)}`);
    assert.equal(originOf(result, path, reason), origin, label);
    assert.ok(!json(result.resource).includes(foreign) && !json(result.resource).includes(CANARY), `${label}: ${json(result.resource)}`);
  }
  const condition = privacy.sanitize({ resourceType: 'Condition', id: 'c1', subject: { reference: `Patient/${a}` }, code: { text: 'Synthetic' }, clinicalStatus: 'active' });
  assert.ok(withheldAt(condition, '/clinicalStatus', 'MALFORMED_STRUCTURE_WITHHELD'));
  assert.equal(condition.requiresStructuralView, true, 'a withheld modifier prohibits a confident clinical view');
  const masked = { extension: [{ url: 'http://hl7.org/fhir/StructureDefinition/data-absent-reason', valueCode: 'masked' }] };
  const aligned = privacy.sanitize({ resourceType: 'Patient', id: a, name: [{ given: ['Alpha', null], _given: [null, masked] }] });
  assert.deepEqual([aligned.manifests, aligned.resource.name], [[], [{ given: ['Alpha', null], _given: [null, masked] }]], 'null alignment holes in companion arrays stay legal');
});

// ------------------------------------------------ 6: base64 by type ------

// kills: same-class-base64-by-key-only
test('same-class 6: base64Binary content is withheld by type and *Base64Binary name, not only under data/valueBase64Binary', () => {
  const definitions = (catalog as { definitions: Record<string, { elements: Record<string, { types: string[] }> }> }).definitions;
  const hashes = Object.entries(definitions).flatMap(([name, definition]) => Object.entries(definition.elements)
    .filter(([path, element]) => element.types.includes('base64Binary') && path.split('.').at(-1) === 'hash').map(([path]) => `${name}.${path}`));
  assert.deepEqual(hashes, ['Attachment.hash'], 'the hash exemption names exactly one element');
  const structure = { resourceType: 'StructureDefinition', id: 'sd1', url: 'http://example.org/sd', name: 'SyntheticProfile', status: 'active', kind: 'resource', abstract: false, type: 'Observation',
    snapshot: { element: [{ id: 'Observation', path: 'Observation', fixedBase64Binary: CANARY, patternBase64Binary: CANARY, defaultValueBase64Binary: CANARY, example: [{ label: 'x', valueBase64Binary: CANARY }] }] } };
  assert.equal(privacy.sharedInstanceAllowed(structure), true, 'the shared conformance record itself is deliverable');
  const shared = privacy.sanitize(structure as FhirResource);
  for (const path of ['/snapshot/element/0/fixedBase64Binary', '/snapshot/element/0/patternBase64Binary', '/snapshot/element/0/defaultValueBase64Binary', '/snapshot/element/0/example/0/valueBase64Binary']) {
    assert.ok(withheldAt(shared, path, 'V1_PAYLOAD_WITHHELD'), `${path}: ${json(shared.manifests)}`);
    assert.equal(originOf(shared, path, 'V1_PAYLOAD_WITHHELD'), 'payload', path);
  }
  const device = privacy.sanitize({ resourceType: 'Device', id: 'd1', udiCarrier: [{ deviceIdentifier: 'synthetic', carrierAIDC: CANARY }] });
  assert.ok(withheldAt(device, '/udiCarrier/0/carrierAIDC', 'V1_PAYLOAD_WITHHELD'));
  const audit = privacy.sanitize({ resourceType: 'AuditEvent', id: 'ae1', entity: [{ query: CANARY }] });
  assert.ok(withheldAt(audit, '/entity/0/query', 'V1_PAYLOAD_WITHHELD'));
  const vendor = privacy.sanitize(obs({ vendorBase64Binary: { value: CANARY } }));
  assert.ok(withheldAt(vendor, '/vendorBase64Binary', 'V1_PAYLOAD_WITHHELD'), 'an undeclared *Base64Binary key is a payload by name');
  for (const result of [shared, device, audit, vendor]) assert.ok(!json(result.resource).includes(CANARY), json(result.resource));
  // Control: Attachment.hash is manifest metadata and stays.
  const hash = Buffer.alloc(20, 7).toString('base64');
  const doc = privacy.sanitize({ resourceType: 'DocumentReference', id: 'doc1', status: 'current', subject: { reference: `Patient/${a}` }, content: [{ attachment: { contentType: 'text/plain', hash, data: CANARY } }] });
  assert.deepEqual(doc.manifests, [{ path: '/content/0/attachment/data', reason: 'V1_PAYLOAD_WITHHELD', content_type: 'text/plain', hash }]);
  assert.deepEqual(doc.resource.content, [{ attachment: { contentType: 'text/plain', hash } }]);
});

// ------------------------------------------------- end to end (SDK) -------

const ids = (r: Rec) => (r.e.data.resources as Rec[]).map(resource => resource.id);

test('same-class e2e 1-3: SDK read, search, page and retained results refuse unreadable members, scalar identifiers and complex `_x` scalars', async () => {
  const typeArray = lab('synthetic-sc-type', { device: { type: ['Patient'], identifier: { system: 'urn:synthetic:mrn', value: foreign } } });
  const idScalar = lab('synthetic-sc-identifier', { device: { identifier: B } });
  const companion = lab('synthetic-sc-companion', { _focus: B });
  const ok1 = lab('synthetic-sc-ok-1'), ok2 = lab('synthetic-sc-ok-2');
  for (const era of ['modern', 'legacy'] as const) {
    await withGateway({ pages: [[ok1, typeArray, idScalar], [companion, ok2]] }, gateway => withSdk(gateway, era, async sdk => {
      const clean = (r: Rec, label: string) => { assert.ok(!r.raw.includes(foreign), `${era} ${label}: wire`); assert.ok(!json(r.e).includes(foreign), `${era} ${label}: envelope`); };
      for (const id of [typeArray.id, idScalar.id, companion.id]) {
        const read = await sdk.call('fhir_read', { resource_type: 'Observation', id, output });
        assert.equal(read.e.error?.code, 'NOT_FOUND', `${era} read ${id}`);
        clean(read, `read ${id}`);
      }
      const search = await sdk.call('fhir_search', { resource_type: 'Observation', page_size: 20, output });
      assert.equal(search.e.error, undefined);
      assert.deepEqual(ids(search), [ok1.id]);
      clean(search, 'search');
      const page = await sdk.call('fhir_page', { cursor: search.e.pagination.next_cursor, output });
      assert.equal(page.e.error, undefined);
      assert.deepEqual(ids(page), [ok2.id]);
      clean(page, 'page');
      for (const handle of [search.e.result?.handle, page.e.result?.handle].filter(Boolean)) clean(await sdk.call('fhir_result', { handle, action: 'project', output }), 'retained');
    }));
  }
});

test('same-class e2e 5-6: SDK read, search, page and retained results withhold complex-type scalars and base64 by type', async () => {
  const malformed = lab('synthetic-sc-shape', { code: B, valueQuantity: 6.1, vendorBase64Binary: CANARY });
  const malformed2 = lab('synthetic-sc-shape-2', { category: [foreign], vendorBase64Binary: [CANARY] });
  const expected = [{ path: '/code', reason: 'MALFORMED_STRUCTURE_WITHHELD' }, { path: '/valueQuantity', reason: 'MALFORMED_STRUCTURE_WITHHELD' }, { path: '/vendorBase64Binary', reason: 'V1_PAYLOAD_WITHHELD' }];
  for (const era of ['modern', 'legacy'] as const) {
    await withGateway({ pages: [[malformed], [malformed2]] }, gateway => withSdk(gateway, era, async sdk => {
      const clean = (r: Rec, label: string) => {
        assert.equal(r.e.error, undefined, `${era} ${label}`);
        for (const canary of [foreign, CANARY]) { assert.ok(!r.raw.includes(canary), `${era} ${label}: wire`); assert.ok(!json(r.e).includes(canary), `${era} ${label}: envelope`); }
      };
      const manifests = (r: Rec) => r.e.transform.withheld_payloads as Rec[];
      for (const format of ['fhir', 'compact'] as const) {
        const view = { format, max_bytes: 24576 };
        const read = await sdk.call('fhir_read', { resource_type: 'Observation', id: malformed.id, output: view });
        clean(read, `${format} read`);
        for (const entry of expected) assert.ok(manifests(read).some(m => m.path === entry.path && m.reason === entry.reason), `${era} ${format}: ${json(entry)} in ${json(manifests(read))}`);
        clean(await sdk.call('fhir_result', { handle: read.e.result.handle, action: 'project', output: view }), `${format} retained read`);
        const search = await sdk.call('fhir_search', { resource_type: 'Observation', page_size: 20, output: view });
        clean(search, `${format} search`);
        assert.deepEqual(ids(search), [malformed.id]);
        const page = await sdk.call('fhir_page', { cursor: search.e.pagination.next_cursor, output: view });
        clean(page, `${format} page`);
        assert.deepEqual(ids(page), [malformed2.id]);
        assert.ok(manifests(page).some(m => m.path === '/category/0' && m.reason === 'MALFORMED_STRUCTURE_WITHHELD'), json(manifests(page)));
        for (const handle of [search.e.result?.handle, page.e.result?.handle].filter(Boolean)) clean(await sdk.call('fhir_result', { handle, action: 'page', offset: 0, limit: 5, output: view }), `${format} retained page`);
      }
    }));
  }
});
