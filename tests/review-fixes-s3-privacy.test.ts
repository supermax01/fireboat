import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test, type TestContext } from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { FhirGateway, type GatewayEnvelope } from '../packages/core/src/index.js';
import type { FhirResource } from '../packages/core/src/contracts.js';
import { authorized, sanitize } from '../packages/core/src/privacy.js';
import { createMcpServer } from '../packages/server/src/index.js';

const patient = 'synthetic-a';
const patientSystem = 'urn:synthetic:patient-identifiers';
const directorySystem = 'urn:synthetic:directory';
const privacy = { patientIdentifierSystems: [patientSystem] };
const base = new URL('http://127.0.0.1:4321/fhir/');
const coding = { system: 'urn:synthetic:codes', code: 'useful-code', display: 'Useful catalog display', version: 'UsefulCodingVersion' };
const facility = { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-RoleCode', code: 'HOSP' }] };
const json = (value: unknown) => JSON.stringify(value);
const shared = (type: string, extra: Record<string, unknown> = {}): FhirResource => ({ resourceType: type, id: 'fixture', ...extra });
const observation = (extra: Record<string, unknown> = {}): FhirResource => shared('Observation', {
  status: 'final', code: { coding: [coding] }, subject: { reference: `Patient/${patient}` }, valueQuantity: { value: 7.2, unit: '%' }, ...extra,
});
const wrapper = (type: string, contained: FhirResource[]): FhirResource => type === 'Observation' ? observation({ contained, focus: contained.map(item => ({ reference: `#${item.id}` })) })
  : shared(type, { ...(type === 'Medication' ? { code: { coding: [coding] } } : { url: 'urn:synthetic:catalog', version: '2026', status: 'active' }), contained });

async function fixture(t: TestContext, resource: FhirResource, params: { name: string; type: string }[] = [{ name: 'patient', type: 'reference' }]) {
  let baseUrl = '';
  const clinical: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url!, baseUrl);
    res.setHeader('content-type', 'application/fhir+json');
    if (url.pathname.endsWith('/metadata')) {
      res.end(json({ resourceType: 'CapabilityStatement', fhirVersion: '4.0.1', rest: [{ mode: 'server', resource: [{ type: resource.resourceType, interaction: [{ code: 'read' }, { code: 'search-type' }], searchParam: params }] }] })); return;
    }
    clinical.push(url.pathname + url.search);
    if (url.pathname.endsWith(`/${resource.id}`)) { res.end(json(resource)); return; }
    const matches = (!url.searchParams.has('_content') || json(resource.text).includes(url.searchParams.get('_content')!))
      && (!url.searchParams.has('partof') || url.searchParams.get('partof') === (resource.partOf as { reference: string })?.reference);
    const next = new URL(url); next.searchParams.set('_getpagesoffset', '1');
    res.end(json({ resourceType: 'Bundle', type: 'searchset', link: [{ relation: 'self', url: url.href }, ...(!url.searchParams.has('_getpagesoffset') ? [{ relation: 'next', url: next.href }] : [])], entry: matches ? [{ resource, search: { mode: 'match' } }] : [] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  baseUrl = `http://127.0.0.1:${address.port}/fhir/`;
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const gateway = new FhirGateway({ mode: 'synthetic', source: { alias: 'fixture', baseUrl }, patientId: patient, privacy });
  t.after(() => gateway.close());
  return { gateway, clinical };
}

// Each review case exercises sanitized backing plus actual SDK calls in both eras,
// including continuation and retained full/selected views. These are diagnostic
// regression cases, not a claim that the frozen B2 catalogue has been executed.
async function exercise(t: TestContext, resource: FhirResource, secrets: string[], controls: string[], reason: string) {
  assert.ok(authorized(resource, patient, base), 'synthetic fixture reaches sanitization');
  const clean = sanitize(resource, privacy);
  assert.equal(clean.resource.id, resource.id, 'Resource.id is a structural logical id');
  for (const secret of secrets) assert.ok(!json(clean).includes(secret), 'backing and omission paths omit marker');
  for (const control of controls) assert.ok(json(clean.resource).includes(control), 'useful near-twin content preserved');
  assert.ok(clean.manifests.some(item => item.reason === reason), 'fixed omission reason');
  const { gateway } = await fixture(t, resource);
  for (const era of ['modern', 'legacy'] as const) {
    const client = new Client({ name: 'review-fixes', version: '1' }, era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } as never : undefined);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const server = serveStdio(({ era: selected }) => createMcpServer(gateway, { era: selected }), { transport: st });
    await client.connect(ct);
    const call = async (name: string, args: Record<string, unknown>, requireControls = true) => {
      const result = await client.callTool({ name, arguments: args });
      for (const secret of secrets) {
        assert.ok(!json(result.structuredContent).includes(secret), 'structuredContent omits marker');
        assert.ok(!json(result.content).includes(secret), 'text omits marker');
      }
      const env = result.structuredContent as unknown as GatewayEnvelope;
      assert.equal(env.error, undefined);
      if (requireControls) for (const control of controls) {
        assert.ok(json(env.data).includes(control), 'SDK control reaches structuredContent');
        assert.ok(json(result.content).includes(control), 'SDK control reaches text');
      }
      return env;
    };
    try {
      for (const format of ['fhir', 'compact'] as const) {
        const output = { format, max_bytes: 60000 };
        for (const tool of ['fhir_read', 'fhir_search']) {
          const env = await call(tool, { resource_type: resource.resourceType, ...(tool === 'fhir_read' ? { id: resource.id } : {}), output });
          assert.equal((env.data.resources as unknown[]).length, 1);
          assert.ok(env.result?.handle);
          for (const action of ['inspect', 'project', 'page']) await call('fhir_result', { handle: env.result.handle, action, output }, action !== 'inspect');
          await call('fhir_result', { handle: env.result.handle, action: 'project', fields: ['contained', 'identifier', 'subject', 'focus', 'code', 'name', 'photo', 'partOf', 'managingOrganization', 'operationalStatus', 'meta', 'compose', 'expansion'], output: { format: 'fhir', max_bytes: 60000 } }, false);
          if (tool === 'fhir_search') {
            assert.ok(env.pagination?.next_cursor);
            const page = await call('fhir_page', { cursor: env.pagination.next_cursor, output });
            await call('fhir_result', { handle: page.result!.handle, action: 'project', output });
          }
        }
      }
    } finally { await client.close(); await server.close(); }
  }
}

test('review S3-1/S3-2: directory veto remains live; shared Resource-base predicates refuse identical narrative twins', async t => {
  const resource = shared('Organization', { name: 'Useful directory name', partOf: { reference: 'Organization/org-1' } });
  const { gateway, clinical } = await fixture(t, resource, [{ name: 'partof', type: 'reference' }]);
  for (const value of ['org-1', 'https://outside.example/fhir/Organization/org-1']) {
    const env = await gateway.execute('fhir_search', { resource_type: 'Organization', params: [{ name: 'partof', value }] });
    assert.equal(env.error?.code, 'POLICY_DENIED'); assert.equal(clinical.length, 0);
  }
  const allowed = await gateway.execute('fhir_search', { resource_type: 'Organization', params: [{ name: 'partof', value: 'Organization/org-1' }], output: { format: 'fhir' } });
  assert.equal(allowed.error, undefined); assert.equal(clinical.length, 1);
  assert.ok(json(allowed.data).includes('Useful directory name'));
  for (const era of ['modern', 'legacy'] as const) {
    const twins: unknown[] = [];
    for (const mentions of [true, false]) {
      const { gateway: twin, clinical: sent } = await fixture(t, shared('Practitioner', { name: [{ family: 'Useful directory family' }], text: { status: 'generated', div: `<div>${mentions ? 'WithheldNarrativeMarker' : 'ordinary'}</div>` } }), [{ name: '_content', type: 'string' }, { name: '_tag', type: 'token' }, { name: '_security', type: 'token' }, { name: '_profile', type: 'uri' }, { name: '_source', type: 'uri' }, { name: '_id', type: 'token' }, { name: '_lastUpdated', type: 'date' }]);
      for (const name of ['_content', '_tag', '_security', '_profile', '_source']) {
        const env = await twin.execute('fhir_search', { resource_type: 'Practitioner', params: [{ name, value: 'WithheldNarrativeMarker' }] }, { era });
        assert.equal(env.error?.code, 'UNSUPPORTED_SEARCH'); assert.equal(sent.length, 0);
        const result = twin.toToolResult(env, { era });
        const normalize = (value: unknown): unknown => {
          if (typeof value === 'string' && value.startsWith('{')) return normalize(JSON.parse(value));
          if (Array.isArray(value)) return value.map(normalize);
          if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !['request_id', 'handle', 'elapsed_ms', 'bytes_returned'].includes(key)).map(([key, child]) => [key, normalize(child)]));
          return value;
        };
        twins.push(normalize({ structuredContent: result.structuredContent, content: result.content }));
      }
    }
    assert.deepEqual(twins.slice(0, 5), twins.slice(5), 'same refusals and text independent of withheld narrative');
    const { gateway: control, clinical: sent } = await fixture(t, shared('Practitioner', { name: [{ family: 'Useful directory family' }] }), [{ name: '_id', type: 'token' }, { name: '_lastUpdated', type: 'date' }]);
    for (const [name, value] of [['_id', 'fixture'], ['_lastUpdated', 'ge2020-01-01']]) {
      const env = await control.execute('fhir_search', { resource_type: 'Practitioner', params: [{ name, value }] }, { era });
      assert.equal(env.error, undefined); assert.equal((env.data.resources as unknown[]).length, 1);
    }
    assert.equal(sent.length, 2, 'explicit base-Resource exceptions remain executable');
  }
});

