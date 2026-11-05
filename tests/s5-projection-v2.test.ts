import { SERVER_IDENTITY } from '../packages/core/src/identity.js';
// Internal S5.4 harness only. D07–D11 public drafts remain TODO until S5.7.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { FhirGateway } from '../packages/core/src/index.js';
import { validateCrossField02, validateDeliverable02, toMcpToolResult02, type GatewayEnvelope, type GatewayEnvelope02, type ToolName, type DeliveryContext, type ValidationContext02, type GatewayConfig } from '../packages/core/src/contracts.js';
import { evidenceRender } from '../packages/core/src/delivery.js';
import { authorized, sanitize, type Sanitized } from '../packages/core/src/privacy.js';
import { parseFhirJson, stringifyFhir, toWireValue, FhirPrecisionFault } from '../packages/core/src/decimal.js';
import { buildQueryEvidence } from '../packages/core/src/query.js';
import type { QueryEvidence, QueryOverlay, SanitizedProjectionRecord } from '../packages/core/src/m3b.js';
import type { ResultStore } from '../packages/core/src/store.js';

type Rec = Record<string, any>;
type State = { records: Sanitized[]; type: string; offset: number; query: { name: string; value: string }[]; suppressed: boolean;
  expiresAt?: number; queryEvidence?: QueryEvidence; queryOverlay?: QueryOverlay; nextUrl?: string; nonContinuable?: boolean; sourceIncomplete?: boolean };
interface Core {
  admitV2(tool: ToolName, input: unknown): any;
  renderV2(s: State, admission: any, tool: ToolName, delivery?: DeliveryContext, previous?: QueryEvidence): GatewayEnvelope02;
  resultV2(admission: any, delivery?: DeliveryContext): GatewayEnvelope02;
  projectionRecordV2(s: Sanitized): SanitizedProjectionRecord;
  store: ResultStore<State>;
  capabilityRevision: string; fhirVersion: string;
}
const corpus = JSON.parse(readFileSync(new URL('./fixtures/s5-projection-v2.json', import.meta.url), 'utf8')) as Rec;
const identity = SERVER_IDENTITY;
const config = { mode: 'synthetic' as const, source: { alias: 'local', baseUrl: 'http://127.0.0.1:9/fhir' }, patientId: 'synthetic-a', contextId: 'ctx_s54' };
const binding = { sourceAlias: 'local', fhirVersion: '4.0.1', sourceRevision: 'cap-s54', policyRevision: 'synthetic-v2', contextHandle: 'ctx_s54' };
const pairs = [{ name: 'subject', value: 'Patient/synthetic-a' }];
const at = (value: unknown, path: string): unknown => path.split('.').reduce<unknown>((node, key) => node && typeof node === 'object' ? (node as Rec)[key] : undefined, value);
function raw(id = 's54-lab'): Rec {
  return parseFhirJson(`{"resourceType":"Observation","id":"${id}","meta":{"versionId":"7","_versionId":{"id":"version-companion"},"profile":["http://example.test/lab"],"security":[{"code":"N"}],"tag":[{"code":"SUBSETTED"}],"lastUpdated":"2025-01-01T00:00:00Z"},"status":"corrected","_status":{"id":"status-companion"},"subject":{"reference":"Patient/synthetic-a"},"identifier":[{"value":"synthetic-accession"}],"text":{"status":"generated","div":"<div>synthetic narrative</div>"},"code":{"coding":[{"system":"http://loinc.org","version":"2.78","code":"4548-4","display":"A1c","userSelected":true}],"text":"A1c"},"valueQuantity":{"value":7.0,"comparator":">=","unit":"%","system":"http://unitsofmeasure.org","code":"%"},"effectiveDateTime":"2025-02-10T08:00:00+10:30","_effectiveDateTime":{"id":"time-companion"},"interpretation":[{"coding":[{"code":"H"}]}],"referenceRange":[{"high":{"value":5.60,"system":"http://unitsofmeasure.org","code":"%"},"text":"Synthetic range"}],"component":[{"code":{"coding":[{"system":"http://loinc.org","version":"2.78","code":"8480-6"}]},"valueQuantity":{"value":120.00,"comparator":"<","system":"http://unitsofmeasure.org","code":"mm[Hg]"},"referenceRange":[{"low":{"value":-0.0}}]}],"specimen":{"reference":"Specimen/synthetic-specimen"},"contained":[{"resourceType":"Observation","id":"sp1","status":"preliminary","code":{"text":"Synthetic contained dependency"},"subject":{"reference":"Patient/synthetic-a"}}],"device":{"reference":"Device/synthetic-device"},"derivedFrom":[{"reference":"#sp1"}],"note":[{"text":"synthetic note"}]}`) as Rec;
}
function record(id = 's54-lab', i = 0, change: Rec = {}): Sanitized {
  const source = { ...raw(id), ...change };
  for (const key of Object.keys(source)) if (source[key] === undefined) delete source[key];
  assert.equal(authorized(source as never, config.patientId, new URL(config.source.baseUrl + '/')), true, 'candidate fixture is authorized before sanitization');
  const r = sanitize(source as never);
  r.retrievedAt = corpus.retrievalTimes[i % 3]; return r;
}
function state(records = [record()], query = true, count = 100): State {
  const e = buildQueryEvidence({ resourceType: 'Observation', pairs, gatewayEnforcedIndices: new Set([0]),
    sourceRevision: binding.sourceRevision, policyRevision: binding.policyRevision, contextHandle: binding.contextHandle });
  return { records, type: 'Observation', offset: 0, query: query ? [...pairs, { name: '_count', value: String(count) }] : [], suppressed: false,
    ...(query ? { queryEvidence: e, queryOverlay: { deliveredCount: 0, pagesObserved: 1, queryEvidence: { ...e, constraints: [] }, sortProof: 'none' as const,
      constraintProof: e.constraints.map(({ execution, source_reported }) => ({ execution, source_reported })) } } : {}) };
}
function setup(limits?: GatewayConfig['limits']) {
  const g = new FhirGateway({ ...config, limits }), c = g as unknown as Core;
  c.capabilityRevision = binding.sourceRevision; c.fhirVersion = binding.fhirVersion;
  return { g, c };
}
function freeze<T>(v: T): T {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) { Object.values(v).forEach(freeze); Object.freeze(v); }
  return v;
}
function capture(e: GatewayEnvelope02, delivery: DeliveryContext, tool: ToolName = 'fhir_result') {
  const result = toMcpToolResult02(e);
  if (delivery.profile === 'structured-evidence-v1') result.content[0]!.text = evidenceRender(e as unknown as GatewayEnvelope, tool).text;
  return { ...result, ...(delivery.era === 'modern' ? { resultType: 'complete' as const, _meta: { 'io.modelcontextprotocol/serverInfo': identity } } : {}) };
}
function check(tool: ToolName, e: GatewayEnvelope02, s: State, args: Rec, delivery: DeliveryContext = { era: 'modern', profile: 'full-text-v1' }) {
  // Invocation, query, binding, format, selection and limits are trusted fixtures,
  // never reconstructed from candidate response coverage or data.
  const result = capture(e, delivery, tool);
  const context = freeze({ era: delivery.era, deliveryProfile: delivery.profile, renderedText: result.content[0]!.text, result, serverIdentity: identity,
    binding: { ...binding }, patientId: config.patientId, effectiveByteLimit: args.output?.max_bytes ?? 24576,
    formatSupplied: args.output?.format !== undefined, requestedFormat: args.output?.format,
    requestedPageSize: Number(s.query.at(-1)?.value),
    selectedFields: args.fields ?? args.output?.fields,
    ...(tool === 'fhir_read' ? { readTarget: { resourceType: 'Observation', id: args.id } } : {}),
    ...(tool === 'fhir_result' ? { action: args.action ?? 'inspect', offset: args.offset ?? 0, limit: args.limit ?? 20 } : {}),
    ...(s.queryEvidence && tool !== 'fhir_read' ? { query: { resourceType: s.type, sourceRevision: binding.sourceRevision, policyRevision: binding.policyRevision,
      contextHandle: binding.contextHandle, orderedPairs: s.query.filter(p => p.name !== '_count'), sort: [], constraintProof: s.queryEvidence.constraints.map(p => ({ execution: p.execution })),
      fullEvidenceRequired: tool !== 'fhir_page' }, chainDeliveredCount: s.queryOverlay?.deliveredCount ?? 0 } : {}) }) as ValidationContext02;
  assert.deepEqual(validateCrossField02(tool, toWireValue(e), context), { ok: true }, `candidate ${tool} passes semantic gate`);
  assert.deepEqual(validateDeliverable02(tool, toWireValue(e), context), { ok: true });
  assert.equal(Buffer.byteLength(JSON.stringify(result)), e.budget.bytes_returned, 'exact complete SDK-result bytes');
  assert.ok(e.budget.bytes_returned <= (args.output?.max_bytes ?? 24576));
  return context;
}
const formats = [undefined, 'fhir', 'compact', 'selected', 'compact-selected'] as const;
function output(format: typeof formats[number], max_bytes = 24576) {
  return { ...(format ? { format: format.startsWith('compact') ? 'compact' : 'fhir' } : {}), max_bytes,
    ...(format?.includes('selected') ? { fields: corpus.selectedFields } : {}) };
}
for (const era of ['modern', 'legacy'] as const) for (const profile of ['full-text-v1', 'structured-evidence-v1'] as const) {
  const delivery = { era, profile };
  for (const tool of ['fhir_read', 'fhir_search', 'fhir_page', 'fhir_result'] as const) for (const format of formats) {
    test(`D${String({ fhir_read: 7, fhir_search: 8, fhir_page: 9, fhir_result: 10 }[tool]).padStart(2, '0')} internal critical tuples ${tool} ${format ?? 'default'} ${era} ${profile}`, () => {
      const { g, c } = setup();
      try {
        const s = state([record()], tool !== 'fhir_read');
        const args: Rec = { output: output(format), ...(tool === 'fhir_read' ? { resource_type: 'Observation', id: 's54-lab' } : tool === 'fhir_search' ? { resource_type: 'Observation' } : tool === 'fhir_page' ? { cursor: 'cur_test' } : { handle: 'res_test', action: 'project' }) };
        let e: GatewayEnvelope02;
        if (tool === 'fhir_result') {
          args.handle = c.store.put('res', s).handle; e = c.resultV2(c.admitV2(tool, args), delivery);
        } else e = c.renderV2(s, c.admitV2(tool, args), tool, delivery);
        check(tool, e, s, args, delivery);
        const resource = (e.data as Rec).resources[0];
        for (const path of corpus.criticalPaths) assert.equal(stringifyFhir(at(resource, path)), stringifyFhir(at(s.records[0]!.resource, path)), `${path} survives ${tool}/${format}`);
        for (const lexeme of ['"value":7.0', '"value":120.00', '"value":5.60', '"value":-0.0']) assert.ok(stringifyFhir(resource).includes(lexeme));
        assert.deepEqual(e.provenance, [{ resource_index: 0, retrieved_at: corpus.retrievalTimes[0] }]);
      } finally { g.close(); }
    });
  }
  for (const tool of ['fhir_read', 'fhir_search', 'fhir_page', 'fhir_result'] as const) test(`D11 internal structural ${tool} ${era} ${profile}`, () => {
    const { g, c } = setup();
    try {
      const r = record('structural', 0, { modifierExtension: [{ url: 'http://example.test/negation', valueBoolean: true }] });
      const s = state([r], tool !== 'fhir_read'), args: Rec = { output: output('compact'), ...(tool === 'fhir_read' ? { resource_type: 'Observation', id: 'structural' } : tool === 'fhir_search' ? { resource_type: 'Observation' } : tool === 'fhir_page' ? { cursor: 'cur_test' } : { handle: c.store.put('res', s).handle, action: 'page' }) };
      const e = tool === 'fhir_result' ? c.resultV2(c.admitV2(tool, args), delivery) : c.renderV2(s, c.admitV2(tool, args), tool, delivery);
      check(tool, e, s, args, delivery);
      assert.equal(stringifyFhir((e.data as Rec).resources[0]), stringifyFhir(r.resource));
      assert.deepEqual(e.transform.structural_resource_indices, [0]); assert.deepEqual(e.transform.recipe_ids, []);
      assert.ok(e.warnings.some(w => w.code === 'UNINTERPRETED_MODIFIER'));
      if (profile === 'structured-evidence-v1') assert.ok(!capture(e, delivery).content[0]!.text.includes('lab_evidence:'), 'no lab interpretation');
    } finally { g.close(); }
  });
}

