import assert from 'node:assert/strict';
import { test } from 'node:test';
// Namespace imports: these tests also run against the pre-fix module revision to prove that they fail there.
import * as privacy from '../packages/core/src/privacy.js';
import * as decimal from '../packages/core/src/decimal.js';
import * as schema from '../packages/core/src/schema.js';
import type { FhirResource } from '../packages/core/src/contracts.js';
import { lab, output, patient, withGateway, withSdk, type Rec } from './s57-sdk-helpers.js';

// Malformed upstream structure (synthetic only). R1: a scalar where the schema declares a Reference, a Resource
// or another reference-carrying structure never reaches the reference decision as a leaf; authorization refuses
// the resource and sanitize withholds the value. R2: payload keys and the protected attachment link are withheld
// by key and schema context whatever the value's JSON shape.

const a = patient;
const foreign = 'synthetic-b-r1canary';
const B = `Patient/${foreign}`;
const base = new URL('http://127.0.0.1:4321/fhir/');
const json = (value: unknown) => JSON.stringify(value);
const ok = (resource: FhirResource) => privacy.authorized(resource, a, base);
const obs = (extra: Rec = {}): FhirResource => ({ resourceType: 'Observation', id: 'o1', status: 'final', code: { coding: [{ system: 'http://loinc.org', code: '4548-4' }], text: 'HbA1c' },
  subject: { reference: `Patient/${a}` }, effectiveDateTime: '2026-01-02T10:00:00Z', ...extra });
const immunization = (extra: Rec = {}): FhirResource => ({ resourceType: 'Immunization', id: 'i1', status: 'completed', vaccineCode: { text: 'Synthetic vaccine' },
  patient: { reference: `Patient/${a}` }, occurrenceDateTime: '2025-01-01', ...extra });
const originOf = (result: privacy.Sanitized, path: string, reason: string) => result.manifestOrigins[result.manifests.findIndex(m => m.path === path && m.reason === reason)];

// ---------------------------------------------------------------- R1 -------

// kills: r1-scalar-reference-leaf
test('R1: a scalar in a schema-declared Reference, Resource or reference-carrying position is refused and withheld, never a leaf', () => {
  const cases: [string, FhirResource, string][] = [
    ['focus string (the reported case)', obs({ focus: B }), '/focus'],
    ['focus array of strings', obs({ focus: [B] }), '/focus/0'],
    ['focus mixed with the bound patient', obs({ focus: [{ reference: `Patient/${a}` }, B] }), '/focus/1'],
    ['performer nested arrays', obs({ performer: [[B]] }), '/performer/0/0'],
    ['encounter: any scalar, not only a Patient-shaped one', obs({ encounter: 'Encounter/e1' }), '/encounter'],
    ['hasMember number', obs({ hasMember: [12345] }), '/hasMember/0'],
    ['basedOn boolean', obs({ basedOn: [true] }), '/basedOn/0'],
    ['partOf null', obs({ partOf: [null] }), '/partOf/0'],
    ['specimen lossless decimal', obs({ specimen: new decimal.FhirDecimal('1.50') }), '/specimen'],
    ['note authorReference (choice)', obs({ note: [{ text: 'Synthetic note', authorReference: B }] }), '/note/0/authorReference'],
    ['identifier assigner (nested datatype)', obs({ identifier: [{ value: 'synthetic-accession', assigner: B }] }), '/identifier/0/assigner'],
    ['extension valueReference', obs({ extension: [{ url: 'http://example.org/r', valueReference: B }] }), '/extension/0/valueReference'],
    ['nested extension valueReference array', obs({ component: [{ code: { text: 'c' }, extension: [{ url: 'http://example.org/r', valueReference: [B] }] }] }), '/component/0/extension/0/valueReference/0'],
    ['contained string', obs({ contained: [B] }), '/contained/0'],
    ['contained number', obs({ contained: [42] }), '/contained/0'],
    ['focus inside a contained resource', obs({ contained: [{ resourceType: 'Observation', id: 'c1', status: 'final', code: { text: 'c' }, subject: { reference: `Patient/${a}` }, focus: B }] }), '/contained/0/focus'],
    ['Expression scalar (its uri `reference` member is judged)', obs({ extension: [{ url: 'http://example.org/e', valueExpression: B }] }), '/extension/0/valueExpression'],
    ['Immunization.education scalar (its uri `reference` member is judged)', immunization({ education: [B] }), '/education/0'],
  ];
  for (const [label, resource, path] of cases) {
    assert.equal(ok(resource), false, `authorization refuses: ${label}`);
    const result = privacy.sanitize(resource);
    assert.ok(!json(result.resource).includes(foreign), `sanitize drops the foreign identifier: ${label}`);
    assert.ok(result.manifests.some(m => m.path === path && m.reason === 'MALFORMED_LINKAGE_WITHHELD'), `${label}: ${json(result.manifests)}`);
    assert.equal(originOf(result, path, 'MALFORMED_LINKAGE_WITHHELD'), 'policy', `${label}: a schema-known site`);
  }
  // The pre-existing linkage refusals for the link element itself are unchanged.
  assert.equal(ok(obs({ subject: `Patient/${a}` })), false);
  assert.equal(ok(obs({ subject: [{ reference: `Patient/${a}` }] })), false);
});