test('review PH-1: all standalone rules inherit through Medication/CodeSystem/ValueSet containment; A-linked twin stays exempt', async t => {
  for (const type of ['Medication', 'CodeSystem', 'ValueSet']) {
    const children = [
      shared('Medication', { code: { coding: [coding], text: 'HeldDrugText' }, manufacturer: { reference: 'RelatedPerson/private', display: 'HeldPersonDisplay' } }),
      shared('Organization', { name: 'Useful directory name', alias: ['HeldAlias'], identifier: [{ system: patientSystem, value: 'HeldPatientIdentifier' }] }),
      shared('Medication', { code: { coding: [coding] }, manufacturer: { reference: 'Practitioner/private', display: 'HeldWrongTarget' } }),
      shared('Medication', { code: { coding: [coding] }, manufacturer: { reference: `Patient/${patient}`, display: 'HeldPatientDisplay' } }),
      shared('Location', { type: [facility], name: 'Useful facility', description: 'HeldLocationDescription' }),
    ];
    const resource = wrapper(type, children);
    const clean = sanitize(resource, privacy);
    for (const reason of ['SHARED_FIELD_WITHHELD', 'PATIENT_IDENTIFIER_SYSTEM_WITHHELD', 'SHARED_PERSON_REFERENCE_WITHHELD', 'REFERENCE_TARGET_TYPE_WITHHELD']) assert.ok(clean.manifests.some(item => item.reason === reason), 'each inherited rule has a label');
    await exercise(t, resource, ['HeldDrugText', 'HeldAlias', 'HeldPatientIdentifier', 'HeldPersonDisplay', 'HeldWrongTarget', 'HeldPatientDisplay', 'HeldLocationDescription', 'RelatedPerson/private', 'Practitioner/private', `Patient/${patient}`], ['useful-code', 'Useful directory name', 'Useful facility'], 'SHARED_FIELD_WITHHELD');
    const twin = sanitize(wrapper('Observation', children), privacy);
    for (const control of ['HeldDrugText', 'HeldAlias', 'HeldPatientIdentifier', 'HeldLocationDescription', 'RelatedPerson/private', 'Practitioner/private']) assert.ok(json(twin.resource).includes(control), 'A-linked contained exemption remains intact');
  }
});