test('neutral adaptation preserves references/time/flag, and discloses only unique safe withheld reasons', () => {
  const { g, c } = setup();
  try {
    const base = new URL(config.source.baseUrl + '/');
    assert.equal(authorized(raw() as never, config.patientId, base), true, 'authorized contained dependency control');
    for (const contained of [[{ resourceType: 'UnknownSyntheticType', id: 'unknown' }], [{ resourceType: 'Patient', id: 'synthetic-a' }],
      [{ resourceType: 'Specimen', id: 'foreign', subject: { reference: 'Patient/synthetic-other' } }]]) {
      assert.equal(authorized({ ...raw(), contained } as never, config.patientId, base), false, 'contained policy boundary stays denied');
    }
    const r = record(); r.manifests = [{ path: '/x', reason: 'PROTECTED_LINK' }, { path: '/y', reason: 'PROTECTED_LINK' }, { path: '/z', reason: 'unsafe prose http://example.test/secret' }];
    r.requiresStructuralView = true;
    const n = c.projectionRecordV2(r);
    assert.equal(n.resource, r.resource); assert.equal(n.policyOmitted, r.omitted); assert.equal(n.retrievedAt, r.retrievedAt);
    assert.equal(n.requiresStructuralView, true); assert.deepEqual(n.withheldReasons, ['PROTECTED_LINK']);
  } finally { g.close(); }
});

test('exclusions reindex delivered provenance, structural indices and omission unions in delivery order', () => {
  const { g, c } = setup();
  try {
    const bad = record('bad/id', 0, { modifierExtension: [{ url: 'http://example.test/negation', valueBoolean: true }], text: undefined });
    const precision = record('precision', 1); precision.resource.valueQuantity = { value: new FhirPrecisionFault() };
    precision.omitted.push('/onlyPrecision');
    const good = record('good', 2, { modifierExtension: [{ url: 'http://example.test/negation', valueBoolean: true }] });
    const missing = record('missing', 0); delete missing.resource.id; delete (missing.resource.meta as Rec).versionId;
    const s = state([bad, precision, good, missing]), args = { resource_type: 'Observation', output: output('compact') };
    const e = c.renderV2(s, c.admitV2('fhir_search', args), 'fhir_search'); check('fhir_search', e, s, args);
    assert.deepEqual((e.data as Rec).resources.map((r: Rec) => r.id), ['good', undefined]);
    assert.deepEqual(e.provenance, [{ resource_index: 0, retrieved_at: corpus.retrievalTimes[2] }, { resource_index: 1, retrieved_at: corpus.retrievalTimes[0] }]);
    assert.deepEqual(e.transform.structural_resource_indices, [0]); assert.ok(!e.transform.omitted_fields.includes('/onlyPrecision'));
    assert.ok(e.coverage.reasons.includes('UNSUPPORTED_PRECISION')); assert.ok(e.coverage.reasons.includes('INVALID_RESOURCE_ID'));
    assert.equal(at((e.data as Rec).resources[1], 'meta.versionId'), undefined);
    assert.deepEqual(e.transform.recipe_ids, ['r4-lab-evidence-v1/Observation.2']);
  } finally { g.close(); }
});

test('oversized read is never complete, retains recovery, and omits all excluded-record metadata', () => {
  const { g, c } = setup();
  try {
    const r = record('huge', 1, { valueString: 'x'.repeat(40000), modifierExtension: [{ url: 'http://example.test/negation', valueBoolean: true }] });
    const s = state([r], false), args = { resource_type: 'Observation', id: 'huge', output: output('fhir', 4096) };
    const e = c.renderV2(s, c.admitV2('fhir_read', args), 'fhir_read'); check('fhir_read', e, s, args);
    assert.equal(e.coverage.state, 'partial'); assert.equal(e.coverage.query_exhausted, null);
    assert.ok(e.coverage.reasons.includes('OVERSIZED_RESOURCE')); assert.equal(e.pagination!.has_more, false);
    assert.deepEqual(e.provenance, []); assert.deepEqual(e.transform.withheld_payloads, []); assert.deepEqual(e.transform.omitted_fields, []);
    assert.deepEqual(e.transform.recipe_ids, []); assert.deepEqual(e.transform.structural_resource_indices, []); assert.equal(e.transform.narrative_omitted, false);
    assert.ok(!e.warnings.some(w => w.code === 'UNINTERPRETED_MODIFIER')); assert.ok(e.result);
    const recover = { handle: e.result!.handle, action: 'project', fields: ['status'], output: output('fhir', 8192) };
    const stillStructural = c.resultV2(c.admitV2('fhir_result', recover)); check('fhir_result', stillStructural, s, recover);
    assert.deepEqual((stillStructural.data as Rec).resources, []);
    assert.doesNotMatch((stillStructural.data as Rec).manifest.action, /field selection|with project/);
    recover.output.max_bytes = Number((stillStructural.data as Rec).manifest.action.match(/max_bytes of (\d+)/)[1]);
    const projected = c.resultV2(c.admitV2('fhir_result', recover)); check('fhir_result', projected, s, recover);
    assert.equal(at((projected.data as Rec).resources[0], 'meta.versionId'), '7');
  } finally { g.close(); }
});

