import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { FhirGateway, type GatewayConfig, type GatewayEnvelope } from '../packages/core/src/index.js';
import type { FhirResource } from '../packages/core/src/contracts.js';
import { sanitize, authorized } from '../packages/core/src/privacy.js';
import { createMcpServer } from '../packages/server/src/index.js';

// Seeds: executed G5/G6/G7 repros in /tmp/b2gap47/tree/b2gap. Synthetic loopback only.
const patient = 'synthetic-a';
const mrn = 'urn:synthetic:patient-identifiers';
const npi = 'http://hl7.org/fhir/sid/us-npi';
const policy = { patientIdentifierSystems: [mrn] };
const base = new URL('http://127.0.0.1:4321/fhir/');
const coding = { system: 'urn:synthetic:codes', code: 'critical-code', version: '2026' };
const facility = { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-RoleCode', code: 'HOSP' }] };
const json = (value: unknown) => JSON.stringify(value);
interface Vector {
  name: string;
  reason: string;
  fields: string[];
  make: (secret: string, control: string) => FhirResource;
}
const shared = (type: string, extra: Record<string, unknown> = {}): FhirResource => ({ resourceType: type, id: 'fixture', ...extra });
const observation = (extra: Record<string, unknown>): FhirResource => ({ resourceType: 'Observation', id: 'fixture', status: 'final', code: { coding: [coding] }, subject: { reference: `Patient/${patient}` }, valueQuantity: { value: 7.2, unit: '%' }, ...extra });
const catalog = (type: string, extra: Record<string, unknown> = {}): FhirResource => shared(type, { url: 'urn:synthetic:catalog', version: '2026', status: 'active', ...(type === 'CodeSystem' ? { content: 'complete' } : {}), ...extra });
const vectors: Vector[] = [];
for (const position of ['subject', 'performer', 'focus'] as const) {
  for (const companion of ['display', '_display', 'identifier'] as const) {
    vectors.push({
      name: `G6 ${position}.${companion}`, reason: 'PATIENT_REFERENCE_COMPANION_WITHHELD', fields: ['subject', 'performer', 'focus', 'valueQuantity', 'code'],
      make: (secret, control) => {
        const reference = { reference: `Patient/${patient}`, [companion]: companion === 'identifier' ? { system: mrn, value: secret } : companion === '_display' ? { extension: [{ url: 'http://hl7.org/fhir/StructureDefinition/translation', extension: [{ url: 'content', valueString: secret }] }] } : secret };
        // focus is in the compact recipe, so directory companions are observable in all three views.
        return observation({ focus: [{ reference: 'Practitioner/directory', display: control, identifier: { system: npi, value: control } }], [position]: position === 'subject' ? reference : [reference, { reference: 'Organization/directory', display: control, identifier: { system: npi, value: control } }] });
      },
    });
  }
}
for (const type of ['Practitioner', 'Organization', 'Location', 'Medication', 'CodeSystem', 'ValueSet']) {
  vectors.push({
    name: `G7 ${type} patient-system Identifier`, reason: 'PATIENT_IDENTIFIER_SYSTEM_WITHHELD', fields: ['identifier', 'manufacturer', 'code', 'name', 'version'],
    make: (secret, control) => {
      const identifiers = [{ system: mrn, value: secret }, { system: npi, value: control }];
      if (type === 'Medication') return shared(type, { code: { coding: [{ ...coding, display: control }] }, manufacturer: { reference: 'Organization/catalog', identifier: identifiers[0] }, ingredient: [{ itemReference: { reference: 'Medication/catalog', identifier: identifiers[1] } }] });
      return (type === 'CodeSystem' || type === 'ValueSet' ? catalog : shared)(type, { identifier: identifiers, ...(type === 'Location' ? { type: [facility] } : {}) });
    },
  });
}
for (const target of ['Patient', 'RelatedPerson', 'Person', 'Location']) {
  vectors.push({
    name: `G7 Practitioner issuer ${target}`, reason: target === 'Location' ? 'REFERENCE_TARGET_TYPE_WITHHELD' : 'SHARED_PERSON_REFERENCE_WITHHELD', fields: ['qualification'],
    make: (secret, control) => shared('Practitioner', { qualification: [
      { code: { coding: [coding] }, issuer: { reference: `${target}/${target === 'Patient' ? patient : 'private'}`, display: secret } },
      { code: { coding: [{ ...coding, display: control }] }, issuer: { reference: 'Organization/directory', display: control } },
    ] }),
  });
}
for (const [field, target] of [['manufacturer', 'Patient'], ['ingredient', 'RelatedPerson'], ['manufacturer', 'Practitioner']] as const) {
  vectors.push({
    name: `G7 Medication ${field} ${target}`, reason: target === 'Practitioner' ? 'REFERENCE_TARGET_TYPE_WITHHELD' : 'SHARED_PERSON_REFERENCE_WITHHELD', fields: ['manufacturer', 'ingredient', 'code'],
    make: (secret, control) => shared('Medication', { code: { coding: [{ ...coding, display: control }] }, [field]: field === 'manufacturer'
      ? { reference: `${target}/${target === 'Patient' ? patient : 'private'}`, display: secret }
      : [{ itemReference: { reference: `${target}/private`, display: secret } }] }),
  });
}
vectors.push({
  name: 'G7 directory Identifier assigner bound Patient', reason: 'SHARED_PERSON_REFERENCE_WITHHELD', fields: ['identifier'],
  make: (secret, control) => shared('Practitioner', { identifier: [
    { system: npi, value: '1', assigner: { reference: `Patient/${patient}`, display: secret } },
    { system: npi, value: control, assigner: { reference: 'Organization/directory', display: control } },
  ] }),
});
vectors.push({
  name: 'G7 logical Person reference', reason: 'SHARED_PERSON_REFERENCE_WITHHELD', fields: ['qualification'],
  make: (secret, control) => shared('Practitioner', { qualification: [{ code: { coding: [{ ...coding, display: control }] }, issuer: { type: 'Person', identifier: { system: npi, value: secret } } }] }),
});
vectors.push({
  name: 'G7 incompatible declared target type', reason: 'REFERENCE_TARGET_TYPE_WITHHELD', fields: ['qualification'],
  make: (secret, control) => shared('Practitioner', { qualification: [{ code: { coding: [{ ...coding, display: control }] }, issuer: { reference: 'Organization/directory', type: 'Location', display: secret } }] }),
});
vectors.push({
  name: 'G7 false contained exemption on a shared scalar', reason: 'UNDECLARED_PROPERTY_WITHHELD', fields: ['name', 'identifier'],
  make: (secret, control) => shared('Organization', { name: { resourceType: 'Organization', alias: [secret], identifier: [{ system: mrn, value: secret }] }, identifier: [{ system: npi, value: control }] }),
});
for (const [field, type, extra] of [
  ['Organization.alias', 'Organization', {}], ['Location.alias', 'Location', { type: [facility] }],
  ['Location.description', 'Location', { type: [facility] }], ['Location.availabilityExceptions', 'Location', { type: [facility] }],
  ['Medication.code.text', 'Medication', {}],
] as const) {
  vectors.push({
    name: `D1 ${field}`, reason: 'SHARED_FIELD_WITHHELD', fields: ['alias', 'name', 'description', 'availabilityExceptions', 'code'],
    make: (secret, control) => type === 'Medication' ? shared(type, { code: { coding: [{ ...coding, display: control }], text: secret } })
      : shared(type, { ...extra, name: control, [field.split('.')[1]!]: field.endsWith('alias') ? [secret] : secret }),
  });
}
for (const type of ['CodeSystem', 'ValueSet']) {
  vectors.push({
    name: `G5 ${type} source prose`, reason: 'SOURCE_PROSE_WITHHELD', fields: ['url', 'version', 'description', 'purpose', 'copyright', 'publisher', 'contact', 'concept', 'compose', 'expansion'],
    make: (secret, control) => catalog(type, {
      description: secret, purpose: secret, copyright: secret, publisher: secret, contact: [{ name: secret, telecom: [{ system: 'email', value: secret }] }],
      ...(type === 'CodeSystem' ? { concept: [{ code: coding.code, display: control, definition: secret, designation: [{ language: 'en', value: secret }], concept: [{ code: 'nested', display: control, definition: secret }], property: [{ code: 'note', valueString: secret }] }] }
        : { compose: { include: [{ system: coding.system, version: coding.version, concept: [{ code: coding.code, display: control, designation: [{ value: secret }] }] }] }, expansion: { identifier: 'urn:synthetic:expansion', timestamp: '2026-10-19T00:00:00Z', contains: [{ system: coding.system, version: coding.version, code: coding.code, display: control, designation: [{ value: secret }], contains: [{ code: 'nested', display: control }] }] } }),
    }),
  });
}

interface ToolResult { content: { type: string; text?: string }[]; structuredContent?: unknown }
function scan(result: ToolResult, secret: string) {
  assert.ok(!json(result.structuredContent).includes(secret), 'structuredContent disclosure');
  for (const item of result.content) assert.ok(!(item.text ?? '').includes(secret), 'text disclosure');
}
function envelope(result: ToolResult): GatewayEnvelope {
  const env = result.structuredContent as GatewayEnvelope;
  assert.ok(env && !env.error, `successful structured envelope: ${env?.error?.code}`);
  for (const resource of (env.data.resources ?? []) as FhirResource[]) {
    if (resource.resourceType === 'Observation') {
      assert.equal((resource.valueQuantity as { value: number }).value, 7.2, 'critical measurement unchanged');
      assert.deepEqual((resource.code as { coding: unknown[] }).coding, [coding], 'clinical code unchanged');
    }
    if (resource.resourceType === 'Medication') {
      const code = (resource.code as { coding: typeof coding[] }).coding[0]!;
      assert.equal(code.code, coding.code); assert.equal(code.system, coding.system); assert.equal(code.version, coding.version);
    }
    if (resource.resourceType === 'CodeSystem' || resource.resourceType === 'ValueSet') assert.equal(resource.version, '2026', 'catalog version unchanged');
  }
  return env;
}

async function fixture(resource: FhirResource) {
  let baseUrl = '';
  const server = createServer((req, res) => {
    const url = new URL(req.url!, baseUrl);
    res.setHeader('content-type', 'application/fhir+json');
    const type = resource.resourceType;
    if (url.pathname.endsWith('/metadata')) {
      res.end(json({ resourceType: 'CapabilityStatement', fhirVersion: '4.0.1', rest: [{ mode: 'server', resource: [{ type, interaction: [{ code: 'read' }, { code: 'search-type' }], searchParam: [{ name: 'patient', type: 'reference' }, { name: 'code', type: 'token' }] }] }] })); return;
    }
    if (url.pathname === `/fhir/${type}/${resource.id}`) { res.end(json(resource)); return; }
    const next = new URL(url);
    next.searchParams.set('_getpagesoffset', '1');
    res.end(json({ resourceType: 'Bundle', type: 'searchset', link: [{ relation: 'self', url: url.href }, ...(!url.searchParams.has('_getpagesoffset') ? [{ relation: 'next', url: next.href }] : [])], entry: [{ resource, search: { mode: 'match' } }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  baseUrl = `http://127.0.0.1:${address.port}/fhir/`;
  return { baseUrl, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

for (const [index, vector] of vectors.entries()) {
  test(`privacy hardening: ${vector.name} — sanitize and SDK matrix`, async t => {
    const secret = `SYNTHETIC-DENIED-${index}`;
    const control = `SYNTHETIC-ALLOWED-${index}`;
    const resource = vector.make(secret, control);
    assert.ok(authorized(resource, patient, base), 'fixture reaches sanitization');
    const sanitized = sanitize(resource, policy);
    assert.ok(!json(sanitized).includes(secret), 'sanitized backing record and manifests');
    assert.ok(json(sanitized.resource).includes(control), 'near-twin directory/code control');
    if (vector.name.includes('patient-system Identifier')) {
      const twin = JSON.parse(json(resource).replaceAll(mrn, npi)) as FhirResource;
      if (resource.resourceType === 'Medication') {
        assert.ok(!json(sanitize(twin, policy).resource).includes(secret), 'Reference.identifier remains withheld under PH-9 even with a directory system');
      } else assert.ok(json(sanitize(twin, policy).resource).includes(secret), 'identical-value directory-system twin survives');
    }
    assert.ok(sanitized.manifests.some(item => item.reason === vector.reason), 'labelled omission');
    if (vector.reason === 'SHARED_PERSON_REFERENCE_WITHHELD') assert.ok(!/(?:Patient|RelatedPerson|Person)\//.test(json(sanitized.resource)), 'prohibited shared reference literal omitted');
    if (vector.name.startsWith('G6')) assert.ok(json(sanitized.resource).includes(`Patient/${patient}`), 'literal A link retained');
    const source = await fixture(resource); t.after(source.close);
    const gateway = new FhirGateway({ mode: 'synthetic', source: { alias: 'fixture', baseUrl: source.baseUrl }, patientId: patient, privacy: policy }); t.after(() => gateway.close());
    for (const era of ['modern', 'legacy'] as const) {
      const client = new Client({ name: 'privacy-hardening', version: '1' }, era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } as never : undefined);
      const [ct, st] = InMemoryTransport.createLinkedPair();
      const server = serveStdio(({ era: negotiatedEra }) => createMcpServer(gateway, { era: negotiatedEra }), { transport: st });
      await client.connect(ct);
      try {
        const call = async (name: string, args: Record<string, unknown>) => {
          const result = await client.callTool({ name, arguments: args }) as ToolResult;
          scan(result, secret);
          const env = envelope(result);
          if (json(env.data).includes(control)) assert.ok(result.content.some(item => item.text?.includes(control)), 'positive control reaches text as well as structuredContent');
          return env;
        };
        for (const output of [{ format: 'fhir' }, { format: 'compact' }, { format: 'fhir', fields: vector.fields }]) {
          const out = { ...output, max_bytes: 60000 };
          for (const tool of ['fhir_read', 'fhir_search']) {
            const result = await call(tool, { resource_type: resource.resourceType, ...(tool === 'fhir_read' ? { id: resource.id } : {}), output: out });
            assert.ok(result.result?.handle, `${era} ${tool} ${output.format} retained`);
            assert.equal((result.data.resources as unknown[]).length, 1);
            // A selected view may intentionally omit the allowed sibling; full/compact must preserve it.
            if (!output.fields) assert.ok(json(result.data).includes(control), `${era} ${tool} control survives`);
            for (const action of ['inspect', 'project', 'page']) {
              const retained = await call('fhir_result', { handle: result.result.handle, action, output: action === 'inspect' ? { format: 'fhir', max_bytes: 60000 } : out, ...(action === 'page' ? { offset: 0, limit: 1 } : {}) });
              if (action === 'inspect') assert.equal(retained.data.resource_count, 1);
              else if (!output.fields) assert.ok(json(retained.data).includes(control), 'retained control survives');
            }
            // A narrow retained projection must not poison the sanitized backing view.
            const narrow = await call('fhir_result', { handle: result.result.handle, action: 'project', fields: vector.fields, output: { format: 'fhir', max_bytes: 60000 } });
            assert.equal((narrow.data.resources as unknown[]).length, 1);
            if (tool === 'fhir_search') {
              assert.ok(result.pagination!.next_cursor, 'fixture has a continuation');
              const page = await call('fhir_page', { cursor: result.pagination!.next_cursor, output: out });
              assert.equal((page.data.resources as unknown[]).length, 1);
              if (!output.fields) assert.ok(json(page.data).includes(control), 'continued control survives');
              for (const action of ['inspect', 'project', 'page']) {
                const retained = await call('fhir_result', { handle: page.result!.handle, action, output: action === 'inspect' ? { format: 'fhir', max_bytes: 60000 } : out });
                if (action === 'inspect') assert.equal(retained.data.resource_count, 1);
              }
            }
          }
        }
      } finally { await client.close(); await server.close(); }
    }
  });
}

test('privacy hardening: trusted config accepts absolute URIs and rejects bad shapes', async () => {
  const config: GatewayConfig = { mode: 'synthetic', source: { alias: 'fixture', baseUrl: base.href }, patientId: patient };
  const gateway = new FhirGateway({ ...config, privacy: { patientIdentifierSystems: [mrn, npi, 'urn:oid:2.16.840.1'] } }); gateway.close();
  const boundary = new FhirGateway({ ...config, privacy: { patientIdentifierSystems: Array(32).fill('urn:' + 'x'.repeat(252)) } }); boundary.close();
  const empty = new FhirGateway({ ...config, privacy: {} });
  try {
    const result = await empty.execute('fhir_read', { resource_type: 'Patient', id: patient, privacy: policy });
    assert.equal(result.error?.code, 'INVALID_ARGUMENTS', 'model arguments cannot configure privacy');
  } finally { empty.close(); }
  for (const privacy of [null, [], 'bad', { extra: [] }, { patientIdentifierSystems: 'bad' }, { patientIdentifierSystems: [12] }, { patientIdentifierSystems: Array(33).fill(mrn) }, ...['', '/relative', 'relative', 'http://', ' urn:identifier', 'urn:bad\nvalue', 'urn:' + 'x'.repeat(253)].map(value => ({ patientIdentifierSystems: [value] }))]) {
    assert.throws(() => new FhirGateway({ ...config, privacy } as never), (error: unknown) => (error as { code?: string }).code === 'INVALID_CONFIG');
  }
  // Omitting the trusted list leaves directory systems alone, and tool args cannot set it.
  const directory = shared('Practitioner', { identifier: [{ system: mrn, value: 'allowed-default' }] });
  assert.ok(json(sanitize(directory).resource).includes('allowed-default'));
  const definition = shared('StructureDefinition', { type: 'Patient', identifier: [{ system: npi, value: 'structural-identifier' }] });
  assert.deepEqual(sanitize(definition, policy).resource, definition, 'a resource type field is not a Patient Reference');
});

test('privacy hardening: A-linked contained Medication keeps drug text while G6 companions are withheld', async t => {
  const secret = 'SYNTHETIC-CONTAINED-PATIENT-DISPLAY';
  const resource = { resourceType: 'MedicationRequest', id: 'fixture', status: 'active', intent: 'order', subject: { reference: `Patient/${patient}` },
    medicationReference: { reference: '#drug' }, contained: [{ resourceType: 'Medication', id: 'drug', code: { coding: [coding], text: 'Synthetic Amlodipine' }, manufacturer: { reference: `Patient/${patient}`, display: secret, identifier: { system: mrn, value: secret } }, ingredient: [{ itemReference: { reference: 'RelatedPerson/authorized-content', identifier: { system: mrn, value: 'A-linked-identifier-content' } } }] }] };
  assert.ok(authorized(resource, patient, base));
  const sanitized = sanitize(resource, policy);
  assert.ok(!json(sanitized).includes(secret), 'G6 applies inside contained resources');
  assert.ok(json(sanitized.resource).includes('Synthetic Amlodipine'), 'A-linked drug name remains a clinical fact');
  assert.ok(json(sanitized.resource).includes('RelatedPerson/authorized-content'), 'contained reference retains existing rules');
  assert.ok(json(sanitized.resource).includes('A-linked-identifier-content'), 'standalone identifier policy does not expand into A-linked contained content');
  const source = await fixture(resource); t.after(source.close);
  const gateway = new FhirGateway({ mode: 'synthetic', source: { alias: 'fixture', baseUrl: source.baseUrl }, patientId: patient, privacy: policy }); t.after(() => gateway.close());
  for (const era of ['modern', 'legacy'] as const) for (const format of ['fhir', 'compact'] as const) {
    const env = await gateway.execute('fhir_read', { resource_type: 'MedicationRequest', id: 'fixture', output: { format, max_bytes: 60000 } }, { era });
    assert.equal(env.error, undefined);
    scan(gateway.toToolResult(env, { era }) as ToolResult, secret);
    assert.ok(json(env.data).includes('Synthetic Amlodipine'));
    const retained = await gateway.execute('fhir_result', { handle: env.result!.handle, action: 'project', output: { format, max_bytes: 60000 } }, { era });
    scan(gateway.toToolResult(retained, { era }) as ToolResult, secret);
    assert.ok(json(retained.data).includes('Synthetic Amlodipine'));
  }
});