test('review PH-2: all six contained conformance types withhold D2 prose in shared and A-linked parents', async t => {
  const types = ['CodeSystem', 'ValueSet', 'CapabilityStatement', 'SearchParameter', 'StructureDefinition', 'OperationDefinition'];
  for (const parent of ['Medication', 'Observation']) {
    const children = types.map((type, i) => shared(type, { id: `contained-${i}`, version: '2026', url: `urn:synthetic:conformance:${i}`, description: `HeldDescription${i}`, publisher: `HeldPublisher${i}`, contact: [{ name: `HeldContact${i}` }], ...(type === 'OperationDefinition' ? { comment: 'HeldOperationComment' } : {}) }));
    await exercise(t, wrapper(parent, children), [...types.flatMap((_, i) => [`HeldDescription${i}`, `HeldPublisher${i}`, `HeldContact${i}`]), 'HeldOperationComment'], ['2026', 'urn:synthetic:conformance:0', 'useful-code'], 'SOURCE_PROSE_WITHHELD');
  }
});

test('review PH-3/PH-7: unclassified nested Identifiers are withheld; exact directory, case and suffix twins survive', async t => {
  const identifiers = [{ value: 'HeldSystemless' }, { type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'MR' }] }, value: 'HeldMrSystemless' }, { system: [patientSystem], value: 'HeldArraySystem' }, { system: patientSystem, value: 'HeldExactSystem' },
    ...[directorySystem, patientSystem.toUpperCase(), `${patientSystem}:suffix`].map((system, i) => ({ system, value: `UsefulIdentifier${i}`, type: { text: `HeldIdentifierProse${i}` } }))];
  const resource = shared('Practitioner', { name: [{ family: 'Useful directory family' }], identifier: identifiers, qualification: [{ identifier: [{ value: 'HeldNestedIdentifier' }], code: { coding: [coding] }, issuer: { reference: 'Organization/directory', identifier: { value: 'HeldReferenceIdentifier' } } }] });
  await exercise(t, resource, ['HeldSystemless', 'HeldMrSystemless', 'HeldArraySystem', 'HeldExactSystem', 'HeldNestedIdentifier', 'HeldReferenceIdentifier', ...[0, 1, 2].map(i => `HeldIdentifierProse${i}`)], ['UsefulIdentifier0', 'UsefulIdentifier1', 'UsefulIdentifier2', 'Useful directory family'], 'UNCLASSIFIED_IDENTIFIER_WITHHELD');
  const clean = sanitize(resource, privacy).resource;
  assert.equal((clean.identifier as unknown[]).length, 3, 'withheld complex Identifiers are dropped without null holes');
  const twin = shared('Organization', { name: 'Useful directory twin', identifier: identifiers.slice(0, 3).map(item => ({ ...item, system: directorySystem })) });
  for (const marker of ['HeldSystemless', 'HeldMrSystemless', 'HeldArraySystem']) assert.ok(json(sanitize(twin, privacy).resource).includes(marker), 'same value with classified directory system survives');
});