test('R1 control: an A-only resource with well-formed references and ordinary scalars still authorizes unchanged', () => {
  const control = obs({
    focus: [{ reference: `Patient/${a}` }], performer: [{ reference: 'Practitioner/p1', display: 'Synthetic clinician' }], hasMember: [{ reference: '#c1' }],
    contained: [{ resourceType: 'Observation', id: 'c1', status: 'final', code: { text: 'c' }, subject: { reference: `Patient/${a}` } }],
    extension: [{ url: 'http://example.org/e', valueExpression: { language: 'text/cql', expression: 'true' } }, { url: 'http://example.org/s', valueString: 'synthetic' }],
    valueQuantity: { value: new decimal.FhirDecimal('6.10'), unit: '%' }, note: [{ text: 'Synthetic note' }], identifier: [{ value: 'synthetic-accession' }],
  });
  assert.equal(ok(control), true);
  const result = privacy.sanitize(control);
  assert.ok(!result.manifests.some(m => m.reason === 'MALFORMED_LINKAGE_WITHHELD'), json(result.manifests));
  assert.deepEqual(result.resource.focus, [{ reference: `Patient/${a}` }]);
  assert.deepEqual(result.resource.performer, [{ reference: 'Practitioner/p1', display: 'Synthetic clinician' }]);
  assert.deepEqual(result.resource.hasMember, [{ reference: '#c1' }]);
  assert.equal((result.resource.contained as Rec[])[0]?.id, 'c1');
  assert.ok(decimal.isFhirDecimal((result.resource.valueQuantity as Rec).value), 'decimal leaves outside linkage positions are untouched');
  const education = immunization({ education: [{ documentType: 'synthetic', reference: 'http://example.org/vis' }] });
  assert.equal(ok(education), true);
  assert.deepEqual(privacy.sanitize(education).resource.education, [{ documentType: 'synthetic', reference: 'http://example.org/vis' }]);
});

// ---------------------------------------------------------------- R2 -------

const CANARY = Buffer.from('R2_PAYLOAD_CANARY').toString('base64');
const BYTES = [...Buffer.from('R2CANARY')];
const LINK = 'R2LINKCANARY';
const hash = Buffer.alloc(20, 7).toString('base64');
const shapes: [string, unknown][] = [
  ['string', CANARY], ['object', { value: CANARY }], ['array of strings', [CANARY]], ['array of numbers', BYTES], ['number', 8250],
  ['boolean', true], ['lossless decimal', new decimal.FhirDecimal('1.50')], ['null', null], ['nested arrays', [[{ value: CANARY }]]],
];
const leaks = (value: unknown) => { const text = typeof value === 'string' ? value : json(value); return text.includes(CANARY) || text.includes(BYTES.join(',')) || text.includes(LINK); };

