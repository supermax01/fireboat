/**
 * The record judge behind honest coverage and narrow redaction.
 *
 * `authorizeRecord()` returns `deliver` (optionally with whole-node redactions of unverifiable clinical-actor references),
 * `own_withheld` (the bound patient's own record withheld for a reason that does not depend on another patient's data, so
 * coverage must become partial) or `silent`. All fixtures are hand-written synthetic shapes.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FhirResource, GatewayConfig } from '../packages/core/src/contracts.js';
import { authorized, authorizeRecord, judgeRecord, sanitizeForDelivery, verifyRedactionPlan } from '../packages/core/src/privacy.js';

const A = 'synthetic-patient-a', B = 'synthetic-patient-b';
const base = new URL('http://127.0.0.1:4321/fhir/');
const MRN = 'urn:synthetic:judge:mrn';
const privacy: GatewayConfig['privacy'] = { patientIdentifierSystems: [MRN] };
const SENT_DISPLAY = 'SYNTHETIC_ACTOR_DISPLAY_SENTINEL', SENT_VALUE = 'SYNTHETIC_ACTOR_VALUE_SENTINEL', SENT_SYSTEM = 'urn:synthetic:judge:sentinel-system';
const SENT_QUERY = 'SYNTHETIC_QUERY_SENTINEL';

const actor = (extra: Record<string, unknown> = {}) => ({ identifier: { system: SENT_SYSTEM, value: SENT_VALUE }, display: SENT_DISPLAY, ...extra });
const code = { coding: [{ system: 'http://loinc.org', code: '4548-4' }] };
const obs = (extra: Record<string, unknown> = {}, subject = A): FhirResource => ({ resourceType: 'Observation', id: 'o1', status: 'final', code, subject: { reference: `Patient/${subject}` }, ...extra });
const doc = (extra: Record<string, unknown> = {}): FhirResource => ({ resourceType: 'DocumentReference', id: 'd1', status: 'current', subject: { reference: `Patient/${A}` },
  content: [{ attachment: { contentType: 'text/plain', title: 'Synthetic note' } }], ...extra });
const medRequest = (extra: Record<string, unknown> = {}): FhirResource => ({ resourceType: 'MedicationRequest', id: 'm1', status: 'active', intent: 'order',
  medicationCodeableConcept: { coding: [{ system: 'urn:synthetic:drug', code: 'd1' }] }, subject: { reference: `Patient/${A}` }, ...extra });
const deep = (levels: number): Record<string, unknown> => levels === 0 ? { url: 'urn:synthetic:leaf', valueString: 'leaf' } : { url: 'urn:synthetic:nest', extension: [deep(levels - 1)] };

const kind = (resource: FhirResource, config = privacy) => authorizeRecord(resource, A, base, config).kind;
const plan = (resource: FhirResource, config = privacy) => {
  const decision = authorizeRecord(resource, A, base, config);
  return decision.kind === 'deliver' ? [...decision.withhold] : undefined;
};

interface Vector { label: string; resource: FhirResource; kind: 'deliver' | 'own_withheld' | 'silent'; withhold?: string[] }
const VECTORS: Vector[] = [
  { label: 'identifier-only DocumentReference.author', resource: doc({ author: [actor()] }), kind: 'deliver', withhold: ['/author/0'] },
  { label: 'urn:uuid requester', resource: medRequest({ requester: { reference: 'urn:uuid:7d8a0d4e-0b6c-4c5f-9f1e-1c2b3a4d5e6f', display: SENT_DISPLAY } }), kind: 'deliver', withhold: ['/requester'] },
  { label: 'conditional Practitioner requester', resource: medRequest({ requester: { reference: `Practitioner?identifier=${SENT_SYSTEM}|${SENT_QUERY}`, display: SENT_DISPLAY } }), kind: 'deliver', withhold: ['/requester'] },
  { label: 'performer Patient/<other>', resource: obs({ performer: [{ reference: `Patient/${B}` }] }), kind: 'silent' },
  { label: 'performer declared Patient type with identifier', resource: obs({ performer: [{ type: 'Patient', identifier: { system: SENT_SYSTEM, value: SENT_VALUE } }] }), kind: 'silent' },
  { label: 'identifier-only performer in a configured patient system (F5)', resource: obs({ performer: [{ identifier: { system: MRN, value: SENT_VALUE } }] }), kind: 'silent' },
  { label: 'identifier-only performer typed as an MRN (F5)', resource: obs({ performer: [{ identifier: { type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'MR' }] }, system: SENT_SYSTEM, value: SENT_VALUE } }] }), kind: 'silent' },
  { label: 'contained Basic', resource: obs({ contained: [{ resourceType: 'Basic', id: 'b1', code }] }), kind: 'own_withheld' },
  { label: 'contained Patient with the bound id (F3)', resource: obs({ contained: [{ resourceType: 'Patient', id: A }] }), kind: 'silent' },
  { label: 'contained Observation with another subject (F4)', resource: obs({ contained: [obs({ id: 'c1' }, B)] }), kind: 'silent' },
  { label: 'contained ServiceRequest with identifier-only subject', resource: obs({ contained: [{ resourceType: 'ServiceRequest', id: 's1', status: 'active', intent: 'order', subject: actor() }] }), kind: 'own_withheld' },
  { label: 'contained ServiceRequest with identifier-only requester', resource: obs({ contained: [{ resourceType: 'ServiceRequest', id: 's1', status: 'active', intent: 'order', subject: { reference: `Patient/${A}` }, requester: actor() }] }), kind: 'deliver', withhold: ['/contained/0/requester'] },
  { label: 'unbound (identifier-only) root subject', resource: obs({ subject: actor() }), kind: 'silent' },
  { label: 'unbound root subject plus a contained Basic (W1-R6)', resource: obs({ subject: actor(), contained: [{ resourceType: 'Basic', id: 'b1', code }] }), kind: 'silent' },
  { label: 'root subject Patient/<other> plus a contained Basic', resource: obs({ contained: [{ resourceType: 'Basic', id: 'b1', code }] }, B), kind: 'silent' },
  { label: 'loose urn reference on a CodeableConcept', resource: obs({ code: { ...code, reference: 'urn:uuid:7d8a0d4e-0b6c-4c5f-9f1e-1c2b3a4d5e6f' } }), kind: 'own_withheld' },
  { label: 'unsupported non-patient-like string on a Patient-capable element', resource: obs({ performer: [{ reference: 'not a reference!' }] }), kind: 'own_withheld' },
  { label: 'non-string reference member', resource: obs({ performer: [{ reference: 42 }] }), kind: 'own_withheld' },
  { label: 'depth beyond 64', resource: obs({ extension: [deep(70)] }), kind: 'own_withheld' },
  { label: 'identifier-only DocumentReference.context.sourcePatientInfo (Patient-only, W1-R2)', resource: doc({ context: { sourcePatientInfo: actor() } }), kind: 'own_withheld' },
  { label: 'identifier-only Coverage.subscriber (person of record, W1-R2)', resource: { resourceType: 'Coverage', id: 'cv1', status: 'active', beneficiary: { reference: `Patient/${A}` }, payor: [{ reference: 'Organization/o1' }], subscriber: actor(), subscriberId: 'SYNTHETIC-MEMBER', relationship: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/subscriber-relationship', code: 'spouse' }] } }, kind: 'own_withheld' },
  { label: 'identifier-only Extension.valueReference (no declared targets, W1-R2)', resource: obs({ extension: [{ url: 'urn:synthetic:ext', valueReference: actor() }] }), kind: 'own_withheld' },
  { label: 'identifier-only Claim.payee.party (payee slot, W1-R2)', resource: { resourceType: 'Claim', id: 'cl1', status: 'active', patient: { reference: `Patient/${A}` }, payee: { type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/payeetype', code: 'other' }] }, party: actor() } }, kind: 'own_withheld' },
  { label: 'conditional reference whose query mentions a patient (W1-R8)', resource: obs({ performer: [{ reference: `Practitioner?patient=Patient/${B}` }] }), kind: 'silent' },
  { label: 'Patient/<bound> with a conflicting declared type (W1-R4)', resource: obs({ performer: [{ reference: `Patient/${A}`, type: 'Practitioner' }] }), kind: 'silent' },
  { label: 'cross-origin absolute Patient/<bound> (W1-R4)', resource: obs({ performer: [{ reference: `http://other.invalid/fhir/Patient/${A}` }] }), kind: 'silent' },
  { label: 'strict-path control', resource: obs({ performer: [{ reference: 'Practitioner/p1', display: 'Synthetic clinician' }] }), kind: 'deliver', withhold: [] },
];

test('wave 1 judge matrix: deliver with whole-node redactions, own_withheld or silent', () => {
  for (const vector of VECTORS) {
    assert.equal(kind(vector.resource), vector.kind, vector.label);
    if (vector.withhold) assert.deepEqual(plan(vector.resource), vector.withhold, vector.label);
  }
});

test('wave 1 judge: Patient roots, shared roots and an unconfigured identifier system', () => {
  assert.equal(kind({ resourceType: 'Patient', id: A, contained: [{ resourceType: 'Basic', id: 'b1', code }] }), 'own_withheld', 'bound Patient root with a defect');
  assert.equal(kind({ resourceType: 'Patient', id: B, contained: [{ resourceType: 'Basic', id: 'b1', code }] }), 'silent', 'another Patient root');
  // A shared root withheld by the shared-instance policy is signalled; one withheld because it carries another patient's
  // evidence stays silent.
  assert.equal(kind({ resourceType: 'Medication', id: 'med1', identifier: [{ system: 'urn:synthetic:ndc', value: '1' }] }), 'shared_withheld', 'shared policy failure signals');
  assert.equal(kind({ resourceType: 'Medication', id: 'med1', contained: [{ resourceType: 'Patient', id: B }] }), 'silent', 'contained Patient stays silent');
  // Without the configured MRN system, an identifier-only performer is an unverifiable clinical actor: redacted, not withheld silently.
  assert.deepEqual(plan(obs({ performer: [{ identifier: { system: MRN, value: SENT_VALUE } }] }), {}), ['/performer/0']);
});

// Invariant: replacing another patient's identity by the bound one never changes whether the signal fires.
const TWINS: { label: string; build: (id: string) => FhirResource }[] = [
  { label: 'flat foreign performer', build: id => obs({ performer: [{ reference: `Patient/${id}` }] }) },
  { label: 'flat foreign performer plus a contained Basic', build: id => obs({ performer: [{ reference: `Patient/${id}` }], contained: [{ resourceType: 'Basic', id: 'b1', code }] }) },
  { label: 'defect inside a foreign reference extension', build: id => obs({ performer: [{ reference: `Patient/${id}`, extension: [{ url: 'urn:synthetic:x', valueReference: { reference: 'not a ref!' } }] }] }) },
  { label: 'defect inside a contained resource with a foreign subject', build: id => obs({ contained: [obs({ id: 'c1', performer: [{ reference: 'Smith, Jane' }] }, id)] }) },
  { label: 'redactable node inside a contained resource with a foreign subject', build: id => obs({ contained: [{ resourceType: 'ServiceRequest', id: 's1', status: 'active', intent: 'order', subject: { reference: `Patient/${id}` }, requester: actor() }] }) },
  { label: 'budget overflow inside a foreign subtree', build: id => obs({ performer: [{ reference: `Patient/${id}`, extension: [deep(70)] }] }) },
  { label: 'conflicting declared type', build: id => obs({ performer: [{ reference: `Patient/${id}`, type: 'Practitioner' }], contained: [{ resourceType: 'Basic', id: 'b1', code }] }) },
  { label: 'cross-origin absolute', build: id => obs({ performer: [{ reference: `http://other.invalid/fhir/Patient/${id}` }], extension: [{ url: 'urn:synthetic:x', valueReference: { reference: 'not a ref!' } }] }) },
  { label: 'conditional Patient', build: id => obs({ performer: [{ reference: `Patient?identifier=${MRN}|${id}` }] }) },
  { label: 'foreign plus redactable', build: id => doc({ author: [actor(), { reference: `Patient/${id}` }] }) },
];

test('wave 1 invariant A1-B: twins that differ only in a non-primary patient identity agree on the own_withheld signal', () => {
  for (const twin of TWINS) {
    const bound = kind(twin.build(A)), foreign = kind(twin.build(B));
    assert.equal(bound === 'own_withheld', foreign === 'own_withheld', `${twin.label}: bound=${bound} foreign=${foreign}`);
    assert.notEqual(foreign, 'deliver', `${twin.label}: a record naming another patient is never delivered`);
  }
  // Positive controls that the nested vectors really reach a defect on the bound twin.
  assert.equal(kind(TWINS[2]!.build(A)), 'own_withheld');
  assert.equal(kind(TWINS[3]!.build(A)), 'own_withheld');
  assert.equal(kind(TWINS[5]!.build(A)), 'own_withheld');
  assert.equal(kind(TWINS[4]!.build(A)), 'deliver');
});

test('wave 1 strict invariant: every redacted delivery passes authorized(); a judge with no findings implies authorized()', () => {
  for (const vector of [...VECTORS.map(v => v.resource), ...TWINS.flatMap(t => [t.build(A), t.build(B)])]) {
    const decision = authorizeRecord(vector, A, base, privacy);
    if (decision.kind === 'deliver' && decision.withhold.length) {
      const delivery = sanitizeForDelivery(vector, A, base, privacy);
      assert.ok('sanitized' in delivery);
      assert.equal(authorized(delivery.sanitized.resource, A, base), true);
    }
    const judgement = judgeRecord(vector, A, base, privacy);
    if (judgement.primaryBound && !judgement.ownDefect && !judgement.foreignEvidence && !judgement.withholdReferences.length) assert.equal(authorized(vector, A, base), true);
  }
});

test('wave 1 redaction plan: forged, incomplete or non-redactable plans are refused on the raw record (W1-R5)', () => {
  const record = doc({ author: [actor(), actor({ display: 'second' })] });
  assert.equal(verifyRedactionPlan(record, ['/author/0', '/author/1'], A, base, privacy), true);
  assert.equal(verifyRedactionPlan(record, ['/author/0'], A, base, privacy), false, 'incomplete plan');
  assert.equal(verifyRedactionPlan(record, ['/status'], A, base, privacy), false, 'non-reference pointer');
  assert.equal(verifyRedactionPlan(record, ['/subject'], A, base, privacy), false, 'primary-link pointer');
  assert.equal(verifyRedactionPlan(record, ['/author/0', '/author/1', '/status'], A, base, privacy), false, 'plan with an extra pointer');
  assert.equal(verifyRedactionPlan(record, ['/author/0', '/author/1', '/content/0'], A, base, privacy), false, 'plan with an extra non-reference object');
  assert.equal(verifyRedactionPlan(record, [], A, base, privacy), false, 'empty plan');
});

test('wave 1 redaction output: the whole node is withheld with a label, and nothing of it is delivered', () => {
  const records = [
    doc({ author: [actor({ extension: [{ url: 'urn:synthetic:ext', valueString: SENT_DISPLAY }], _display: { extension: [{ url: 'urn:synthetic:ext', valueString: SENT_VALUE }] } })] }),
    medRequest({ requester: { reference: `Practitioner?identifier=${SENT_SYSTEM}|${SENT_QUERY}`, display: SENT_DISPLAY, identifier: { system: SENT_SYSTEM, value: SENT_VALUE } } }),
    medRequest({ requester: { reference: 'urn:uuid:7d8a0d4e-0b6c-4c5f-9f1e-1c2b3a4d5e6f', display: SENT_DISPLAY, identifier: { system: SENT_SYSTEM, value: SENT_VALUE } } }),
  ];
  for (const record of records) {
    const delivery = sanitizeForDelivery(record, A, base, privacy);
    assert.ok('sanitized' in delivery, record.resourceType);
    const text = JSON.stringify(delivery.sanitized);
    for (const sentinel of [SENT_DISPLAY, SENT_VALUE, SENT_SYSTEM, SENT_QUERY]) assert.ok(!text.includes(sentinel), `${record.resourceType}: ${sentinel} leaked`);
    assert.ok(delivery.sanitized.manifests.every(entry => entry.reason === 'UNVERIFIED_REFERENCE_WITHHELD'));
  }
  // Exact delivered shapes: a fully withheld array stays an empty array; a partly withheld array keeps the verifiable items.
  const all = sanitizeForDelivery(doc({ author: [actor()] }), A, base, privacy);
  assert.ok('sanitized' in all);
  assert.deepEqual(all.sanitized.resource.author, []);
  assert.deepEqual(all.sanitized.manifests, [{ path: '/author/0', reason: 'UNVERIFIED_REFERENCE_WITHHELD' }]);
  assert.deepEqual(all.sanitized.manifestOrigins, ['policy']);
  const mixed = sanitizeForDelivery(doc({ author: [actor(), { reference: 'Practitioner/p1', display: 'Synthetic clinician' }] }), A, base, privacy);
  assert.ok('sanitized' in mixed);
  assert.deepEqual(mixed.sanitized.resource.author, [{ reference: 'Practitioner/p1', display: 'Synthetic clinician' }]);
  const single = sanitizeForDelivery(medRequest({ requester: actor() }), A, base, privacy);
  assert.ok('sanitized' in single);
  assert.equal(Object.hasOwn(single.sanitized.resource, 'requester'), false);
  assert.deepEqual(single.sanitized.manifests, [{ path: '/requester', reason: 'UNVERIFIED_REFERENCE_WITHHELD' }]);
  // Records refused by the judge never reach sanitize.
  assert.deepEqual(sanitizeForDelivery(obs({ performer: [{ reference: `Patient/${B}` }] }), A, base, privacy), { refused: { kind: 'silent' } });
  assert.deepEqual(sanitizeForDelivery(obs({ contained: [{ resourceType: 'Basic', id: 'b1', code }] }), A, base, privacy), { refused: { kind: 'own_withheld' } });
});
