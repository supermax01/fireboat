import assert from 'node:assert/strict';
import test from 'node:test';
import { collapseWithheld, withheldMultiplicity } from '../packages/core/src/withheld.js';
import { sanitize, type Sanitized } from '../packages/core/src/privacy.js';
import { evidenceRender } from '../packages/core/src/delivery.js';
import { toMcpToolResult02, validateCrossField02, validateDeliverable02 } from '../packages/core/src/contracts.js';
import { collectEvidence, evaluateCheck } from '../packages/evals/src/runner.js';
import { patient, withGateway, withSdk } from './s57-sdk-helpers.js';

// S5b: withheld-entry collapse. Identical policy-origin {path, reason} manifests at schema-known sites
// collapse into one counted entry at delivery; attachment, payload, in-text-link and unknown-origin
// entries never merge, whatever their shape.

const policy = (path: string, reason: string) => ({ path, reason });
const record = (manifests: Record<string, unknown>[], origins?: string[]) => ({ manifests, manifestOrigins: origins as never });

test('collapseWithheld merges identical policy entries across and within records, keeps every other entry one per occurrence', () => {
  const a = record([policy('/meta/source', 'PROTECTED_LINK'), policy('/subject/display', 'PATIENT_REFERENCE_COMPANION_WITHHELD')], ['policy', 'policy']);
  const b = record([policy('/meta/source', 'PROTECTED_LINK'), policy('/subject/display', 'PATIENT_REFERENCE_COMPANION_WITHHELD')], ['policy', 'policy']);
  const c = record([policy('/meta/source', 'PROTECTED_LINK'), policy('/meta/source', 'PROTECTED_LINK')], ['policy', 'policy']);
  const out = collapseWithheld([a, b, c]);
  assert.deepEqual(out, [{ path: '/meta/source', reason: 'PROTECTED_LINK', count: 4 }, { path: '/subject/display', reason: 'PATIENT_REFERENCE_COMPANION_WITHHELD', count: 2 }]);
  assert.deepEqual(a.manifests[0], policy('/meta/source', 'PROTECTED_LINK'), 'stored entries are never mutated');
  assert.notEqual(out[0], a.manifests[0], 'a collapsed entry is a new object');
  const single = collapseWithheld([a]);
  assert.equal(single[0], a.manifests[0], 'a singleton keeps its shape and identity');
});

test('collapseWithheld keeps same-path entries with different reasons apart; no reason is dropped', () => {
  const out = collapseWithheld([record([policy('/p', 'A')], ['policy']), record([policy('/p', 'B')], ['policy']), record([policy('/p', 'A')], ['policy'])]);
  assert.deepEqual(out, [{ path: '/p', reason: 'A', count: 2 }, { path: '/p', reason: 'B' }]);
});

test('attachment, payload, in-text-link, metadata-bearing and unknown-origin entries never merge', () => {
  const url = policy('/valueAttachment/url', 'PROTECTED_LINK');
  const data = policy('/presentedForm/0/data', 'V1_PAYLOAD_WITHHELD');
  const span = { path: '/note/0/text', reason: 'PROTECTED_LINK_IN_TEXT', spans: 1 };
  const meta = { path: '/content/0/attachment/url', reason: 'PROTECTED_LINK', content_type: 'application/pdf' };
  const out = collapseWithheld([
    record([url, data, span, meta], ['attachment', 'payload', 'link_text', 'attachment']),
    record([url, data, span, meta], ['attachment', 'payload', 'link_text', 'attachment']),
  ]);
  assert.equal(out.length, 8, 'eight occurrences stay eight entries');
  assert.ok(out.every(entry => entry.count === undefined));
  const unknown = collapseWithheld([record([policy('/meta/source', 'PROTECTED_LINK')]), record([policy('/meta/source', 'PROTECTED_LINK')], [])]);
  assert.equal(unknown.length, 2, 'a missing or empty origin sidecar makes entries ineligible');
  const short = collapseWithheld([record([policy('/a', 'R'), policy('/a', 'R')], ['policy'])]);
  assert.equal(short.length, 2, 'a sidecar one short of the manifests makes every entry of that record ineligible');
  const explicit = collapseWithheld([record([policy('/a', 'R')], ['unknown']), record([policy('/a', 'R')], ['unknown'])]);
  assert.equal(explicit.length, 2, 'an explicit unknown origin never merges');
  const metadataPolicy = { path: '/a', reason: 'R', content_type: 'text/plain' };
  assert.equal(collapseWithheld([record([metadataPolicy], ['policy']), record([metadataPolicy], ['policy'])]).length, 2, 'a policy entry carrying any extra key never merges');
  const mixed = collapseWithheld([record([policy('/meta/source', 'PROTECTED_LINK')], ['policy']), record([policy('/meta/source', 'PROTECTED_LINK')], ['attachment'])]);
  assert.equal(mixed.length, 2, 'a policy entry never absorbs an attachment twin of the same shape');
});