// kills: r2-payload-shape-dependent
test('R2: payload keys are withheld by key and schema context in every JSON shape, with the string-case manifest and origin', () => {
  for (const [label, shape] of shapes) {
    const doc = privacy.sanitize({ resourceType: 'DocumentReference', id: 'd1', status: 'current', subject: { reference: `Patient/${a}` },
      content: [{ attachment: { contentType: 'text/plain', size: 17, hash, title: 'Synthetic note', data: shape } }] });
    assert.deepEqual(doc.manifests, [{ path: '/content/0/attachment/data', reason: 'V1_PAYLOAD_WITHHELD', content_type: 'text/plain', size: 17, hash }], label);
    assert.deepEqual(doc.manifestOrigins, ['payload'], label);
    assert.deepEqual((doc.resource.content as Rec[])[0], { attachment: { contentType: 'text/plain', size: 17, hash, title: 'Synthetic note' } }, label);
    const extension = privacy.sanitize(obs({ extension: [{ url: 'http://example.org/b', valueBase64Binary: shape }] }));
    assert.deepEqual(extension.manifests, [{ path: '/extension/0/valueBase64Binary', reason: 'V1_PAYLOAD_WITHHELD' }], label);
    assert.deepEqual(extension.manifestOrigins, ['payload'], label);
    assert.deepEqual(extension.resource.extension, [{ url: 'http://example.org/b' }], label);
    // A schema Attachment without contentType, and an undeclared vendor node: still payloads by key.
    const photo = privacy.sanitize({ resourceType: 'Patient', id: a, photo: [{ title: 'Synthetic portrait', data: shape }] });
    assert.deepEqual(photo.manifests, [{ path: '/photo/0/data', reason: 'V1_PAYLOAD_WITHHELD' }], label);
    assert.deepEqual(photo.manifestOrigins, ['payload'], label);
    const vendor = privacy.sanitize(obs({ vendorDocument: { title: 'Synthetic', data: shape } }));
    assert.equal(originOf(vendor, '/vendorDocument/data', 'V1_PAYLOAD_WITHHELD'), 'payload', label);
    for (const result of [doc, extension, photo, vendor]) assert.ok(!leaks(result.resource), `${label}: ${json(result.resource)}`);
  }
});

test('R2 control: metadata-only attachments and schema-declared complex data elements are not payloads', () => {
  const attachment = { contentType: 'text/plain', size: 17, hash, title: 'Synthetic note', language: 'en' };
  const meta = privacy.sanitize({ resourceType: 'DocumentReference', id: 'd1', status: 'current', subject: { reference: `Patient/${a}` }, content: [{ attachment }] });
  assert.deepEqual(meta.manifests, []);
  assert.deepEqual(meta.resource.content, [{ attachment }]);
  // TriggerDefinition.data is a DataRequirement by schema: structure, not a payload. A string there is still withheld.
  const triggerContext = schema.resolveElement(schema.resolveElement(schema.resourceTypeContext('Extension'), 'valueTriggerDefinition').context, 'data');
  assert.deepEqual(triggerContext.types, ['DataRequirement']);
  const trigger = { url: 'http://example.org/t', valueTriggerDefinition: { type: 'data-changed', data: [{ type: 'Observation', profile: ['http://example.org/p'] }] } };
  const kept = privacy.sanitize(obs({ extension: [trigger] }));
  assert.deepEqual(kept.manifests, []);
  assert.deepEqual(kept.resource.extension, [trigger]);
  const stringData = privacy.sanitize(obs({ extension: [{ url: 'http://example.org/t', valueTriggerDefinition: { type: 'data-changed', data: CANARY } }] }));
  assert.deepEqual(stringData.manifests, [{ path: '/extension/0/valueTriggerDefinition/data', reason: 'V1_PAYLOAD_WITHHELD' }]);
});