test('review PH-4: legal-looking undeclared keys never enter structuredContent, text or omission paths', async t => {
  const resource = shared('Practitioner', { name: [{ family: 'Useful directory family' }], identifier: [{ system: directorySystem, value: 'UsefulIdentifier', PrivateIdentityKeyCanary: 'HeldUndeclaredValue' }], qualification: [{ code: { coding: [coding] }, PrivateIdentityKeyCanaryTwo: 'HeldUndeclaredValue' }] });
  await exercise(t, resource, ['PrivateIdentityKeyCanary', 'HeldUndeclaredValue'], ['UsefulIdentifier', 'Useful directory family'], 'UNDECLARED_PROPERTY_WITHHELD');
  const clean = sanitize(resource, privacy);
  assert.ok(clean.manifests.some(item => item.path === '/identifier/0/[undeclared-property]' && item.reason === 'UNDECLARED_PROPERTY_WITHHELD'));
});

test('review PH-5: Patient Reference extension and primitive companions are withheld including valueIdentifier', async t => {
  const extensions = [
    { url: 'urn:synthetic:string', valueString: 'HeldExtensionString' },
    { url: 'urn:synthetic:identifier', valueIdentifier: { system: patientSystem, value: 'HeldExtensionIdentifier' } },
    { url: 'urn:synthetic:name', valueHumanName: { family: 'HeldExtensionName' } },
  ];
  const resource = observation({ subject: { reference: `Patient/${patient}`, type: 'Patient', extension: extensions, _reference: { extension: [{ url: 'urn:synthetic:reference', valueString: 'HeldReferenceExtension' }] }, _type: { extension: [{ url: 'urn:synthetic:type', valueString: 'HeldTypeExtension' }] } }, focus: [{ reference: `Patient/${patient}`, _reference: { extension: extensions } }, { reference: 'Practitioner/directory', extension: [{ url: 'urn:synthetic:control', valueString: 'Useful directory companion' }] }] });
  await exercise(t, resource, ['HeldExtensionString', 'HeldExtensionIdentifier', 'HeldExtensionName', 'HeldReferenceExtension', 'HeldTypeExtension'], [`Patient/${patient}`, 'Useful directory companion', 'useful-code'], 'PATIENT_REFERENCE_COMPANION_WITHHELD');
  const subject = sanitize(resource, privacy).resource.subject;
  assert.deepEqual(subject, { reference: `Patient/${patient}`, type: 'Patient' });
});