test('withheldMultiplicity counts only well-formed collapse counts', () => {
  assert.equal(withheldMultiplicity({ path: '/a', reason: 'R', count: 7 }), 7);
  assert.equal(withheldMultiplicity({ path: '/a', reason: 'R' }), 1);
  assert.equal(withheldMultiplicity({ path: '/a', reason: 'R', count: 1 }), 1);
  assert.equal(withheldMultiplicity({ path: '/a', reason: 'R', count: 3, content_type: 'text/plain' }), 1);
  assert.equal(withheldMultiplicity({ path: '/a', reason: 'R', count: 2.5 }), 1);
});

const originsOf = (sanitized: Sanitized) => Object.fromEntries(sanitized.manifests.map((m, i) => [m.path as string, sanitized.manifestOrigins[i]]));

test('sanitize origins: the schema, never shape or path spelling, classifies attachment context; schema-less sites are unknown', () => {
  // Extension.value[x] admits Attachment; Observation.value[x] does not, so `valueAttachment` on an Observation is an
  // undeclared property whose attachment-ness is only spelled.
  const observation = sanitize({ resourceType: 'Observation', id: 'synthetic-o', status: 'final', subject: { reference: `Patient/${patient}`, display: 'Synthetic A' },
    meta: { source: 'https://example.invalid/src?sig=synthetic' },
    extension: [
      { url: 'http://example.invalid/att', valueAttachment: { url: 'https://example.invalid/x.pdf', data: 'AAAA', extension: [{ url: 'http://example.invalid/ext', valueUrl: 'https://example.invalid/e?token=synthetic' }] } },
      { url: 'http://example.invalid/blob', valueBase64Binary: 'AAAA' },
      // A schema-known Extension whose shape (a `data` sibling) makes the walk treat it as an attachment: that
      // shape-inferred context withholds the link but never classifies it (neither attachment nor policy).
      { url: 'https://example.invalid/ext-link?sig=synthetic', data: 'AAAA' },
    ],
    valueAttachment: { url: 'https://example.invalid/spelled.pdf', data: 'AAAA' },
    note: [{ text: 'see https://example.invalid/n?token=synthetic' }],
    vendorDocument: { url: 'https://example.invalid/doc.pdf?sig=synthetic' },
    vendorAttachment: { url: 'https://example.invalid/att.pdf?sig=synthetic' },
    vendorRef: { reference: `Patient/${patient}`, display: 'Synthetic A' } } as never);
  assert.equal(observation.manifestOrigins.length, observation.manifests.length);
  const byPath = originsOf(observation);
  assert.equal(byPath['/subject/display'], 'policy');
  assert.equal(byPath['/meta/source'], 'policy');
  assert.equal(byPath['/extension/0/valueAttachment/url'], 'attachment');
  assert.equal(byPath['/extension/0/valueAttachment/data'], 'payload');
  assert.equal(byPath['/extension/0/valueAttachment/extension/0/valueUrl'], 'attachment', 'a link inside a schema-declared Attachment inherits the attachment context');
  assert.equal(byPath['/extension/1/valueBase64Binary'], 'payload');
  assert.equal(byPath['/extension/2/url'], 'unknown', 'a shape-inferred attachment context at a schema-known site never classifies');
  assert.equal(byPath['/extension/2/data'], 'payload');
  assert.equal(byPath['/valueAttachment/url'], 'unknown', 'an undeclared element is not an Attachment because its name says so');
  assert.equal(byPath['/valueAttachment/data'], 'payload');
  assert.equal(byPath['/note/0/text'], 'link_text');
  assert.equal(byPath['/vendorDocument/url'], 'unknown', 'a withheld link at a site with no schema element never classifies');
  assert.equal(byPath['/vendorAttachment/url'], 'unknown', 'path spelling alone never classifies an attachment');
  assert.equal(byPath['/vendorRef/display'], 'unknown', 'a companion under an undeclared reference-like node never classifies');
  const report = sanitize({ resourceType: 'DiagnosticReport', id: 'synthetic-r', status: 'final', code: { text: 'Synthetic' }, subject: { reference: `Patient/${patient}` },
    presentedForm: [{ data: 'AAAA', extension: [{ url: 'http://example.invalid/ext', valueUrl: 'https://example.invalid/e?token=synthetic' }] }] } as never);
  const reportPaths = originsOf(report);
  assert.equal(reportPaths['/presentedForm/0/data'], 'payload', 'a payload without contentType is still a payload');
  assert.equal(reportPaths['/presentedForm/0/extension/0/valueUrl'], 'attachment', 'presentedForm is an Attachment by schema, with no "attachment" in its spelling');
  const organization = sanitize({ resourceType: 'Organization', id: 'synthetic-org', vendorField: { note: 'Synthetic' } } as never);
  assert.equal(originsOf(organization)['/[undeclared-property]'], 'unknown', 'an undeclared property in a shared scope never classifies');
});

