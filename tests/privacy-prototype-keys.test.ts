import assert from 'node:assert/strict';
import { test } from 'node:test';
// Namespace import: these tests also run against the pre-fix module revision to prove that they fail there.
import * as privacy from '../packages/core/src/privacy.js';
import catalog from '../packages/core/src/generated/r4-index.json' with { type: 'json' };
import type { FhirResource } from '../packages/core/src/contracts.js';
import { lab, output, patient, withGateway, withSdk, type Rec } from './s57-sdk-helpers.js';

// Prototype-key class (synthetic only): `resourceClass` once looked a contained `resourceType` up in a plain object
// with `in`, so an inherited Object.prototype name (`__proto__`, `constructor`, `toString`, ...) was classed as a
// patient-linked type. Its "link" was then read under the inherited value's string form, which a crafted child could
// supply with the bound patient, and the child was authorized and delivered. Such a child must be refused exactly as
// a contained Basic or RelatedPerson child (an ambiguous class) is.

const a = patient;
const base = new URL('http://127.0.0.1:4321/fhir/');
const json = (value: unknown) => JSON.stringify(value);
const CANARY = 'SyntheticPrototypeKeyCanary';
const REQUIRED = ['__proto__', 'constructor', 'toString', 'hasOwnProperty'];
const INHERITED = [...new Set([...REQUIRED, ...Object.getOwnPropertyNames(Object.prototype)])];
// The property key a plain-object lookup of `type` would have produced (`[object Object]`, `function Object() ...`).
const inheritedKey = (type: string): string => String(({} as Record<string, unknown>)[type]);
/** One contained child; only `resourceType` differs between the crafted and control forms. */
const child = (type: string, key = inheritedKey('__proto__')): Rec => ({ resourceType: type, id: 'pk-child', [key]: { reference: `Patient/${a}` },
  patient: { reference: `Patient/${a}` }, name: [{ family: CANARY, given: [CANARY] }], birthDate: '1970-01-01' });
const observation = (contained?: Rec[]): FhirResource => ({ resourceType: 'Observation', id: 'pk-obs', status: 'final', code: { coding: [{ system: 'http://loinc.org', code: '4548-4' }] },
  subject: { reference: `Patient/${a}` }, effectiveDateTime: '2026-01-02T10:00:00Z', ...(contained ? { contained } : {}) });

// kills: resource-class-prototype-key
test('prototype keys: resourceClass treats every inherited Object.prototype name as ambiguous', () => {
  for (const name of REQUIRED) assert.ok(INHERITED.includes(name));
  for (const name of INHERITED) {
    assert.equal(privacy.resourceClass(name), 'ambiguous', name);
    assert.equal(privacy.patientLinkForType(name), null, name);
  }
});

test('prototype keys control: every pinned R4 resource type keeps its class', () => {
  const patientLinked = ['Patient', 'Observation', 'Condition', 'AllergyIntolerance', 'MedicationRequest', 'MedicationStatement', 'Encounter', 'DocumentReference', 'DiagnosticReport',
    'Immunization', 'Procedure', 'Coverage', 'ExplanationOfBenefit', 'ServiceRequest', 'Claim',
    // Seven more patient-linked types.
    'MedicationAdministration', 'MedicationDispense', 'Specimen', 'CarePlan', 'CareTeam', 'ImagingStudy', 'Device'];
  const shared = ['Medication', 'Organization', 'Location', 'Practitioner', 'CodeSystem', 'ValueSet', 'StructureDefinition', 'SearchParameter', 'CapabilityStatement', 'OperationDefinition'];
  const definitions = (catalog as { definitions: Record<string, { kind: string }> }).definitions;
  const types = Object.keys(definitions).filter(type => definitions[type]!.kind === 'resource');
  assert.ok(types.length > 140, `pinned R4 resource types: ${types.length}`);
  for (const type of [...patientLinked, ...shared]) assert.ok(types.includes(type), type);
  for (const type of types) {
    const expected = patientLinked.includes(type) ? 'patient' : shared.includes(type) ? 'shared' : 'ambiguous';
    assert.equal(privacy.resourceClass(type), expected, type);
  }
  assert.equal(types.filter(type => privacy.resourceClass(type) === 'patient').length, patientLinked.length);
  assert.equal(types.filter(type => privacy.resourceClass(type) === 'shared').length, shared.length);
});

// kills: resource-class-prototype-key
test('prototype keys: authorization refuses a contained child typed with an inherited name exactly as a contained Basic or RelatedPerson child', () => {
  assert.equal(privacy.authorized(observation(), a, base), true, 'the parent alone is authorized');
  for (const control of ['Basic', 'RelatedPerson']) assert.equal(privacy.authorized(observation([child(control)]), a, base), false, control);
  for (const name of INHERITED) {
    // The inherited value's own string form carries the bound patient, as a crafted upstream body can.
    const crafted = child(name, inheritedKey(name));
    assert.equal(privacy.authorized(observation([crafted]), a, base), false, `contained ${name}: ${json(crafted)}`);
    assert.equal(privacy.authorized(observation([{ resourceType: 'Basic', id: 'ok' }, crafted]), a, base), false, `${name} after a sibling`);
    assert.equal(privacy.authorized(crafted as FhirResource, a, base), false, `root ${name}`);
  }
});