test('review PH-8: computable catalog strings survive prose withholding; emptied complex entries leave no null holes', async t => {
  for (const type of ['CodeSystem', 'ValueSet']) {
    const resource = shared(type, { url: 'urn:synthetic:catalog', version: '2026', name: 'UsefulComputableName', title: 'HeldTitle', description: 'HeldDescription', purpose: 'HeldPurpose', copyright: 'HeldCopyright', publisher: 'HeldPublisher', contact: [{ name: 'HeldContact' }],
      identifier: [{ system: patientSystem, value: 'HeldIdentifier' }],
      ...(type === 'CodeSystem' ? { filter: [{ code: 'synthetic-filter', operator: ['='], value: 'HeldCodeSystemFilter' }], concept: [{ code: 'useful-code', display: 'Useful catalog display', designation: [{ value: 'HeldDesignation' }], property: [{ code: 'note', valueString: 'HeldPropertyProse' }, { code: 'coded', valueCoding: coding }] }] }
        : { compose: { include: [{ system: coding.system, version: 'UsefulIncludeVersion', filter: [{ property: 'concept', op: 'is-a', value: 'UsefulIncludeFilter' }], concept: [{ code: 'useful-code', display: 'Useful catalog display', designation: [{ value: 'HeldDesignation' }] }] }], exclude: [{ system: coding.system, version: 'UsefulExcludeVersion', filter: [{ property: 'concept', op: '=', value: 'UsefulExcludeFilter' }] }] }, expansion: { timestamp: '2026-10-19T00:00:00Z', parameter: [{ name: 'UsefulExpansionParameter', valueBoolean: true }], contains: [{ code: 'useful-code', display: 'Useful catalog display', version: 'UsefulContainsVersion', contains: [{ code: 'nested', version: 'UsefulNestedVersion' }] }] } }),
    });
    await exercise(t, resource, ['HeldTitle', 'HeldDescription', 'HeldPurpose', 'HeldCopyright', 'HeldPublisher', 'HeldContact', 'HeldIdentifier', 'HeldDesignation', ...(type === 'CodeSystem' ? ['HeldPropertyProse', 'HeldCodeSystemFilter'] : [])], ['UsefulComputableName', '2026', 'useful-code', 'Useful catalog display', ...(type === 'ValueSet' ? ['UsefulIncludeFilter', 'UsefulExcludeFilter', 'UsefulExpansionParameter', 'UsefulIncludeVersion', 'UsefulExcludeVersion', 'UsefulContainsVersion', 'UsefulNestedVersion'] : ['UsefulCodingVersion'])], 'SOURCE_PROSE_WITHHELD');
    const clean = sanitize(resource, privacy).resource;
    assert.ok(!json(clean).includes('null'), 'policy-withheld complex arrays have no null entries');
    assert.equal((clean.identifier as unknown[]).length, 0);
    const concepts = (type === 'CodeSystem' ? clean.concept : (clean.compose as { include: { concept: unknown[] }[] }).include[0]!.concept) as { designation: unknown[] }[];
    assert.deepEqual(concepts[0]!.designation, [], 'fully withheld designation is dropped, not retained as an empty object');
    const extension = sanitize(shared(type, { version: '2026', extension: [{ url: 'version', valueString: 'HeldVersionNamedExtension' }] }), privacy);
    assert.ok(!json(extension).includes('HeldVersionNamedExtension'), 'version-named extension does not gain a structural-string exception');
  }
});