test('removing last packed record rolls back its manifests, narrative, warnings, recipes and structural indices', () => {
  const { g, c } = setup();
  try {
    const small = record('small', 0, { text: undefined, note: undefined, meta: undefined });
    const large = record('large', 1, { valueString: 'x'.repeat(14000), modifierExtension: [{ url: 'http://example.test/negation', valueBoolean: true }], presentedForm: [{ data: 'synthetic-payload' }] });
    large.omitted.push('/onlyLarge');
    const s = state([small, large]), args = { resource_type: 'Observation', output: output('compact', 10000) };
    const e = c.renderV2(s, c.admitV2('fhir_search', args), 'fhir_search'); check('fhir_search', e, s, args);
    assert.deepEqual((e.data as Rec).resources.map((r: Rec) => r.id), ['small']);
    assert.deepEqual(e.provenance, [{ resource_index: 0, retrieved_at: corpus.retrievalTimes[0] }]);
    assert.deepEqual(e.transform.structural_resource_indices, []); assert.equal(e.transform.narrative_omitted, false);
    assert.ok(!e.transform.omitted_fields.includes('/onlyLarge')); assert.deepEqual(e.transform.withheld_payloads, []);
    assert.ok(!e.warnings.some(w => w.code === 'UNINTERPRETED_MODIFIER')); assert.deepEqual(e.transform.recipe_ids, ['r4-lab-evidence-v1/Observation.2']);
    const stored = c.store.get(e.pagination!.next_cursor!).value;
    assert.equal(stored.offset, 1);
    const nextArgs = { cursor: e.pagination!.next_cursor!, output: output('fhir', 10000) };
    const page = c.renderV2(stored, c.admitV2('fhir_page', nextArgs), 'fhir_page'); check('fhir_page', page, stored, nextArgs);
    assert.deepEqual(page.provenance, []); assert.deepEqual(page.transform.recipe_ids, []);
  } finally { g.close(); }
});

test('retention failure preserves inline per-record manifests and exact omissions without collapse', () => {
  const { g, c } = setup({ retentionBytes: 256 });
  try {
    const r = record('payload', 0, { presentedForm: [{ data: 'one' }, { data: 'two' }] });
    const s = state([r], false), args = { resource_type: 'Observation', id: 'payload', output: output('compact') };
    const e = c.renderV2(s, c.admitV2('fhir_read', args), 'fhir_read'); check('fhir_read', e, s, args);
    assert.equal(e.result, undefined); assert.ok(e.warnings.some(w => w.code === 'RESULT_NOT_RETAINED'));
    assert.deepEqual(e.transform.withheld_payloads, r.manifests); assert.equal(e.transform.withheld_payloads.length, 2);
    assert.ok(e.transform.withheld_payloads.every(m => m.count === undefined));
    for (const path of r.omitted) assert.ok(e.transform.omitted_fields.includes(path));
  } finally { g.close(); }
});

for (const action of ['inspect', 'project', 'page']) test(`retained ${action} nonzero slice offset, missing version, no refetch or TTL renewal`, () => {
  const { g, c } = setup();
  try {
    const records = Array.from({ length: 6 }, (_, i) => record(`slice-${i}`, i)); delete (records[3]!.resource.meta as Rec).versionId;
    const s = state(records), expiry = Date.now() + 120000;
    const stored = c.store.put('res', s, expiry, { sliceStart: 2, sliceEnd: 5 } as never);
    const args = { handle: stored.handle, action, offset: 1, limit: 1, output: output('compact') }, before = stringifyFhir(c.store.get(stored.handle));
    const e = c.resultV2(c.admitV2('fhir_result', args)); check('fhir_result', e, s, args);
    assert.equal(e.result!.expires_at, new Date(expiry).toISOString()); assert.equal(c.store.size, 1);
    assert.equal(stringifyFhir(c.store.get(stored.handle)), before, 'inspection/reprojection is read-only');
    if (action === 'inspect') {
      const d = e.data as Rec; assert.equal(d.resource_count, 3); assert.equal(d.next_offset, 2);
      assert.equal(d.omissions[0].id, 'slice-3'); assert.equal(d.omissions[0].resource_index, 0); assert.equal(d.omissions[0].version, undefined);
      assert.ok(Object.keys(d.omissions[0]).every(k => corpus.omissionOnlyKeys.includes(k)));
      assert.deepEqual(e.transform.withheld_payloads, []); assert.equal(e.provenance, undefined);
      assert.ok(!stringifyFhir(d).includes('valueQuantity')); assert.equal(d.resources, undefined);
    } else {
      assert.equal((e.data as Rec).resources[0].id, 'slice-3'); assert.equal((e.data as Rec).next_offset, 2);
      assert.deepEqual(e.provenance, [{ resource_index: 0, retrieved_at: corpus.retrievalTimes[0] }]);
    }
  } finally { g.close(); }
});

for (const era of ['modern', 'legacy'] as const) for (const profile of ['full-text-v1', 'structured-evidence-v1'] as const) test(`inspection whole-result cap ${era} ${profile}`, () => {
  const { g, c } = setup();
  try {
    const records = Array.from({ length: 30 }, (_, i) => { const r = record(`inspect-${i}`, i); r.omitted.push(...Array.from({ length: 8 }, (_, j) => `/synthetic${j}`)); return r; });
    const s = state(records), handle = c.store.put('res', s).handle, args = { handle, action: 'inspect', limit: 30, output: output('compact', 4096) };
    const e = c.resultV2(c.admitV2('fhir_result', args), { era, profile }); check('fhir_result', e, s, args, { era, profile });
    const d = e.data as Rec; assert.ok(d.omissions.length > 0 && d.omissions.length < 30); assert.equal(d.next_offset, d.omissions.length);
    assert.deepEqual(d.omissions.map((r: Rec) => r.resource_index), d.omissions.map((_: unknown, i: number) => i));
    assert.equal(c.store.size, 1); assert.equal(e.budget.limit_reached, true);
  } finally { g.close(); }
});

test('inspection no-progress cap refuses, expiry and wrong-kind handles stay unavailable', () => {
  const { g, c } = setup();
  try {
    const r = record(); r.omitted.push(...Array.from({ length: 100 }, (_, j) => `/synthetic${j}${'x'.repeat(80)}`));
    const s = state([r]), h = c.store.put('res', s).handle;
    assert.throws(() => c.resultV2(c.admitV2('fhir_result', { handle: h, output: output('compact', 4096) })), /Inspection cannot fit/);
    const cur = c.store.put('cur', s).handle;
    assert.throws(() => c.resultV2(c.admitV2('fhir_result', { handle: cur })), /unavailable or expired/);
    c.store.release(h); assert.throws(() => c.resultV2(c.admitV2('fhir_result', { handle: h })), /unavailable or expired/);
  } finally { g.close(); }
});

test('real sanitized text-link spans manifest passes unchanged; gate rejects other reasons, malformed counts and unknown keys', () => {
  const { g, c } = setup();
  try {
    const r = record('spans', 0, { note: [{ text: 'Synthetic https://example.test/private/download and https://example.test/private/image' }] });
    const manifest = r.manifests.find(m => m.reason === 'PROTECTED_LINK_IN_TEXT'); assert.ok(manifest); assert.equal(manifest.spans, 2);
    const s = state([r], false), args = { resource_type: 'Observation', id: 'spans', output: output('fhir') };
    const e = c.renderV2(s, c.admitV2('fhir_read', args), 'fhir_read'); check('fhir_read', e, s, args);
    assert.deepEqual(e.transform.withheld_payloads, r.manifests);
    for (const change of [{ reason: 'PROTECTED_LINK', spans: 1 }, ...[0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1].map(spans => ({ spans })), { unknown: 1 }]) {
      const mutant: GatewayEnvelope02 = { ...e, transform: { ...e.transform, withheld_payloads: [{ ...manifest, ...change }] } };
      assert.deepEqual(validateCrossField02('fhir_read', mutant), { ok: false, reason: 'INVALID_CROSS_FIELDS' }, JSON.stringify(change));
    }
  } finally { g.close(); }
});