// ------------------------------------------------- end to end (SDK) -------

const SLOTS = ['synthetic-pk-1', 'synthetic-pk-2', 'synthetic-pk-3', 'synthetic-pk-4'];
const ok1 = lab('synthetic-pk-ok-1'), ok2 = lab('synthetic-pk-ok-2');
const VARIANTS = { inherited: ['__proto__', 'constructor', 'toString', 'hasOwnProperty'], control: ['Basic', 'RelatedPerson', 'Basic', 'RelatedPerson'] } as const;
const pagesFor = (types: readonly string[]): Rec[][] => {
  const records = SLOTS.map((id, i) => lab(id, { contained: [child(types[i]!, inheritedKey(types[i]!))] }));
  return [[ok1, records[0]!, records[1]!], [records[2]!, records[3]!, ok2]];
};
/** Drop only per-call identifiers, timings and the byte count they perturb; every decision field stays. */
const stable = (e: Rec): Rec => {
  const copy = structuredClone(e);
  delete copy.request_id;
  delete copy.budget?.elapsed_ms; delete copy.budget?.bytes_returned; delete copy.budget?.wire_bytes;
  for (const entry of copy.provenance ?? []) delete entry.retrieved_at;
  delete copy.pagination?.next_cursor;
  delete copy.result?.handle; delete copy.result?.expires_at;
  return copy;
};
const ids = (r: Rec) => ((r.e.data.resources ?? []) as Rec[]).map(resource => resource.id);

// kills: resource-class-prototype-key
test('prototype keys e2e: SDK read, search, page and retained results deny inherited-name contained children exactly as Basic or RelatedPerson children', async () => {
  for (const era of ['modern', 'legacy'] as const) {
    const outcomes: Record<string, Rec[]> = {};
    for (const [variant, types] of Object.entries(VARIANTS)) {
      outcomes[variant] = await withGateway({ pages: pagesFor(types) }, (gateway, requests) => withSdk(gateway, era, async sdk => {
        const seen: Rec[] = [];
        const clean = (r: Rec, label: string) => {
          assert.ok(!r.raw.includes(CANARY), `${era} ${variant} ${label}: wire`);
          assert.ok(!json(r.e).includes(CANARY), `${era} ${variant} ${label}: envelope`);
          seen.push({ label, envelope: stable(r.e) });
        };
        for (const id of SLOTS) {
          const read = await sdk.call('fhir_read', { resource_type: 'Observation', id, output });
          assert.equal(read.e.error?.code, 'NOT_FOUND', `${era} ${variant} read ${id}`);
          clean(read, `read ${id}`);
        }
        const control = await sdk.call('fhir_read', { resource_type: 'Observation', id: ok1.id, output });
        assert.equal(control.e.error, undefined, `${era} ${variant}: an ordinary read still succeeds`);
        clean(control, 'read control');
        const search = await sdk.call('fhir_search', { resource_type: 'Observation', page_size: 20, output });
        assert.equal(search.e.error, undefined);
        assert.deepEqual(ids(search), [ok1.id], `${era} ${variant} search`);
        clean(search, 'search');
        const page = await sdk.call('fhir_page', { cursor: search.e.pagination.next_cursor, output });
        assert.equal(page.e.error, undefined);
        assert.deepEqual(ids(page), [ok2.id], `${era} ${variant} page`);
        clean(page, 'page');
        for (const [label, handle] of [['retained search', search.e.result?.handle], ['retained page', page.e.result?.handle]] as const) {
          assert.ok(handle, `${era} ${variant} ${label} handle`);
          for (const format of ['fhir', 'compact'] as const) clean(await sdk.call('fhir_result', { handle, action: 'project', output: { format, max_bytes: 24576 } }), `${label} ${format}`);
        }
        for (const id of SLOTS) assert.ok(requests.some(url => url.pathname.endsWith(`/Observation/${id}`)), `${era} ${variant}: ${id} was fetched`);
        return seen;
      }));
    }
    assert.deepEqual(outcomes.inherited, outcomes.control, `${era}: inherited-name children are handled exactly as Basic/RelatedPerson children`);
  }
});

// ------------------------------------------- projection field tree -------

