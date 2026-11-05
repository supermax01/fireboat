import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { sanitize } from '../packages/core/src/privacy.js';
import * as schema from '../packages/core/src/schema.js';
import { isUriElement, R4_SCHEMA, resolveElement, resourceTypeContext, schemaPage, type TypeContext } from '../packages/core/src/schema.js';
import catalog from '../packages/core/src/generated/r4-index.json' with { type: 'json' };

type Field = { types: string[]; max: string; modifier?: boolean; content_reference?: string };
const definitions = catalog.definitions as Record<string, { kind: string; elements: Record<string, Field> }>;
const URI_TYPES = ['uri', 'url', 'canonical', 'oid', 'uuid'];
const jsonName = (leaf: string, type: string) => leaf.replace('[x]', `${type[0]!.toUpperCase()}${type.slice(1)}`);
// Regenerating with scripts/generate-r4-index.py must reproduce this reviewed index byte-for-byte.
const INDEX_SHA256 = 'f8cecd47647ffac4e8441eca20fd13cb25aed2b7ea8877e125bd06e21b575c9f';

test('pinned HL7 definitions resolve choices, datatype children, backbone paths, and recursive content references', () => {
  assert.equal(R4_SCHEMA.version, '4.0.1');
  assert.equal(R4_SCHEMA.definitions, 208);
  const root = resourceTypeContext('Observation')!;
  const quantity = resolveElement(root, 'valueQuantity');
  assert.deepEqual(quantity.types, ['Quantity']);
  assert.deepEqual(resolveElement(quantity.context, 'comparator').types, ['code']);
  const component = resolveElement(root, 'component');
  const range = resolveElement(component.context, 'referenceRange');
  const low = resolveElement(range.context, 'low');
  assert.deepEqual(low.types, ['Quantity']);
  assert.equal(isUriElement(resolveElement(low.context, 'system')), true);
  const questionnaire = resolveElement(resourceTypeContext('Questionnaire'), 'item');
  const recursive = resolveElement(questionnaire.context, 'item');
  assert.deepEqual(resolveElement(recursive.context, 'linkId').types, ['string']);
});

test('schema discovery exposes cardinality, required fields, choice names, and reference targets', () => {
  const page = schemaPage('Observation', '', 0, 50);
  assert.equal(page.evidence, 'pinned_base_definition');
  assert.equal(page.profile_validation, 'not_performed');
  const status = page.elements.find(field => field.path === 'status')!;
  assert.equal(status.min, 1);
  assert.equal(status.max, '1');
  assert.deepEqual(status.types, ['code']);
  const value = page.elements.find(field => field.path === 'value[x]')!;
  assert.ok(value.json_names?.includes('valueQuantity'));
  assert.ok(page.elements.find(field => field.path === 'subject')?.targets?.some(target => target.endsWith('/Patient')));
  assert.ok(schemaPage('Observation', 'valueQuantity', 0, 50).elements.some(field => field.path === 'valueQuantity.system'));
  const first = schemaPage('Observation', '', 0, 3);
  const next = schemaPage('Observation', '', 3, 3);
  assert.equal(first.total_elements, next.total_elements);
  assert.ok(!first.elements.some(field => next.elements.some(other => other.path === field.path)));
  assert.throws(() => schemaPage('Observation', 'madeUp', 0, 5), { code: 'INVALID_ELEMENT_PATH' });
});

test('schema-aware withholding covers canonical metadata names and choice datatypes instead of a name allowlist', () => {
  const secret = 'SCHEMA_URI_SECRET';
  const resources = [
    { resourceType: 'ValueSet', id: 'v1', compose: { include: [{ valueSet: [`vs/local?key=${secret}`] }], exclude: [{ valueSet: [`vs/excluded#${secret}`] }] } },
    { resourceType: 'StructureDefinition', id: 's1', baseDefinition: `sd/base?key=${secret}`, snapshot: { element: [{ contentReference: `#access_token=${secret}`, binding: { valueSet: `vs/binding?key=${secret}` } }] } },
    { resourceType: 'CapabilityStatement', id: 'c1', implementationGuide: [`ig/base?key=${secret}`], rest: [{ resource: [{ supportedProfile: [`prof/local?key=${secret}`] }] }] },
    { resourceType: 'Observation', id: 'o1', implicitRules: `rules/local?key=${secret}`, extension: [{ url: 'http://example.org/artifact', valueRelatedArtifact: { type: 'depends-on', resource: `library/local?key=${secret}` } }] },
    { resourceType: 'OperationDefinition', id: 'op1', inputProfile: `profile/input?key=${secret}`, outputProfile: `profile/output#${secret}`, base: `op/base?key=${secret}` },
    { resourceType: 'SearchParameter', id: 'sp1', derivedFrom: `search/base?key=${secret}`, component: [{ definition: `search/component?key=${secret}` }] },
  ];
  for (const resource of resources) {
    const result = sanitize(resource);
    assert.ok(!JSON.stringify(result).includes(secret), resource.resourceType);
    assert.ok(result.manifests.length > 0);
  }
});