test('benchmark 100 records at the 128-KiB ceiling: correctness asserted; gateway-only timings reported', () => {
  const { g, c } = setup();
  try {
    const records = Array.from({ length: 100 }, (_, i) => record(`bench-${i}`, i, { meta: undefined, identifier: undefined, note: undefined, text: undefined, contained: undefined, component: undefined, referenceRange: undefined,
      _status: undefined, _effectiveDateTime: undefined, interpretation: undefined, specimen: undefined, device: undefined, derivedFrom: undefined, valueString: 'synthetic '.repeat(10) }));
    const s = state(records), args = { resource_type: 'Observation', page_size: 100, output: output('compact', 131072) };
    const samples: number[] = []; let last!: GatewayEnvelope02;
    for (let i = 0; i < 24; i++) { const admission = c.admitV2('fhir_search', args), start = performance.now(); last = c.renderV2(s, admission, 'fhir_search'); const ms = performance.now() - start; if (i >= 4) samples.push(ms); }
    check('fhir_search', last, s, args); assert.equal((last.data as Rec).resources.length, 100);
    assert.ok(last.budget.bytes_returned > 120000, '100 delivered records near the 128-KiB ceiling');
    samples.sort((a, b) => a - b);
    console.log(`S54_BENCH ${JSON.stringify({ records: 100, result_bytes: last.budget.bytes_returned, delivered: (last.data as Rec).resources.length,
      samples: samples.length, p50_ms: samples[Math.floor(samples.length * .5)], p95_ms: samples[Math.ceil(samples.length * .95) - 1], target_ms: 100 })}`);
  } finally { g.close(); }
});

for (const tool of ['fhir_read', 'fhir_search', 'fhir_page', 'fhir_result'] as const) for (const format of formats) test(`missing version stays absent ${tool} ${format ?? 'default'}`, () => {
  const { g, c } = setup();
  try {
    const r = record('no-version'); delete (r.resource.meta as Rec).versionId;
    const s = state([r], tool !== 'fhir_read'), args: Rec = { output: output(format), ...(tool === 'fhir_read' ? { resource_type: 'Observation', id: 'no-version' } : tool === 'fhir_search' ? { resource_type: 'Observation' } : tool === 'fhir_page' ? { cursor: 'cur_test' } : { handle: c.store.put('res', s).handle, action: 'page' }) };
    const e = tool === 'fhir_result' ? c.resultV2(c.admitV2(tool, args)) : c.renderV2(s, c.admitV2(tool, args), tool);
    check(tool, e, s, args); assert.equal(at((e.data as Rec).resources[0], 'meta.versionId'), undefined);
    assert.equal(at((e.data as Rec).resources[0], 'meta._versionId.id'), 'version-companion');
  } finally { g.close(); }
});

for (const format of ['fhir', 'compact'] as const) test(`partial selection discloses exact present paths, modifier supplement and contained evidence ${format}`, () => {
  const { g, c } = setup();
  try {
    const r = record('partial'), s = state([r]);
    const args = { resource_type: 'Observation', output: { format, fields: ['code.coding.code', 'valueQuantity.value', 'specimen', 'derivedFrom', 'absent'] } };
    const e = c.renderV2(s, c.admitV2('fhir_search', args), 'fhir_search'); check('fhir_search', e, s, args);
    const delivered = (e.data as Rec).resources[0];
    assert.equal(at(delivered, 'valueQuantity.comparator'), '>=');
    assert.deepEqual(delivered.contained, r.resource.contained);
    assert.ok(e.transform.omitted_fields.includes('/code/coding/version'));
    assert.ok(e.transform.omitted_fields.includes('/valueQuantity/system'));
    assert.ok(!e.transform.omitted_fields.includes('/valueQuantity/comparator'));
    assert.ok(!e.transform.omitted_fields.includes('/absent')); assert.deepEqual(e.transform.unresolved_fields, ['absent']);
    assert.deepEqual(e.transform.recipe_ids, []);
    const h = e.result!.handle, retained = { handle: h, action: 'project', output: args.output };
    const again = c.resultV2(c.admitV2('fhir_result', retained)); check('fhir_result', again, s, retained);
    assert.equal(stringifyFhir((again.data as Rec).resources[0]), stringifyFhir(delivered));
  } finally { g.close(); }
});

test('policy-withheld modifier stays structural on selected retained output and omission-only inspection', () => {
  const { g, c } = setup();
  try {
    const r = record('withheld-modifier', 0, { status: 'https://outside.invalid/status?synthetic=withheld' });
    assert.equal(r.requiresStructuralView, true);
    const s = state([r]), stored = c.store.put('res', s);
    for (const action of ['project', 'page', 'inspect']) {
      const args = { handle: stored.handle, action, ...(action !== 'inspect' ? { fields: ['status'] } : {}), output: output('compact') };
      const e = c.resultV2(c.admitV2('fhir_result', args)); check('fhir_result', e, s, args);
      assert.deepEqual(e.transform.recipe_ids, []); assert.deepEqual(e.transform.structural_resource_indices, [0]);
      assert.ok(e.warnings.some(w => w.code === 'UNINTERPRETED_MODIFIER'));
      if (action === 'inspect') {
        const row = (e.data as Rec).omissions[0]; assert.equal(row.interpretation, 'structural');
        assert.ok(row.withheld_reasons.includes('PROTECTED_LINK')); assert.ok(!stringifyFhir(e).includes('outside.invalid'));
      }
    }
  } finally { g.close(); }
});

test('retained projection no-progress returns an oversized recovery manifest', () => {
  const { g, c } = setup();
  try {
    const s = state([record('unfit', 0, { valueString: 'x'.repeat(20000) })]), handle = c.store.put('res', s).handle;
    const before = stringifyFhir(c.store.get(handle));
    const e = c.resultV2(c.admitV2('fhir_result', { handle, action: 'project', output: output('fhir', 4096) }));
    check('fhir_result', e, s, { handle, action: 'project', output: output('fhir', 4096) });
    assert.ok((e.data as Rec).manifest); assert.equal(e.result!.handle, handle);
    assert.equal(stringifyFhir(c.store.get(handle)), before);
  } finally { g.close(); }
});

test('read malformed ids are uniformly non-disclosing; precision faults cannot be hidden by selection', () => {
  const { g, c } = setup();
  try {
    const args = { resource_type: 'Observation', id: 'target', output: { format: 'compact', fields: ['status'] } };
    for (const id of ['invalid/id', '.', '..', 'x'.repeat(65)]) {
      const s = state([record(id)], false);
      assert.throws(() => c.renderV2(s, c.admitV2('fhir_read', args), 'fhir_read'), (e: any) => e.code === 'NOT_FOUND');
    }
    const r = record('target'); r.resource.valueQuantity = { value: new FhirPrecisionFault() };
    assert.throws(() => c.renderV2(state([r], false), c.admitV2('fhir_read', args), 'fhir_read'), (e: any) => e.code === 'UNSUPPORTED_PRECISION');
    assert.equal(c.store.size, 0);
  } finally { g.close(); }
});

test('inspection reasons are unique safe metadata, manifests remain per-record and retrieval time never resets', () => {
  const { g, c } = setup();
  try {
    const r = record('retained-payloads', 1, { presentedForm: [{ data: 'payload-one' }, { data: 'payload-two', url: 'https://outside.invalid/download' }] });
    const s = state([r]), h = c.store.put('res', s).handle;
    const inspect = { handle: h, action: 'inspect', output: output('compact') }, i = c.resultV2(c.admitV2('fhir_result', inspect)); check('fhir_result', i, s, inspect);
    assert.deepEqual((i.data as Rec).omissions[0].withheld_reasons, corpus.withheldReasons);
    const project = { handle: h, action: 'page', output: output('fhir') }, p = c.resultV2(c.admitV2('fhir_result', project)); check('fhir_result', p, s, project);
    assert.deepEqual(p.transform.withheld_payloads, r.manifests); assert.equal(p.transform.withheld_payloads.length, 3);
    assert.equal(p.provenance![0]!.retrieved_at, corpus.retrievalTimes[1]);
  } finally { g.close(); }
});