const obs = (id: string, extra: Record<string, unknown> = {}) => ({ resourceType: 'Observation', id, status: 'final',
  code: { coding: [{ system: 'http://loinc.org', code: '4548-4' }], text: 'HbA1c' }, subject: { reference: `Patient/${patient}`, display: 'Synthetic A' },
  meta: { source: 'https://example.invalid/src?sig=synthetic' }, effectiveDateTime: '2025-01-01T00:00:00Z', valueQuantity: { value: 6.1, unit: '%' }, ...extra });
const output = { format: 'fhir' as const, max_bytes: 131072 };
const freeze = <T>(value: T): T => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
/** Re-renders an envelope exactly as the gateway does (count-converged bytes), for forged and expanded variants. */
function renderedBytes(envelope: any, invocation: any): number {
  const render = () => ({ ...toMcpToolResult02(envelope), ...(invocation.era === 'modern' ? { resultType: 'complete', _meta: { 'io.modelcontextprotocol/serverInfo': invocation.serverIdentity } } : {}) });
  for (let i = 0; i < 8; i++) envelope.budget.bytes_returned = Buffer.byteLength(JSON.stringify(render()));
  return envelope.budget.bytes_returned;
}
function captureFor(envelope: any, invocation: any) {
  renderedBytes(envelope, invocation);
  const result = { ...toMcpToolResult02(envelope), ...(invocation.era === 'modern' ? { resultType: 'complete', _meta: { 'io.modelcontextprotocol/serverInfo': invocation.serverIdentity } } : {}) };
  return freeze({ ...invocation, result, renderedText: result.content[0]!.text });
}
/** The uncollapsed envelope for the same delivered records: every counted entry expanded to one entry per occurrence. */
function expanded(envelope: any) {
  const copy = structuredClone(envelope);
  copy.transform.withheld_payloads = copy.transform.withheld_payloads.flatMap((m: any) => typeof m.count === 'number' ? Array.from({ length: m.count }, () => ({ path: m.path, reason: m.reason })) : [m]);
  return copy;
}
const multiplicity = (payloads: Record<string, unknown>[], path: string) => payloads.filter(m => m.path === path).reduce((n, m) => n + withheldMultiplicity(m), 0);
// Twenty records: two repeated policy entries each, a metadata-free schema Attachment payload each (identical bytes),
// an unknown-origin vendor link each, and an attachment url on the first three.
const ATTACHMENT = '/extension/0/valueAttachment';
const page20 = () => Array.from({ length: 20 }, (_, i) => obs(`synthetic-c${i}`, {
  extension: [{ url: 'http://example.invalid/att', valueAttachment: { ...(i < 3 ? { url: 'https://example.invalid/x.pdf' } : {}), data: 'AAAA' } }],
  vendorDocument: { url: 'https://example.invalid/doc.pdf?sig=synthetic' } }));