// Same class, caller side: `projection()` builds its field-selection tree from caller field segments. On plain objects
// a segment such as `hasOwnProperty` or `toString` resolved to the inherited builtin, and the next segment (`call`)
// was written onto that builtin for the whole process, which broke every later tool call. The selection was also lost.
const BUILTINS = { hasOwnProperty: Object.prototype.hasOwnProperty, toString: Object.prototype.toString, valueOf: Object.prototype.valueOf, isPrototypeOf: Object.prototype.isPrototypeOf } as const;
const ownNames = () => Object.fromEntries(Object.entries(BUILTINS).map(([name, fn]) => [name, Object.getOwnPropertyNames(fn).sort()]));
const BUILTIN_NAMES = ownNames();
/** Undo any write a regressed tree made, so a failure stays local to its own test. */
const restoreBuiltins = () => { for (const fn of Object.values(BUILTINS)) for (const name of ['call', 'apply', 'bind', 'x']) if (Object.hasOwn(fn, name)) delete (fn as unknown as Rec)[name]; };
const assertBuiltinsUntouched = (label: string) => {
  assert.deepEqual(ownNames(), BUILTIN_NAMES, `${label}: builtin methods keep their own properties`);
  for (const fn of Object.values(BUILTINS)) assert.equal(typeof fn.call, 'function', label);
};
const builtinKeyed = (): FhirResource => ({ ...observation(), hasOwnProperty: { call: 'synthetic-own-1' }, toString: { call: 'synthetic-own-2', apply: 'synthetic-own-3' },
  code: { coding: [{ system: 'http://loinc.org', code: '4548-4' }], valueOf: { call: 'synthetic-own-4' }, isPrototypeOf: { bind: 'synthetic-own-5' } } } as unknown as FhirResource);

// kills: projection-field-tree-prototype-root, projection-field-tree-prototype-branch
test('prototype keys: projection selects own keys named after builtins and never writes onto the builtin', () => {
  try {
    const fields = ['hasOwnProperty.call', 'toString.call', 'toString.apply', 'code.valueOf.call', 'code.isPrototypeOf.bind'];
    const projected = privacy.projection(builtinKeyed(), 'fhir', fields);
    assertBuiltinsUntouched('root and nested builtin-named segments');
    assert.deepEqual(projected.unresolved, []);
    const resource = projected.resource as unknown as Rec;
    assert.deepEqual(resource.hasOwnProperty, { call: 'synthetic-own-1' });
    assert.deepEqual(resource.toString, { call: 'synthetic-own-2', apply: 'synthetic-own-3' });
    assert.deepEqual(resource.code, { valueOf: { call: 'synthetic-own-4' }, isPrototypeOf: { bind: 'synthetic-own-5' } });
    // Control: an ordinary selection on the same record is unchanged.
    assert.deepEqual((privacy.projection(builtinKeyed(), 'fhir', ['status']).resource as unknown as Rec).status, 'final');
    assertBuiltinsUntouched('control');
  } finally { restoreBuiltins(); }
});

/** A regressed tree breaks the SDK's own validation, so the call never settles; fail by name instead of hanging. */
const within = async <T>(promise: Promise<T>, label: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => { restoreBuiltins(); reject(new Error(`${label}: no response within 5 s`)); }, 5_000); });
  try { return await Promise.race([promise, late]); } finally { clearTimeout(timer); }
};

// kills: projection-field-tree-prototype-root
test('prototype keys e2e: an SDK field selection naming builtins is delivered and later calls still work', { timeout: 60_000 }, async () => {
  const record = lab('synthetic-pk-fields', { hasOwnProperty: { call: 'synthetic-own-1' }, toString: { call: 'synthetic-own-2' } });
  try {
    for (const era of ['modern', 'legacy'] as const) {
      await withGateway({ pages: [[record]] }, gateway => withSdk(gateway, era, async sdk => {
        const selected = await within(sdk.call('fhir_read', { resource_type: 'Observation', id: record.id, output: { ...output, fields: ['hasOwnProperty.call', 'toString.call'] } }), `${era} selection`);
        assert.equal(selected.e.error, undefined, `${era}: the selection succeeds`);
        assertBuiltinsUntouched(`${era} after the selection`);
        const resource = (selected.e.data.resources ?? [selected.e.data.resource]).find(Boolean) as Rec;
        assert.deepEqual(resource.hasOwnProperty, { call: 'synthetic-own-1' }, `${era}: hasOwnProperty selected`);
        assert.deepEqual(resource.toString, { call: 'synthetic-own-2' }, `${era}: toString selected`);
        const read = await within(sdk.call('fhir_read', { resource_type: 'Observation', id: record.id, output }), `${era} later read`);
        assert.equal(read.e.error, undefined, `${era}: a later read still succeeds`);
        const capabilities = await within(sdk.call('fhir_capabilities', { topic: 'server', output }), `${era} later capabilities`);
        assert.equal(capabilities.e.error, undefined, `${era}: a later capabilities call still succeeds`);
      }));
    }
  } finally { restoreBuiltins(); }
});