// S5.4 review regressions: all fixtures are authorized synthetic observations.
test('S54-R01 drains 100 byte-limited records with one retained clinical blob', () => {
  const { g, c } = setup();
  try {
    let s = state(Array.from({ length: 100 }, (_, i) => record(`drain-${i}`, i, { valueString: 'z'.repeat(8000) })));
    let e = c.renderV2(s, c.admitV2('fhir_search', { resource_type: 'Observation', page_size: 100, output: { format: 'fhir' } }), 'fhir_search');
    const used = c.store.usedBytes(); let delivered = (e.data as Rec).resources.length, pages = 1;
    while (e.pagination?.next_cursor) {
      assert.ok(pages++ < 101, 'continuation progresses');
      const cursor = e.pagination.next_cursor; s = c.store.get(cursor).value;
      e = c.renderV2(s, c.admitV2('fhir_page', { cursor, output: { format: 'fhir' } }), 'fhir_page');
      delivered += (e.data as Rec).resources.length;
      assert.equal((c.store as any).blobs.size, 1);
      assert.equal(c.store.usedBytes(), used, 'overlays never charge another clinical body');
    }
    assert.equal(delivered, 100); assert.ok(pages > 10); assert.ok(used < 1024 * 1024);
  } finally { g.close(); }
});

test('S54-R02 oversized retention failure has usable recovery and gate rejects a dangling action', () => {
  const { g, c } = setup({ retentionBytes: 256 });
  try {
    const s = state([record('huge', 0, { valueString: 'x'.repeat(40000) })], false);
    const args = { resource_type: 'Observation', id: 'huge', output: { format: 'fhir', max_bytes: 4096 } };
    const e = c.renderV2(s, c.admitV2('fhir_read', args), 'fhir_read');
    assert.equal(e.result, undefined); assert.ok(e.warnings.some(w => w.code === 'RESULT_NOT_RETAINED'));
    assert.doesNotMatch((e.data as Rec).manifest.action, /fhir_result/);
    check('fhir_read', e, s, args);
    (e.data as Rec).manifest.action = 'Use fhir_result with project and a bounded field selection.';
    assert.equal(validateCrossField02('fhir_read', toWireValue(e)).ok, false);
  } finally { g.close(); }
});

for (const kind of ['unverified', 'nonContinuable', 'overlay', 'incomplete'] as const) {
  test(`S54-R03 inspect preserves unknown continuation ${kind} and refuses false`, () => {
    const { g, c } = setup();
    try {
      const s = state();
      if (kind === 'unverified') (s as Rec).queryEvidenceKind = 'unverified_continuation';
      if (kind === 'nonContinuable') s.nonContinuable = true;
      if (kind === 'overlay') s.queryOverlay!.nonContinuable = true;
      if (kind === 'incomplete') s.sourceIncomplete = true;
      const handle = c.store.put('res', s).handle, args = { handle, action: 'inspect', output: { format: 'fhir' } };
      const e = c.resultV2(c.admitV2('fhir_result', args));
      assert.equal((e.data as Rec).upstream_pages_remain, null); const context = check('fhir_result', e, s, args);
      (e.data as Rec).upstream_pages_remain = false;
      assert.equal(validateCrossField02('fhir_result', toWireValue(e), context).ok, false);
    } finally { g.close(); }
  });
}

test('S54-R04 index-free sorted selection disclosure makes narrower 150-component selection fit', () => {
  const { g, c } = setup();
  try {
    const component = Array.from({ length: 150 }, (_, i) => ({ code: { coding: [{ system: 'http://loinc.org', code: `c${i}`, display: 'd' }], text: 't' }, valueString: 'v', interpretation: [{ text: 'i' }] }));
    const s = state([record('wide', 0, { component })]);
    for (const fields of [['component'], ['component.code.coding.code']]) {
      const args = { resource_type: 'Observation', output: { fields, format: 'fhir', max_bytes: 65536 } };
      const e = c.renderV2(s, c.admitV2('fhir_search', args), 'fhir_search');
      assert.equal((e.data as Rec).resources.length, 1); check('fhir_search', e, s, args);
      assert.ok(e.transform.omitted_fields.length < 30);
      assert.deepEqual(e.transform.omitted_fields, [...new Set(e.transform.omitted_fields)].sort());
      assert.ok(!e.transform.omitted_fields.some(p => /\/component\/\d/.test(p)));
      if (fields[0]!.includes('.')) assert.ok(e.transform.omitted_fields.includes('/component/code/coding/system'));
    }
  } finally { g.close(); }
});

for (const format of ['fhir', 'compact'] as const) for (const tool of ['fhir_read', 'fhir_search', 'fhir_page', 'fhir_result'] as const) {
  test(`S54-R05 structural fields keep full sanitized evidence ${tool}/${format}`, () => {
    const { g, c } = setup();
    try {
      const s = state([record('structural-full', 0, { modifierExtension: [{ url: 'http://example.test/modifier', valueBoolean: true }], valueString: 'synthetic full view' })], tool !== 'fhir_read');
      const args: Rec = { resource_type: 'Observation', id: 'structural-full', cursor: 'cur_test', output: { format, fields: ['status'] } };
      let e: GatewayEnvelope02;
      if (tool === 'fhir_result') {
        args.handle = c.store.put('res', s).handle; args.action = 'project'; delete args.resource_type; delete args.id; delete args.cursor;
        e = c.resultV2(c.admitV2(tool, args));
      } else {
        if (tool !== 'fhir_page') delete args.cursor;
        if (tool !== 'fhir_read') delete args.id;
        if (tool === 'fhir_page') delete args.resource_type;
        e = c.renderV2(s, c.admitV2(tool, args), tool);
      }
      assert.equal(stringifyFhir((e.data as Rec).resources[0]), stringifyFhir(s.records[0]!.resource));
      assert.deepEqual(e.transform.omitted_fields, s.records[0]!.omitted);
      assert.deepEqual(e.transform.structural_resource_indices, [0]); check(tool, e, s, args);
    } finally { g.close(); }
  });
}

for (const count of [1, 2, 10]) test(`S54-R06 escape-dense structured text fits or recovers (${count})`, () => {
  const { g, c } = setup();
  try {
    const delivery = { era: 'modern', profile: 'structured-evidence-v1' } as const;
    const records = count === 1 ? [record('dense', 0, { valueQuantity: undefined, valueString: '\u0085'.repeat(15000) })]
      : [record('small'), ...Array.from({ length: count - 1 }, (_, i) => record(`dense-${i}`, 0, { valueQuantity: undefined, valueString: '\u0085'.repeat(count === 10 ? 3000 : 15000) }))];
    const s = state(records), args = { resource_type: 'Observation', page_size: count, output: { format: 'fhir', max_bytes: 131072 } };
    const e = c.renderV2(s, c.admitV2('fhir_search', args), 'fhir_search', delivery);
    assert.ok(e.result); check('fhir_search', e, s, args, delivery);
    if (count === 1) assert.ok((e.data as Rec).manifest);
    else {
      const delivered = (e.data as Rec).resources;
      assert.deepEqual(delivered.map((r: Rec) => r.id), records.slice(0, delivered.length).map(r => r.resource.id));
      assert.ok(delivered.length > 0 && delivered.length < records.length);
      assert.ok(!e.coverage.reasons.includes('OVERSIZED_RESOURCE'));
    }
    assert.equal(e.pagination!.has_more, true); assert.equal(e.coverage.query_exhausted, false);
    assert.equal(c.store.get(e.pagination!.next_cursor!).value.offset, (e.data as Rec).resources.length);
    assert.deepEqual(e.provenance, records.slice(0, (e.data as Rec).resources.length).map((r, i) => ({ resource_index: i, retrieved_at: r.retrievedAt })));
  } finally { g.close(); }
});