test('URI redaction preserves FHIR primitive-array alignment and still screens extension metadata', () => {
  const result = sanitize({ resourceType: 'Observation', id: 'o1', meta: {
    profile: ['http://example.org/safe', 'profiles/unsafe?key=ALIGNMENT_SECRET', 'http://example.org/last'],
    _profile: [null, { extension: [{ url: 'http://example.org/provenance', valueUri: 'metadata/local?key=METADATA_SECRET' }] }, { id: 'last-profile-metadata' }],
  } });
  assert.ok(!JSON.stringify(result).includes('ALIGNMENT_SECRET'));
  assert.ok(!JSON.stringify(result).includes('METADATA_SECRET'));
  const meta = result.resource.meta as { profile: unknown[]; _profile: unknown[] };
  assert.deepEqual(meta.profile, ['http://example.org/safe', null, 'http://example.org/last']);
  assert.equal(meta._profile.length, 3);
  assert.deepEqual(meta._profile[2], { id: 'last-profile-metadata' });
  assert.ok(result.omitted.includes('/meta/profile/1'));
});

test('every URI-typed leaf in the pinned base definitions is screened for relative query links', () => {
  let checked = 0;
  for (const [name, definition] of Object.entries(catalog.definitions)) {
    for (const [path, field] of Object.entries(definition.elements) as [string, { types: string[]; max: string }][]) {
      const type = field.types.find(value => ['uri', 'url', 'canonical', 'oid', 'uuid'].includes(value));
      if (!type) continue;
      const source: Record<string, unknown> & { resourceType: string } = { resourceType: name };
      const parts = path.split('.');
      let parent: Record<string, unknown> = source;
      for (const part of parts.slice(0, -1)) { const child = {}; parent[part] = child; parent = child; }
      const leaf = parts.at(-1)!.replace('[x]', `${type[0]!.toUpperCase()}${type.slice(1)}`);
      const value = 'relative/path?arbitrary=SPEC_URI_LEAF_SECRET';
      parent[leaf] = field.max === '*' ? [value] : value;
      assert.ok(!JSON.stringify(sanitize(source)).includes('SPEC_URI_LEAF_SECRET'), `${name}.${path}`);
      checked++;
    }
  }
  assert.equal(checked, 355);
});

test('J-13: the reviewed index is pinned and maps every FHIRPath System type to its declared FHIR type', () => {
  assert.equal(createHash('sha256').update(readFileSync(new URL('../packages/core/src/generated/r4-index.json', import.meta.url))).digest('hex'), INDEX_SHA256);
  assert.equal(R4_SCHEMA.source_sha256, 'b090bf929e1f665cf2c91583720849695bc38d2892a7c5037c56cb00817fb091');
  for (const [name, definition] of Object.entries(definitions)) for (const [path, field] of Object.entries(definition.elements)) assert.ok(!field.types.some(type => type.startsWith('http://hl7.org/fhirpath/System.')), `${name}.${path}`);
  assert.deepEqual(Object.keys(definitions.Element!.elements).sort(), ['extension', 'id']);
  assert.deepEqual(resolveElement(resourceTypeContext('Extension'), 'url').types, ['uri']);
  assert.deepEqual(definitions.canonical!.elements.value!.types, ['canonical']);
  assert.deepEqual(resolveElement(resolveElement(resourceTypeContext('Observation'), '_status').context, 'id').types, ['string']);
});