// kills: r2-attachment-link-shape-dependent (optional)
test('R2: the protected attachment link and the attachment context it depends on are shape-independent', () => {
  for (const [label, shape] of [['string', `Binary/${LINK}`], ['object', { value: `Binary/${LINK}` }], ['array', [`Binary/${LINK}`]], ['number', 42]] as [string, unknown][]) {
    const doc = privacy.sanitize({ resourceType: 'DocumentReference', id: 'd1', status: 'current', subject: { reference: `Patient/${a}` }, content: [{ attachment: { contentType: 'text/plain', url: shape } }] });
    assert.deepEqual(doc.manifests, [{ path: '/content/0/attachment/url', reason: 'PROTECTED_LINK', content_type: 'text/plain' }], label);
    assert.deepEqual(doc.manifestOrigins, ['attachment'], label);
    const report = privacy.sanitize({ resourceType: 'DiagnosticReport', id: 'r1', status: 'final', code: { text: 'x' }, subject: { reference: `Patient/${a}` }, presentedForm: [{ title: 'Synthetic', url: shape }] });
    assert.deepEqual(report.manifests, [{ path: '/presentedForm/0/url', reason: 'PROTECTED_LINK' }], label);
    assert.deepEqual(report.manifestOrigins, ['attachment'], label);
    for (const result of [doc, report]) assert.ok(!leaks(result.resource), `${label}: ${json(result.resource)}`);
  }
  // A payload or contentType sibling marks an attachment context whatever its own shape; such a context inferred
  // without schema withholds the link but never classifies it.
  for (const sibling of [{ data: { value: CANARY } }, { data: BYTES }, { contentType: ['text/plain'] }]) {
    const vendor = privacy.sanitize(obs({ vendorDocument: { ...sibling, url: `Binary/${LINK}` } }));
    assert.equal(originOf(vendor, '/vendorDocument/url', 'PROTECTED_LINK'), 'unknown', json(sibling));
    assert.ok(!leaks(vendor.resource), json(vendor.resource));
  }
});

// ------------------------------------------------- end to end (SDK) --------

const ids = (r: Rec) => (r.e.data.resources as Rec[]).map(resource => resource.id);

test('R1 e2e: SDK read, search, page and retained results never carry a scalar foreign reference', async () => {
  const bad1 = lab('synthetic-r1-bad-1', { focus: [B] });
  const bad2 = lab('synthetic-r1-bad-2', { extension: [{ url: 'http://example.invalid/r', valueReference: B }] });
  const ok1 = lab('synthetic-r1-ok-1', { focus: [{ reference: `Patient/${patient}` }] }), ok2 = lab('synthetic-r1-ok-2');
  for (const era of ['modern', 'legacy'] as const) {
    await withGateway({ pages: [[ok1, bad1], [bad2, ok2]] }, gateway => withSdk(gateway, era, async sdk => {
      const clean = (r: Rec, label: string) => { assert.ok(!r.raw.includes(foreign), `${era} ${label}: wire`); assert.ok(!json(r.e).includes(foreign), `${era} ${label}: envelope`); };
      for (const id of [bad1.id, bad2.id]) {
        const read = await sdk.call('fhir_read', { resource_type: 'Observation', id, output });
        assert.equal(read.e.error?.code, 'NOT_FOUND', `${era} read ${id}`);
        clean(read, `read ${id}`);
      }
      const control = await sdk.call('fhir_read', { resource_type: 'Observation', id: ok1.id, output: { format: 'compact', max_bytes: 24576 } });
      assert.equal(control.e.error, undefined, `${era}: the A-only control reads`);
      assert.deepEqual((control.e.data.resources as Rec[])[0]?.focus, [{ reference: `Patient/${patient}` }], `${era}: compact keeps focus`);
      for (const format of ['fhir', 'compact'] as const) {
        const view = { format, max_bytes: 24576 };
        const search = await sdk.call('fhir_search', { resource_type: 'Observation', page_size: 20, output: view });
        assert.equal(search.e.error, undefined, `${era} ${format} search`);
        assert.deepEqual(ids(search), [ok1.id], `${era} ${format}: the malformed entry is suppressed`);
        clean(search, `${format} search`);
        assert.ok(search.e.pagination.next_cursor, `${era} ${format}: a continuation remains`);
        const page = await sdk.call('fhir_page', { cursor: search.e.pagination.next_cursor, output: view });
        assert.equal(page.e.error, undefined, `${era} ${format} page`);
        assert.deepEqual(ids(page), [ok2.id], `${era} ${format}: the malformed entry is suppressed on the next page`);
        clean(page, `${format} page`);
        const handles = [search.e.result?.handle, page.e.result?.handle].filter(Boolean);
        assert.ok(handles.length > 0, `${era} ${format}: retained results exist`);
        for (const handle of handles) {
          const projected = await sdk.call('fhir_result', { handle, action: 'project', output: view });
          assert.equal(projected.e.error, undefined);
          clean(projected, `${format} retained project`);
          const paged = await sdk.call('fhir_result', { handle, action: 'page', offset: 0, limit: 5, output: view });
          assert.equal(paged.e.error, undefined);
          clean(paged, `${format} retained page`);
        }
      }
    }));
  }
});