test('S54-R06 bound limits unchecked serialization batch growth', () => {
  const { g, c } = setup();
  try {
    const core = c as any, bytes = core.bytesV2.bind(c); let largest = 0;
    core.bytesV2 = (e: GatewayEnvelope02, d: DeliveryContext) => { bytes(e, d); largest = Math.max(largest, e.budget.bytes_returned); };
    const s = state(Array.from({ length: 100 }, (_, i) => record(`bound-${i}`, 0, { valueString: 'q'.repeat(1500) })));
    c.renderV2(s, c.admitV2('fhir_search', { resource_type: 'Observation', page_size: 100, output: { format: 'fhir', max_bytes: 24576 } }), 'fhir_search');
    assert.ok(largest < 40000, 'estimated batches must not serialize several budgets before checking');
  } finally { g.close(); }
});

test('S54-R07 delivered SUBSETTED tag never appears in selection omissions', () => {
  const { g, c } = setup();
  try {
    const s = state([record('tags', 0, { meta: { versionId: '1', tag: [{ system: 'http://example.test/other', code: 'OTHER' }, { code: 'SUBSETTED' }] } })]);
    const e = c.renderV2(s, c.admitV2('fhir_search', { resource_type: 'Observation', output: { fields: ['status'] } }), 'fhir_search');
    assert.deepEqual((e.data as Rec).resources[0].meta.tag, [{ code: 'SUBSETTED' }]);
    assert.ok(e.transform.omitted_fields.includes('/meta/tag'));
    assert.ok(!e.transform.omitted_fields.some(p => p.startsWith('/meta/tag/')));
  } finally { g.close(); }
});