test('review PH-9: unlisted shared prose is withheld, typed facts and D1 residuals survive; A-linked twins preserve prose', async t => {
  // Id-shaped markers also catch a widened Resource.id rule after its FHIR-id
  // predicate is tightened: Element.id never inherits the Resource.id exception.
  const exactElements = wrapper('Medication', [shared('Location', {
    name: 'Useful facility', type: [{ id: 'HeldCodeableConceptId', ...facility }],
    identifier: [{ id: 'HeldIdentifierId', system: directorySystem, value: 'UsefulIdentifier' }],
    managingOrganization: { id: 'HeldReferenceId', reference: 'Organization/directory' },
  }), shared('StructureDefinition', { id: 'definition', name: 'HeldDefinitionName', version: 'UsefulDefinitionVersion', url: 'urn:synthetic:definition' }),
  shared('CapabilityStatement', { id: 'capability', version: 'UsefulConformanceVersion', software: { version: 'HeldSoftwareVersion' } })]);
  await exercise(t, exactElements, ['HeldCodeableConceptId', 'HeldIdentifierId', 'HeldReferenceId', 'HeldDefinitionName', 'HeldSoftwareVersion'],
    ['Useful facility', 'UsefulIdentifier', 'Organization/directory', 'UsefulDefinitionVersion', 'UsefulConformanceVersion'], 'SHARED_FIELD_WITHHELD');
  const exact = sanitize(exactElements, privacy);
  for (const path of ['/contained/0/type/0/id', '/contained/0/identifier/0/id', '/contained/0/managingOrganization/id', '/contained/1/name', '/contained/2/software/version']) {
    assert.ok(exact.manifests.some(item => item.path === path && ['SHARED_FIELD_WITHHELD', 'SOURCE_PROSE_WITHHELD'].includes(item.reason as string)), 'each exact-element negative control has a label');
  }
  assert.equal((exact.resource.contained as FhirResource[])[2]!.software, undefined, 'newly emptied complex object is dropped');
  const vectors = [
    shared('Practitioner', { name: [{ family: 'Useful directory family' }], photo: [{ title: 'HeldPhotoTitle', contentType: 'image/png', size: 42 }], qualification: [{ identifier: [{ system: directorySystem, value: 'UsefulIdentifier', type: { text: 'HeldNestedTypeText' } }], code: { coding: [coding] } }], meta: { tag: [{ system: coding.system, code: coding.code, display: 'HeldMetaDisplay' }] } }),
    shared('Organization', { name: 'Useful directory name', identifier: [{ system: directorySystem, value: 'UsefulIdentifier', type: { text: 'HeldIdentifierTypeText' } }], partOf: { reference: 'Organization/directory', display: 'HeldDirectoryDisplay' } }),
    shared('Location', { name: 'Useful facility', type: [facility], operationalStatus: { system: coding.system, code: 'O', display: 'HeldOperationalDisplay' }, managingOrganization: { reference: 'Organization/directory', display: 'HeldDirectoryDisplay' }, position: { longitude: 1, latitude: 2 } }),
    shared('Medication', { code: { coding: [coding] }, manufacturer: { reference: 'Organization/directory', display: 'HeldDirectoryDisplay', identifier: { system: directorySystem, value: 'HeldDirectoryReferenceIdentifier' } } }),
  ];
  for (const resource of vectors) {
    const secrets = ['HeldPhotoTitle', 'HeldNestedTypeText', 'HeldMetaDisplay', 'HeldIdentifierTypeText', 'HeldDirectoryDisplay', 'HeldDirectoryReferenceIdentifier', 'HeldOperationalDisplay'].filter(marker => json(resource).includes(marker));
    const controls = [resource.resourceType === 'Practitioner' ? 'Useful directory family' : resource.resourceType === 'Organization' ? 'Useful directory name' : resource.resourceType === 'Location' ? 'Useful facility' : 'Useful catalog display'];
    await exercise(t, resource, secrets, controls, 'SHARED_FIELD_WITHHELD');
    const clean = sanitize(resource, privacy);
    for (const key of ['manufacturer', 'partOf', 'managingOrganization']) {
      if (!resource[key]) continue;
      assert.deepEqual(clean.resource[key], { reference: 'Organization/directory' }, 'guarded directory literal survives; display and identifier do not');
      assert.ok(clean.manifests.some(item => item.path === `/${key}/display` && item.reason === 'SHARED_FIELD_WITHHELD'));
    }
    const twin = sanitize(wrapper('Observation', [resource]), privacy);
    for (const marker of secrets) assert.ok(json(twin.resource).includes(marker), 'same prose in A-linked content preserved');
    assert.ok(json(twin.resource).includes('7.2'), 'A critical measurement retained');
  }
  for (const target of ['RelatedPerson', 'Patient', 'Practitioner']) {
    const resource = shared('Medication', { code: { coding: [coding] }, manufacturer: { reference: `${target}/${target === 'Patient' ? patient : 'private'}`, display: 'HeldGuardedPersonDisplay' } });
    const clean = sanitize(resource, privacy);
    assert.equal(clean.resource.manufacturer, undefined, 'structural exception never precedes person/target guards');
    assert.ok(clean.manifests.some(item => item.reason === (target === 'Practitioner' ? 'REFERENCE_TARGET_TYPE_WITHHELD' : 'SHARED_PERSON_REFERENCE_WITHHELD')));
  }
});