test('R2 e2e: SDK read, search, page and retained results never carry non-string payloads or attachment links', async () => {
  const att = lab('synthetic-r2-att', { extension: [
    { url: 'http://example.invalid/att', valueAttachment: { contentType: 'text/plain', data: { value: CANARY }, url: { value: `Binary/${LINK}` } } },
    { url: 'http://example.invalid/blob', valueBase64Binary: BYTES },
  ] });
  const att2 = lab('synthetic-r2-att-2', { extension: [{ url: 'http://example.invalid/att', valueAttachment: { contentType: 'text/plain', data: [[CANARY]] } }] });
  const person = { resourceType: 'Patient', id: patient, gender: 'female', photo: [{ contentType: 'image/png', data: { value: CANARY } }] };
  const expected = [
    { path: '/extension/0/valueAttachment/data', reason: 'V1_PAYLOAD_WITHHELD', content_type: 'text/plain' },
    { path: '/extension/0/valueAttachment/url', reason: 'PROTECTED_LINK', content_type: 'text/plain' },
    { path: '/extension/1/valueBase64Binary', reason: 'V1_PAYLOAD_WITHHELD' },
  ];
  for (const era of ['modern', 'legacy'] as const) {
    await withGateway({ pages: [[att], [att2]], records: [att, att2, person] }, gateway => withSdk(gateway, era, async sdk => {
      const clean = (r: Rec, label: string) => { assert.equal(r.e.error, undefined, `${era} ${label}`); assert.ok(!leaks(r.raw), `${era} ${label}: wire`); assert.ok(!leaks(r.e), `${era} ${label}: envelope`); };
      const manifests = (r: Rec) => r.e.transform.withheld_payloads as Rec[];
      for (const format of ['fhir', 'compact'] as const) {
        const view = { format, max_bytes: 24576 };
        const read = await sdk.call('fhir_read', { resource_type: 'Observation', id: att.id, output: view });
        clean(read, `${format} read`);
        for (const entry of expected) assert.ok(manifests(read).some(m => json(m) === json(entry)), `${era} ${format}: ${json(entry)} in ${json(manifests(read))}`);
        const retained = await sdk.call('fhir_result', { handle: read.e.result.handle, action: 'project', output: view });
        clean(retained, `${format} retained read`);
        for (const entry of expected) assert.ok(manifests(retained).some(m => json(m) === json(entry)), `${era} ${format} retained: ${json(entry)}`);
        const search = await sdk.call('fhir_search', { resource_type: 'Observation', page_size: 20, output: view });
        clean(search, `${format} search`);
        assert.deepEqual(ids(search), [att.id]);
        const page = await sdk.call('fhir_page', { cursor: search.e.pagination.next_cursor, output: view });
        clean(page, `${format} page`);
        assert.deepEqual(ids(page), [att2.id]);
        assert.ok(manifests(page).some(m => m.path === '/extension/0/valueAttachment/data' && m.reason === 'V1_PAYLOAD_WITHHELD'), `${era} ${format}: nested-array payload manifest`);
        const handles = [search.e.result?.handle, page.e.result?.handle].filter(Boolean);
        assert.ok(handles.length > 0, `${era} ${format}: retained results exist`);
        for (const handle of handles) {
          clean(await sdk.call('fhir_result', { handle, action: 'project', output: view }), `${format} retained search project`);
          clean(await sdk.call('fhir_result', { handle, action: 'page', offset: 0, limit: 5, output: view }), `${format} retained search page`);
        }
      }
      const photo = await sdk.call('fhir_read', { resource_type: 'Patient', id: patient, output });
      clean(photo, 'Patient read');
      assert.deepEqual((photo.e.data.resources as Rec[])[0]?.photo, [{ contentType: 'image/png' }]);
      assert.ok(manifests(photo).some(m => json(m) === json({ path: '/photo/0/data', reason: 'V1_PAYLOAD_WITHHELD', content_type: 'image/png' })), json(manifests(photo)));
    }));
  }
});