function assertPage20(e: any, era: string, delivered = 20) {
  const payloads = e.transform.withheld_payloads as Record<string, unknown>[];
  const at = (path: string) => payloads.filter(m => m.path === path);
  assert.deepEqual(at('/subject/display'), [{ path: '/subject/display', reason: 'PATIENT_REFERENCE_COMPANION_WITHHELD', count: delivered }], `${era}: one counted entry for ${delivered} records`);
  assert.deepEqual(at('/meta/source'), [{ path: '/meta/source', reason: 'PROTECTED_LINK', count: delivered }]);
  assert.equal(at(`${ATTACHMENT}/data`).length, delivered, `${era}: byte-identical metadata-free payload entries stay one per record`);
  assert.equal(at('/vendorDocument/url').length, delivered, `${era}: unknown-origin entries stay one per record`);
  assert.ok(payloads.every(m => m.count === undefined || m.path === '/subject/display' || m.path === '/meta/source'), JSON.stringify(payloads));
}

test('a delivered page collapses repeated policy manifests in both channels, keeps attachment, payload and unknown entries distinct, and every view agrees', async () => {
  for (const era of ['modern', 'legacy'] as const) {
    await withGateway({ pages: [page20()] }, gateway => withSdk(gateway, era, async sdk => {
      const r: any = await sdk.call('fhir_search', { resource_type: 'Observation', page_size: 20, output });
      assert.equal(r.e.error, undefined, `${era}: search succeeds`);
      assert.equal(r.e.data.resources.length, 20);
      assertPage20(r.e, era);
      const payloads = r.e.transform.withheld_payloads as Record<string, unknown>[];
      assert.equal(payloads.filter(m => m.path === `${ATTACHMENT}/url`).length, 3, `${era}: three attachment entries stay distinct`);
      assert.deepEqual(validateDeliverable02('fhir_search', r.e, r.capture), { ok: true }, `${era}: gate accepts the collapsed page`);
      // Both channels disclose the multiplicity exactly once.
      const text = evidenceRender(r.e).text;
      assert.equal((text.match(/^withheld x20: \{"path":"\/subject\/display"/gm) ?? []).length, 1, text);
      assert.equal((text.match(/^withheld: \{"path":"\/extension\/0\/valueAttachment\/url"/gm) ?? []).length, 3);
      assert.equal((text.match(/^withheld: \{"path":"\/extension\/0\/valueAttachment\/data"/gm) ?? []).length, 20);
      assert.equal(JSON.stringify(r.e).split('"reason":"PATIENT_REFERENCE_COMPANION_WITHHELD"').length - 1, 1, `${era}: the full-text JSON carries the manifest entry once (omitted_fields lists the path separately)`);
      // Retained views: project and page agree, inspect carries no manifests.
      const projected: any = await sdk.call('fhir_result', { handle: r.e.result.handle, action: 'project', output });
      assert.equal(projected.e.error, undefined);
      assertPage20(projected.e, `${era} project`);
      const paged: any = await sdk.call('fhir_result', { handle: r.e.result.handle, action: 'page', offset: 5, limit: 5, output });
      assert.equal(paged.e.error, undefined);
      assert.equal(paged.e.data.resources.length, 5);
      assertPage20(paged.e, `${era} page`, 5);
      assert.deepEqual(validateDeliverable02('fhir_result', paged.e, paged.capture), { ok: true });
      const inspected: any = await sdk.call('fhir_result', { handle: r.e.result.handle, action: 'inspect', output });
      assert.deepEqual(inspected.e.transform.withheld_payloads, []);
      assert.ok(inspected.e.data.omissions.every((row: any) => row.withheld_reasons.includes('PATIENT_REFERENCE_COMPANION_WITHHELD')), 'per-record reasons stay uncollapsed');
      // Compact format: sanitization manifests are independent of projection.
      const compact: any = await sdk.call('fhir_search', { resource_type: 'Observation', page_size: 20, output: { format: 'compact', max_bytes: 131072 } });
      assert.equal(compact.e.error, undefined);
      assertPage20(compact.e, `${era} compact`);
      assert.deepEqual(validateDeliverable02('fhir_search', compact.e, compact.capture), { ok: true });
      // Gate negatives on the real envelope.
      const forge = (patch: (m: Record<string, unknown>[]) => void) => { const e = structuredClone(r.e); patch(e.transform.withheld_payloads); return validateCrossField02('fhir_search', e, captureFor(e, r.capture)).ok; };
      assert.equal(forge(() => {}), true, `${era}: the unforged envelope passes the same path`);
      assert.equal(forge(m => { (m.find(x => x.path === '/subject/display') as any).count = 1; }), false, `${era}: a singleton count is rejected`);
      assert.equal(forge(m => { (m.find(x => x.path === '/subject/display') as any).content_type = 'text/plain'; }), false, `${era}: a count never travels with metadata`);
      assert.equal(forge(m => { m.push({ path: '/note/0/text', reason: 'PROTECTED_LINK_IN_TEXT', count: 2 }); }), false, `${era}: a count never travels with an in-text-link reason`);
      assert.equal(forge(m => { (m.find(x => x.path === `${ATTACHMENT}/data`) as any).count = 2; }), false, `${era}: a count never travels with a payload reason`);
      assert.equal(forge(m => { m.push({ path: '/subject/display', reason: 'PATIENT_REFERENCE_COMPANION_WITHHELD', count: 2 }); }), false, `${era}: one collapsed pair is delivered at most once`);
    }));
  }
});

test('the structured-evidence profile prints each delivered entry once, counted entries as withheld xN', async () => {
  for (const era of ['modern', 'legacy'] as const) {
    await withGateway({ pages: [page20()], structured: true }, gateway => withSdk(gateway, era, async sdk => {
      const r: any = await sdk.call('fhir_search', { resource_type: 'Observation', page_size: 20, output });
      assert.equal(r.e.error, undefined, `${era}: search succeeds`);
      assert.equal(r.e.transform.delivery_profile, 'structured-evidence-v1');
      assertPage20(r.e, era);
      assert.deepEqual(validateDeliverable02('fhir_search', r.e, r.capture), { ok: true });
      const text = r.capture.renderedText as string;
      assert.ok(text.startsWith('delivery_profile: "structured-evidence-v1"\n'));
      assert.equal((text.match(/^withheld x20: \{"path":"\/subject\/display","reason":"PATIENT_REFERENCE_COMPANION_WITHHELD"\}$/gm) ?? []).length, 1, text);
      assert.equal((text.match(/^withheld: \{"path":"\/extension\/0\/valueAttachment\/data"/gm) ?? []).length, 20);
      assert.equal((text.match(/^withheld: \{"path":"\/vendorDocument\/url"/gm) ?? []).length, 20);
      assert.ok(!text.includes('"count"'), 'the count is disclosed as withheld xN, never repeated inside the quoted JSON');
    }));
  }
});

test('same path, different reasons: both reasons survive in both channels', async () => {
  const organization = (id: string, identifier: Record<string, unknown>) => ({ resourceType: 'Organization', id, partOf: { reference: 'Organization/synthetic-parent', identifier } });
  const page = [organization('synthetic-org-1', { value: 'synthetic-1' }), organization('synthetic-org-2', { system: 'urn:oid:1.2.3.4', value: 'synthetic-2' })];
  await withGateway({ pages: [page] }, gateway => withSdk(gateway, 'modern', async sdk => {
    const r: any = await sdk.call('fhir_search', { resource_type: 'Organization', page_size: 20, output });
    assert.equal(r.e.error, undefined);
    const reasons = (r.e.transform.withheld_payloads as Record<string, unknown>[]).filter(m => m.path === '/partOf/identifier').map(m => m.reason).sort();
    assert.equal(reasons.length, 2, JSON.stringify(r.e.transform.withheld_payloads));
    assert.notEqual(reasons[0], reasons[1], 'two different reasons at one path stay two entries');
    const text = evidenceRender(r.e).text;
    for (const reason of reasons) assert.ok(text.includes(`withheld: {"path":"/partOf/identifier","reason":"${reason}"}`), `${reason} is in the text channel`);
    assert.deepEqual(validateDeliverable02('fhir_search', r.e, r.capture), { ok: true });
  }));
});

test('counts follow the finally delivered records under a byte ceiling, and the collapsed page is smaller than its uncollapsed twin', async () => {
  const page = Array.from({ length: 30 }, (_, i) => obs(`synthetic-d${i}`, { note: [{ text: 'x'.repeat(120) }] }));
  for (const era of ['modern', 'legacy'] as const) {
    await withGateway({ pages: [page] }, gateway => withSdk(gateway, era, async sdk => {
      const r: any = await sdk.call('fhir_search', { resource_type: 'Observation', page_size: 30, output: { format: 'fhir', max_bytes: 8192 } });
      assert.equal(r.e.error, undefined, `${era}: search succeeds under the ceiling`);
      const delivered = r.e.data.resources.length;
      assert.ok(delivered > 1 && delivered < 30, `${era}: the ceiling limited delivery (${delivered})`);
      assert.equal(multiplicity(r.e.transform.withheld_payloads, '/subject/display'), delivered, `${era}: the count equals the delivered records, never the page`);
      assert.deepEqual(validateDeliverable02('fhir_search', r.e, r.capture), { ok: true });
      assert.ok(r.e.budget.bytes_returned <= 8192);
      // The packer's pre-existing estimate bound decides how many records fit; the collapse only shrinks what is delivered.
      const uncollapsed = renderedBytes(expanded(r.e), r.capture);
      assert.ok(uncollapsed > r.e.budget.bytes_returned, `${era}: the same delivered records render larger uncollapsed (${uncollapsed} > ${r.e.budget.bytes_returned})`);
    }));
  }
});

test('an oversized record keeps the counts bound to what was delivered', async () => {
  const page = [obs('synthetic-big', { note: [{ text: 'x'.repeat(40000) }] }), obs('synthetic-small-1'), obs('synthetic-small-2')];
  for (const era of ['modern', 'legacy'] as const) {
    await withGateway({ pages: [page] }, gateway => withSdk(gateway, era, async sdk => {
      const r: any = await sdk.call('fhir_search', { resource_type: 'Observation', page_size: 3, output: { format: 'fhir', max_bytes: 8192 } });
      assert.equal(r.e.error, undefined, `${era}: oversize recovery is not an error`);
      const delivered = r.e.data.resources.length;
      assert.ok(delivered < 3, `${era}: the oversized record was not delivered inline (${delivered})`);
      assert.equal(multiplicity(r.e.transform.withheld_payloads, '/subject/display'), delivered, `${era}: counts never include the withheld oversized record`);
      assert.deepEqual(validateDeliverable02('fhir_search', r.e, r.capture), { ok: true });
    }));
  }
});

test("the eval 'withheld' check counts validated multiplicity", () => {
  const envelope = { data: {}, transform: { withheld_payloads: [{ path: '/subject/display', reason: 'PATIENT_REFERENCE_COMPANION_WITHHELD', count: 5 }, { path: '/x', reason: 'V1_PAYLOAD_WITHHELD' }], omitted_fields: [] }, warnings: [] } as never;
  const evidence = collectEvidence([envelope]);
  assert.equal(evaluateCheck({ kind: 'withheld', id: 'w', minCount: 6 }, 'fhir', evidence).status, 'pass');
  assert.equal(evaluateCheck({ kind: 'withheld', id: 'w', minCount: 7 }, 'fhir', evidence).status, 'fail');
  assert.equal(evaluateCheck({ kind: 'withheld', id: 'w', minCount: 1, reasonsInclude: 'V1_PAYLOAD_WITHHELD' }, 'fhir', evidence).status, 'pass');
  const malformed = { data: {}, transform: { withheld_payloads: [{ path: '/subject/display', reason: 'R', count: 1 }, { path: '/y', reason: 'R', count: 4, spans: 1 }], omitted_fields: [] }, warnings: [] } as never;
  assert.equal(evaluateCheck({ kind: 'withheld', id: 'w', minCount: 3 }, 'fhir', collectEvidence([malformed])).status, 'fail', 'malformed counts read as one occurrence each');
});