test('J-13: every type context returned by resolveElement exists in the pinned catalog', () => {
  const exists = (context: TypeContext) => Object.hasOwn(definitions, context.definition) && (context.path === '' || Object.hasOwn(definitions[context.definition]!.elements, context.path));
  let checked = 0;
  for (const [name, definition] of Object.entries(definitions)) {
    for (const [path, field] of Object.entries(definition.elements)) {
      const dot = path.lastIndexOf('.');
      const parent: TypeContext = { definition: name, path: dot < 0 ? '' : path.slice(0, dot) };
      const leaf = path.slice(dot + 1);
      for (const key of leaf.endsWith('[x]') ? field.types.map(type => jsonName(leaf, type)) : [leaf]) {
        for (const json of [key, `_${key}`]) {
          const resolved = resolveElement(parent, json);
          if (!resolved.context) continue;
          assert.ok(exists(resolved.context), `${name}.${path} via ${json} -> ${resolved.context.definition}:${resolved.context.path}`);
          for (const child of ['extension', 'id']) if (resolved.context.definition === 'Element') assert.ok(resolveElement(resolved.context, child).types.length, child);
          checked++;
        }
      }
    }
  }
  assert.ok(checked > 10000, String(checked));
});

test('J-13: URI leaves are screened under primitive-extension companions, primitive arrays and backbone extensions', () => {
  const secret = 'COMPANION_URI_SECRET';
  const value = `relative/path?sig=${secret}`;
  // Every URI-typed leaf reachable through Extension.value[x], built as the extension's value.
  const extensions: Record<string, unknown>[] = [];
  for (const type of definitions.Extension!.elements['value[x]']!.types) {
    if (URI_TYPES.includes(type)) { extensions.push({ url: 'http://example.org/e', [jsonName('value[x]', type)]: value }); continue; }
    for (const [path, field] of Object.entries(definitions[type]?.kind === 'complex-type' ? definitions[type]!.elements : {})) {
      const uri = field.types.find(candidate => URI_TYPES.includes(candidate));
      if (!uri) continue;
      const root: Record<string, unknown> = {};
      let parent = root;
      const parts = path.split('.');
      for (const part of parts.slice(0, -1)) { const child = {}; parent[part] = child; parent = child; }
      parent[jsonName(parts.at(-1)!, uri)] = field.max === '*' ? [value] : value;
      extensions.push({ url: 'http://example.org/e', [jsonName('value[x]', type)]: root });
    }
  }
  assert.equal(extensions.length, 22);
  for (const extension of extensions) {
    const placements = [
      { resourceType: 'Observation', id: 'o', status: 'final', _status: { extension: [extension] } },
      { resourceType: 'Observation', id: 'o', status: 'final', _status: { extension: [{ url: 'http://example.org/outer', extension: [extension] }] } },
      { resourceType: 'Patient', id: 'p', name: [{ given: ['A', 'B'], _given: [null, { extension: [extension] }] }] },
      { resourceType: 'Observation', id: 'o', component: [{ code: { text: 'c' }, extension: [extension], modifierExtension: [extension] }] },
    ];
    for (const resource of placements) assert.ok(!JSON.stringify(sanitize(resource)).includes(secret), `${JSON.stringify(Object.keys(extension))} in ${JSON.stringify(resource).slice(0, 80)}`);
  }
  // The audit's concrete case: a RelatedArtifact canonical under a primitive companion.
  const result = sanitize({ resourceType: 'Observation', id: 'o', status: 'final', _status: { extension: [{ url: 'http://example.org/artifact', valueRelatedArtifact: { type: 'depends-on', resource: `Library/x?sig=${secret}` } }] } });
  assert.ok(result.omitted.includes('/_status/extension/0/valueRelatedArtifact/resource'));
});

test('J-4/J-13: resolveElement exposes declared names, modifier flags and reference targets', () => {
  const observation = resourceTypeContext('Observation');
  assert.equal(resolveElement(observation, 'effectiveInstant').name, 'effective[x]');
  assert.ok(resolveElement(observation, 'subject').targets?.some(target => target.endsWith('/Patient')));
  assert.equal(resolveElement(observation, 'status').modifier, true);
  assert.equal(resolveElement(resourceTypeContext('MedicationRequest'), 'doNotPerform').modifier, true);
  assert.equal(resolveElement(resourceTypeContext('Patient'), 'deceasedBoolean').modifier, true);
  assert.equal(resolveElement(observation, 'code').modifier, undefined);
  assert.ok(schema.modifierElements('ServiceRequest').includes('doNotPerform'));
});