test('S54-R08 real sanitizer counts over 10000 spans without making selected evidence undeliverable', () => {
  const { g, c } = setup();
  try {
    const s = state([record('many-links', 0, { note: [{ text: 'a:// '.repeat(10001) }] })]);
    const args = { resource_type: 'Observation', output: { fields: ['status'] } };
    const e = c.renderV2(s, c.admitV2('fhir_search', args), 'fhir_search');
    assert.equal(e.transform.withheld_payloads.find(m => m.reason === 'PROTECTED_LINK_IN_TEXT')?.spans, 10001);
    check('fhir_search', e, s, args);
    const manifest = e.transform.withheld_payloads.find(m => m.spans)!;
    for (const spans of [Number.MAX_SAFE_INTEGER, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      manifest.spans = spans;
      const mutant = { ...e, coverage: { ...e.coverage, scope: 'resource', query_evidence: 'exact_id_and_subject_linkage', query_digest: undefined, constraints: undefined, sort: undefined, constraints_on_first_page: undefined } };
      assert.equal(validateCrossField02('fhir_read', toWireValue(mutant)).ok, spans === Number.MAX_SAFE_INTEGER);
    }
  } finally { g.close(); }
});

test('S54-R09 injected later store fault rolls back its cursor and preserves existing evidence', () => {
  const { g, c } = setup();
  try {
    const s = state([record('fault-0'), record('fault-1')], true, 1);
    const existing = c.store.put('res', state()).handle, used = c.store.usedBytes(), original = c.store.putBatch.bind(c.store); let calls = 0;
    c.store.putBatch = entries => { if (++calls === 2) throw new Error('synthetic injected storage fault'); return original(entries); };
    assert.throws(() => c.renderV2(s, c.admitV2('fhir_search', { resource_type: 'Observation', page_size: 1 }), 'fhir_search'), /synthetic injected storage fault/);
    assert.equal(c.store.size, 1); assert.equal(c.store.usedBytes(), used); assert.ok(c.store.get(existing));
  } finally { g.close(); }
});

test('S54-R10 omission inspection keeps 128 bytes for final request accounting', () => {
  const { g, c } = setup();
  try {
    const s = state(Array.from({ length: 30 }, (_, i) => record(`inspect-${i}`))), handle = c.store.put('res', s).handle;
    for (let max_bytes = 4096; max_bytes < 6500; max_bytes += 17) {
      const args = { handle, action: 'inspect', limit: 30, output: { max_bytes } }, e = c.resultV2(c.admitV2('fhir_result', args));
      assert.ok(e.budget.bytes_returned <= max_bytes - 128); check('fhir_result', e, s, args);
    }
  } finally { g.close(); }
});

test('S54-R11 structural render and inspect indices restart at a nonzero slice offset', () => {
  const { g, c } = setup();
  try {
    const s = state([record('offset-0'), record('offset-1', 0, { modifierExtension: [{ url: 'http://example.test/modifier', valueBoolean: true }] }), record('offset-2')]);
    s.offset = 1;
    const e = c.renderV2(s, c.admitV2('fhir_page', { cursor: 'cur_test' }), 'fhir_page');
    assert.deepEqual(e.transform.structural_resource_indices, [0]);
    const handle = c.store.put('res', { ...s, offset: 0 }).handle;
    for (const action of ['inspect', 'project', 'page']) {
      const args = { handle, action, offset: 1 }, r = c.resultV2(c.admitV2('fhir_result', args));
      assert.deepEqual(r.transform.structural_resource_indices, [0]); check('fhir_result', r, s, args);
    }
  } finally { g.close(); }
});

test('S54-R11 local cursor and result preserve original near-expiry chain deadline', () => {
  const { g, c } = setup();
  try {
    const s = state([record('ttl-0'), record('ttl-1'), record('ttl-2')], true, 1); s.expiresAt = Date.now() + 8000;
    const expected = new Date(s.expiresAt).toISOString();
    const first = c.renderV2(s, c.admitV2('fhir_search', { resource_type: 'Observation', page_size: 1 }), 'fhir_search');
    assert.equal(first.result!.expires_at, expected);
    const cursor = first.pagination!.next_cursor!; assert.equal(c.store.get(cursor).expires_at, expected);
    const next = c.renderV2(c.store.get(cursor).value, c.admitV2('fhir_page', { cursor }), 'fhir_page');
    assert.equal(next.result!.expires_at, expected);
  } finally { g.close(); }
});

test('S54-R11 retention-failure reservation controls packing at the byte edge', () => {
  const { g, c } = setup({ retentionBytes: 256 });
  try {
    const s = state([record('edge', 0, { valueString: 's'.repeat(1000) })], false);
    let witnessed = false;
    for (let max_bytes = 6500; max_bytes < 11000; max_bytes++) {
      const args = { resource_type: 'Observation', id: 'edge', output: { format: 'fhir', max_bytes } };
      const e = c.renderV2(s, c.admitV2('fhir_read', args), 'fhir_read');
      assert.ok(e.budget.bytes_returned <= max_bytes - 128, 'retention failure preserves reserved headroom');
      if ((e.data as Rec).resources.length) { witnessed = true; break; }
    }
    assert.ok(witnessed);
  } finally { g.close(); }
});

test('S54-R13 contained visit budget is owned by each local traversal', () => {
  const source = readFileSync(new URL('../packages/core/src/projection.ts', import.meta.url), 'utf8');
  // Architectural invariant: a caller/reentrant traversal cannot reset another call's work budget.
  assert.match(source, /function localReference\(value: unknown\): boolean \{\s+let visitedBudget = 0;/);
});

for (const malformed of [false, true]) test(`S54-total publishes delivered count only for an eligible upstream page (malformed=${malformed})`, async () => {
  const { g, c } = setup();
  try {
    // Exercise real fetchPage authorization and total eligibility, with a local transport seam.
    const core = c as any, url = new URL('Observation?subject=Patient%2Fsynthetic-a&_count=100', config.source.baseUrl + '/');
    core.transport.get = async () => ({ resourceType: 'Bundle', type: 'searchset', total: 98765,
      link: [{ relation: 'self', url: url.href }], entry: [raw('total-good'), ...(malformed ? [{ ...raw('bad'), id: 'invalid/id' }] : [])].map(resource => ({ resource, search: { mode: 'match' } })) });
    const s = await core.fetchPage(url, 'Observation', [...pairs, { name: '_count', value: '100' }], { calls: 0 }, true);
    assert.equal(s.total, malformed ? undefined : 1, 'fetchPage eligibility is preserved before v2 publication');
    const args = { resource_type: 'Observation', output: { format: 'fhir', max_bytes: 131072 } };
    const e = c.renderV2(s, c.admitV2('fhir_search', args), 'fhir_search');
    assert.deepEqual(e.pagination!.total, { precision: 'unknown', ...(malformed ? {} : { value: 1 }) });
    check('fhir_search', e, s, args);
    if (!malformed) {
      core.transport.get = async () => ({ resourceType: 'Bundle', type: 'searchset', total: 98765,
        link: [{ relation: 'self', url: url.href }], entry: [{ resource: raw('total-good'), search: { mode: 'match' } },
          { fullUrl: 'http://other.invalid/fhir/Observation/total-refused', resource: raw('total-refused'), search: { mode: 'match' } }] });
      const refused = await core.fetchPage(url, 'Observation', [...pairs, { name: '_count', value: '100' }], { calls: 0 }, true);
      const partial = c.renderV2(refused, c.admitV2('fhir_search', args), 'fhir_search');
      assert.equal(partial.pagination!.total!.value, undefined, 'partial coverage cannot publish a query total');
      check('fhir_search', partial, refused, args);
    }
  } finally { g.close(); }
});

for (const meta of [{ lastUpdated: '2025-01-01T00:00:00Z' }, { source: 'urn:synthetic', tag: [{ code: 'OTHER' }] }]) {
  test(`S54R2-N01 supplement-only meta omission is disclosed (${Object.keys(meta).join()})`, () => {
    const { g, c } = setup();
    try {
      const s = state([record('meta-only', 0, { meta })]), args = { resource_type: 'Observation', output: { fields: ['status'] } };
      const e = c.renderV2(s, c.admitV2('fhir_search', args), 'fhir_search'); check('fhir_search', e, s, args);
      assert.equal((e.data as Rec).resources[0].meta, undefined);
      assert.ok(e.transform.omitted_fields.some(p => p === '/meta' || p.startsWith('/meta/')));
    } finally { g.close(); }
  });
}

// Zero fit is tested at the start and at a stuck mid-slice offset. Controls
// never advance over that record. A read has no continuation in either case.
for (const era of ['modern', 'legacy'] as const) for (const profile of ['full-text-v1', 'structured-evidence-v1'] as const)
for (const tool of ['fhir_search', 'fhir_page', 'fhir_read', 'project', 'page'] as const)
for (const kind of ['selected', 'structural-fit', 'structural-unfit'] as const)
for (const middle of [false, true]) {
  if (tool === 'fhir_read' && middle) continue;
  test(`S54R2-N02/N03 zero-fit matrix ${tool}/${kind}/middle=${middle}/${era}/${profile}`, () => {
    const delivery = { era, profile };
    const retained = tool === 'project' || tool === 'page', wireTool = retained ? 'fhir_result' : tool;
    const { g, c } = setup();
    try {
      const structural = kind !== 'selected', unfit = kind === 'structural-unfit';
      const stuck = record('stuck', 1, { valueString: 'x'.repeat(unfit ? 140000 : 30000),
        ...(structural ? { modifierExtension: [{ url: 'http://example.test/modifier', valueBoolean: true }] } : {}) });
      const s = state(middle ? [record('before'), stuck, record('after')] : [stuck], tool !== 'fhir_read');
      s.offset = middle ? 1 : 0;
      if (middle && !retained) s.queryOverlay!.deliveredCount = 1;
      const args: Rec = { output: { format: 'fhir', max_bytes: 8192 }, ...(retained
        ? { handle: c.store.put('res', { ...s, offset: 0 }).handle, action: tool, offset: s.offset }
        : tool === 'fhir_read' ? { resource_type: 'Observation', id: 'stuck' }
        : tool === 'fhir_search' ? { resource_type: 'Observation' } : { cursor: 'cur_fixture' }) };
      const e = retained ? c.resultV2(c.admitV2(wireTool, args), delivery) : c.renderV2(s, c.admitV2(wireTool, args), wireTool, delivery);
      check(wireTool, e, s, args, delivery);
      assert.deepEqual((e.data as Rec).resources, []); assert.ok((e.data as Rec).manifest);
      assert.equal(e.coverage.state, 'partial'); assert.ok(e.coverage.reasons.includes('OVERSIZED_RESOURCE'));
      assert.equal(e.coverage.query_exhausted, retained || tool === 'fhir_read' || unfit ? null : false);
      assert.equal(e.pagination!.has_more, retained || tool === 'fhir_read' ? false : unfit ? null : true);
      assert.equal((e.data as Rec).next_offset, undefined);
      const action = (e.data as Rec).manifest.action as string;
      if (structural) assert.doesNotMatch(action, /field selection|with project/);
      if (unfit) {
        assert.match(action, /cannot be delivered inline/); assert.match(action, /fhir_result inspect/);
        assert.match(action, /later retained records|Later retained records/);
        assert.equal(e.pagination!.next_cursor, undefined);
        if (!retained && tool !== 'fhir_read') {
          const stored = c.store.get(e.result!.handle).value;
          assert.equal(stored.nonContinuable, true); assert.equal(stored.queryOverlay!.nonContinuable, true);
          const inspectArgs = { handle: e.result!.handle, action: 'inspect', output: { max_bytes: 8192 } };
          const inspected = c.resultV2(c.admitV2('fhir_result', inspectArgs), delivery); check('fhir_result', inspected, s, inspectArgs, delivery);
          assert.equal((inspected.data as Rec).upstream_pages_remain, null);
        }
      } else {
        if (!retained && tool !== 'fhir_read') assert.equal(c.store.get(e.pagination!.next_cursor!).value.offset, s.offset);
        if (retained) assert.match(action, /same handle and offset/);
        const retryArgs = { handle: e.result!.handle, action: 'project', offset: s.offset,
          ...(structural ? {} : { fields: ['status'] }), output: { format: 'fhir', max_bytes: structural ? Number(action.match(/max_bytes of (\d+)/)![1]) : 8192 } };
        assert.ok(retryArgs.output.max_bytes <= 131072);
        const retry = c.resultV2(c.admitV2('fhir_result', retryArgs), delivery); check('fhir_result', retry, s, retryArgs, delivery);
        assert.equal((retry.data as Rec).resources[0].id, 'stuck');
      }
    } finally { g.close(); }
  });
}

for (const unfit of [false, true]) test(`S54R2-N02 structural no-retention advice unfit=${unfit}`, () => {
  const { g, c } = setup({ retentionBytes: 256 });
  try {
    const s = state([record('no-retain', 0, { valueString: 'x'.repeat(unfit ? 140000 : 30000), modifierExtension: [{ url: 'http://example.test/modifier', valueBoolean: true }] })], false);
    const args = { resource_type: 'Observation', id: 'no-retain', output: { max_bytes: 8192 } };
    const e = c.renderV2(s, c.admitV2('fhir_read', args), 'fhir_read'); check('fhir_read', e, s, args);
    assert.equal(e.result, undefined); const action = (e.data as Rec).manifest.action;
    assert.doesNotMatch(action, /fhir_result|field selection/);
    assert.match(action, unfit ? /cannot be delivered inline/ : /full sanitized view/);
  } finally { g.close(); }
});

test('S54R2-N04 ledger rollback restores discovery evicted by a provisional clinical write', () => {
  const { g, c } = setup({ retentionBytes: 40000 });
  try {
    const d = (c as any).discoveryStore as ResultStore<any>;
    const handle = d.put('cur', { topic: 'support', filler: 'm'.repeat(30000) }).handle, before = d.usedBytes();
    const s = state([record('ledger-0', 0, { valueString: 'q'.repeat(5000) }), record('ledger-1', 0, { valueString: 'q'.repeat(5000) })]);
    const original = c.store.putBatch.bind(c.store); let calls = 0, evicted = false;
    c.store.putBatch = entries => {
      if (++calls === 2) { evicted = d.size === 0; throw new Error('synthetic injected storage fault'); }
      return original(entries);
    };
    assert.throws(() => c.renderV2(s, c.admitV2('fhir_search', { resource_type: 'Observation', page_size: 1 }), 'fhir_search'), /synthetic injected storage fault/);
    assert.equal(evicted, true); assert.equal(c.store.size, 0); assert.equal(d.size, 1); assert.equal(d.usedBytes(), before); assert.ok(d.get(handle));
  } finally { g.close(); }
});

test('S54R2-N04 nested checkpoint restore does not invalidate its outer checkpoint', () => {
  const { g, c } = setup();
  try {
    const first = c.store.put('res', state([record('outer')])).handle, used = c.store.usedBytes();
    const outer = c.store.reservationCheckpoint();
    const second = c.store.put('res', state([record('inner')])).handle;
    const inner = c.store.reservationCheckpoint();
    const third = c.store.put('res', state([record('last')])).handle;
    inner(); assert.ok(c.store.get(second)); assert.throws(() => c.store.get(third));
    outer(); assert.ok(c.store.get(first)); assert.throws(() => c.store.get(second));
    assert.equal(c.store.size, 1); assert.equal(c.store.usedBytes(), used);
  } finally { g.close(); }
});

for (const tool of ['fhir_search', 'fhir_page'] as const) for (const kind of ['overlay', 'unverified', 'incomplete'] as const) {
  test(`S54R2-N05 unknown terminal continuation ${tool}/${kind}`, () => {
    const { g, c } = setup();
    try {
      const s = state();
      if (kind === 'overlay') s.queryOverlay!.nonContinuable = true;
      if (kind === 'unverified') (s as Rec).queryEvidenceKind = 'unverified_continuation';
      if (kind === 'incomplete') s.sourceIncomplete = true;
      const args = tool === 'fhir_search' ? { resource_type: 'Observation' } : { cursor: 'cur_fixture' };
      const e = c.renderV2(s, c.admitV2(tool, args), tool); check(tool, e, s, args);
      assert.equal(e.pagination!.has_more, null); assert.equal(e.coverage.query_exhausted, null);
    } finally { g.close(); }
  });
}

test('S54R2-N07 natural GatewayFault rollback restores an evicted result', () => {
  const { g, c } = setup({ retentionBytes: 60000 });
  try {
    c.store.put('cur', state([record('held-cursor', 0, { valueString: 'a'.repeat(40000) })]));
    const handle = c.store.put('res', state([record('held-result', 0, { valueString: 'b'.repeat(5000) })])).handle;
    const used = c.store.usedBytes();
    const s = state([record('incoming-0', 0, { valueString: 'c'.repeat(12000) }), record('incoming-1', 0, { valueString: 'c'.repeat(12000) })], true, 1);
    assert.throws(() => c.renderV2(s, c.admitV2('fhir_search', { resource_type: 'Observation', page_size: 1, output: { max_bytes: 65536 } }), 'fhir_search'), (e: any) => e.code === 'RETENTION_LIMIT');
    assert.ok(c.store.get(handle)); assert.equal(c.store.usedBytes(), used); assert.equal(c.store.size, 2);
  } finally { g.close(); }
});

test('S54R2-N07 completing local continuation never publishes a total', () => {
  const { g, c } = setup();
  try {
    const s = state([record('total-0'), record('total-1'), record('total-2')]); (s as Rec).total = 3;
    const first = c.renderV2({ ...s, query: [...pairs, { name: '_count', value: '2' }] }, c.admitV2('fhir_search', { resource_type: 'Observation', page_size: 2 }), 'fhir_search');
    const cursor = first.pagination!.next_cursor!, next = c.store.get(cursor).value, args = { cursor };
    const e = c.renderV2(next, c.admitV2('fhir_page', args), 'fhir_page'); check('fhir_page', e, next, args);
    assert.deepEqual((e.data as Rec).resources.map((r: Rec) => r.id), ['total-2']); assert.equal(e.pagination!.total!.value, undefined);
  } finally { g.close(); }
});

test('S54R2-N06 multi-pop full drains preserve exact order, controls and provenance', () => {
  const { g, c } = setup();
  try {
    const delivery = { era: 'modern', profile: 'structured-evidence-v1' } as const;
    const records = Array.from({ length: 40 }, (_, i) => record(`multi-${i}`, i, { valueQuantity: undefined, valueString: (i % 3 === 0 ? '\u0085' : 'p').repeat(1200 + 37 * i) }));
    const original = state(records), ids = records.map(r => r.resource.id);
    for (const retained of [false, true]) {
      let offset = 0, s = original, cursor = '', count = 0;
      const handle = retained ? c.store.put('res', original).handle : '';
      const seen: unknown[] = [];
      for (;;) {
        assert.ok(count++ < 41);
        const tool = retained ? 'fhir_result' : cursor ? 'fhir_page' : 'fhir_search';
        const args: Rec = { output: { format: 'fhir', max_bytes: 32768 }, ...(retained ? { handle, action: 'page', offset, limit: 100 }
          : cursor ? { cursor } : { resource_type: 'Observation', page_size: 100 }) };
        const e = retained ? c.resultV2(c.admitV2(tool, args), delivery) : c.renderV2(s, c.admitV2(tool, args), tool, delivery);
        check(tool, e, s, args, delivery);
        const resources = (e.data as Rec).resources;
        assert.ok(resources.length > 0); assert.deepEqual(resources.map((r: Rec) => r.id), ids.slice(offset, offset + resources.length));
        assert.deepEqual(e.provenance, records.slice(offset, offset + resources.length).map((r, i) => ({ resource_index: i, retrieved_at: r.retrievedAt })));
        seen.push(...resources.map((r: Rec) => r.id)); offset += resources.length;
        assert.ok(!e.coverage.reasons.includes('OVERSIZED_RESOURCE'));
        if (offset === records.length) {
          assert.equal(e.pagination!.has_more, false); assert.equal(e.coverage.query_exhausted, retained ? null : true);
          assert.equal((e.data as Rec).next_offset, undefined); assert.equal(e.pagination!.next_cursor, undefined); break;
        }
        assert.equal(e.pagination!.has_more, true); assert.equal(e.coverage.query_exhausted, retained ? null : false);
        if (retained) assert.equal((e.data as Rec).next_offset, offset);
        else { cursor = e.pagination!.next_cursor!; s = c.store.get(cursor).value; assert.equal(s.offset, offset); }
      }
      assert.deepEqual(seen, ids); assert.ok(count > 5);
    }
  } finally { g.close(); }
});

test('S54R2-N07 reservation measures the no-handle recovery text', () => {
  const { g, c } = setup({ retentionBytes: 256 });
  try {
    const core = c as any, bytes = core.bytesV2.bind(c); let reservations = 0;
    core.bytesV2 = (e: GatewayEnvelope02, d: DeliveryContext) => {
      if (!e.result && (e.data as Rec).manifest) {
        reservations++;
        assert.doesNotMatch((e.data as Rec).manifest.action, /fhir_result/);
      }
      bytes(e, d);
    };
    const s = state([record('reserve-manifest', 0, { valueString: 'q'.repeat(40000) })], false);
    const args = { resource_type: 'Observation', id: 'reserve-manifest', output: { max_bytes: 4096 } };
    const e = c.renderV2(s, c.admitV2('fhir_read', args), 'fhir_read'); check('fhir_read', e, s, args);
    assert.ok(reservations > 0);
  } finally { g.close(); }
});

test('S54R2-N08 byte-edge packing avoids the redundant post-break measurement', () => {
  const { g, c } = setup();
  try {
    const core = c as any, bytes = core.bytesV2.bind(c); let calls = 0;
    core.bytesV2 = (e: GatewayEnvelope02, d: DeliveryContext) => { calls++; bytes(e, d); };
    const s = state(Array.from({ length: 100 }, (_, i) => record(`variant-${i}`, 0, { valueString: 'synthetic '.repeat(10) })));
    const args = { resource_type: 'Observation', page_size: 100, output: { format: 'compact', max_bytes: 131072 } };
    const delivery = { era: 'modern', profile: 'structured-evidence-v1' } as const;
    const e = c.renderV2(s, c.admitV2('fhir_search', args), 'fhir_search', delivery);
    assert.equal(calls, 26); assert.equal((e.data as Rec).resources.length, 59); check('fhir_search', e, s, args, delivery);
  } finally { g.close(); }
});

for (const unfit of [false, true]) test(`S54R2-N02 measures against the configured ceiling unfit=${unfit}`, () => {
  const { g, c } = setup({ maxBytes: 65536 });
  try {
    const s = state([record('configured-max', 0, { valueString: 'x'.repeat(unfit ? 40000 : 20000), modifierExtension: [{ url: 'http://example.test/modifier', valueBoolean: true }] })], false);
    const args = { resource_type: 'Observation', id: 'configured-max', output: { max_bytes: 8192 } };
    const e = c.renderV2(s, c.admitV2('fhir_read', args), 'fhir_read'); check('fhir_read', e, s, args);
    const action = (e.data as Rec).manifest.action as string;
    if (unfit) assert.match(action, /cannot be delivered inline/);
    else {
      const needed = Number(action.match(/max_bytes of (\d+)/)![1]); assert.ok(needed <= 65536 && needed > 8192);
      const retryArgs = { ...args, output: { max_bytes: needed } };
      const retry = c.renderV2(s, c.admitV2('fhir_read', retryArgs), 'fhir_read'); check('fhir_read', retry, s, retryArgs);
      assert.equal((retry.data as Rec).resources.length, 1);
    }
  } finally { g.close(); }
});