test('review R2-1: unsupported shared references are withheld; typed directory references survive', async t => {
  for (const reference of ['HeldFreeTextReference prose', 'Organization/HeldMalformedReference prose', 'mailto:HeldMailReference@example.invalid']) {
    const resource = shared('Location', { name: 'Useful facility', type: [facility], managingOrganization: { reference } });
    const clean = sanitize(resource, privacy);
    assert.equal(clean.resource.managingOrganization, undefined);
    assert.ok(clean.manifests.some(item => item.path === '/managingOrganization' && item.reason === 'REFERENCE_TARGET_TYPE_WITHHELD'));
    await exercise(t, resource, [reference], ['Useful facility'], 'REFERENCE_TARGET_TYPE_WITHHELD');
    const twin = sanitize(shared('Location', { managingOrganization: { reference: 'Organization/org-1' } }), privacy);
    assert.deepEqual(twin.resource.managingOrganization, { reference: 'Organization/org-1' });
  }
  const person = sanitize(shared('Location', { managingOrganization: { reference: 'HeldFreeTextReference prose', type: 'Patient' } }), privacy);
  assert.ok(person.manifests.some(item => item.reason === 'SHARED_PERSON_REFERENCE_WITHHELD'), 'person guard retains precedence');
});

test('review R2-2: blank and relative Identifier systems are unclassified; absolute directory systems survive', async t => {
  const markers = ['HeldEmptySystem', 'HeldBlankSystem', 'HeldRelativeSystem'];
  const resource = shared('Practitioner', { name: [{ family: 'Useful directory family' }], identifier: [
    ...['', ' ', 'relative/system'].map((system, i) => ({ system, value: markers[i] })),
    ...[directorySystem, 'https://directory.example.invalid/ids'].map(system => ({ system, value: 'UsefulIdentifier' })),
  ] });
  const clean = sanitize(resource, privacy);
  assert.equal((clean.resource.identifier as unknown[]).length, 2);
  for (const index of [0, 1, 2]) assert.ok(clean.manifests.some(item => item.path === `/identifier/${index}` && item.reason === 'UNCLASSIFIED_IDENTIFIER_WITHHELD'));
  await exercise(t, resource, markers, ['Useful directory family', 'UsefulIdentifier', directorySystem, 'https://directory.example.invalid/ids'], 'UNCLASSIFIED_IDENTIFIER_WITHHELD');
});

test('review R2-3: prose Resource ids are withheld; FHIR ids survive and S4 still refuses malformed search entries', async t => {
  const invalid = ['HeldProseId synthetic', 'x'.repeat(65), 'Held_Invalid_Id'];
  const resource = wrapper('Medication', [
    ...invalid.map(id => shared('Organization', { id, name: 'Useful directory name' })),
    shared('Organization', { id: 'Valid-Id.0123', name: 'Useful directory name' }),
  ]);
  const clean = sanitize(resource, privacy);
  for (const index of [0, 1, 2]) assert.ok(clean.manifests.some(item => item.path === `/contained/${index}/id` && item.reason === 'SHARED_FIELD_WITHHELD'));
  await exercise(t, resource, invalid, ['useful-code', 'Useful directory name', 'Valid-Id.0123'], 'SHARED_FIELD_WITHHELD');
  const malformed = shared('Practitioner', { id: invalid[0], name: [{ family: 'Useful directory family' }] });
  assert.equal(sanitize(malformed, privacy).resource.id, undefined, 'root Resource.id uses the same FHIR-id predicate');
  const { gateway } = await fixture(t, malformed);
  for (const era of ['modern', 'legacy'] as const) {
    const env = await gateway.execute('fhir_search', { resource_type: 'Practitioner', output: { format: 'fhir' } }, { era });
    assert.equal(env.error, undefined);
    const rows = env.data.resources as FhirResource[];
    assert.equal(rows.length, 0, 'S4 refuses malformed search entries before projection');
    assert.ok(!json(gateway.toToolResult(env, { era })).includes(invalid[0]!));
  }
});
