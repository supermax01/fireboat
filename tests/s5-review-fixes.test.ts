import assert from 'node:assert/strict';
import test from 'node:test';
import { projectSanitized } from '../packages/core/src/index.js';
import type { SanitizedProjectionRecord } from '../packages/core/src/m3b.js';

// S5 review fixes (2026-10-22): pins for defects the independent review of the S5.7 fix round found.

const record = (meta: Record<string, unknown>): SanitizedProjectionRecord => ({
  resource: { resourceType: 'Observation', id: 'synthetic-o1', status: 'final', meta } as SanitizedProjectionRecord['resource'],
  retrievedAt: '2026-10-22T00:00:00Z', policyOmitted: [], withheldReasons: [], requiresStructuralView: false,
});

test('explicit selection keeps a malformed non-array meta.tag in its source shape without a spurious omission', () => {
  const malformed = projectSanitized(record({ tag: { code: 'SUBSETTED' }, versionId: '1' }), 'fhir', ['meta.versionId']);
  const meta = malformed.resource.meta as Record<string, unknown>;
  assert.deepEqual(meta.tag, { code: 'SUBSETTED' }, 'the delivered tag keeps the source shape instead of an array wrap');
  assert.equal(meta.versionId, '1');
  assert.ok(!malformed.meta.omitted_fields.some(path => path.startsWith('/meta/tag')), `no spurious tag omission: ${malformed.meta.omitted_fields.join(', ')}`);
});

test('explicit selection still keeps a well-formed SUBSETTED tag array whole and reports unselected tags', () => {
  const projected = projectSanitized(record({ tag: [{ code: 'other' }, { code: 'SUBSETTED' }], versionId: '1' }), 'fhir', ['meta.versionId']);
  const meta = projected.resource.meta as Record<string, unknown>;
  assert.ok(Array.isArray(meta.tag) && (meta.tag as { code?: string }[]).some(tag => tag.code === 'SUBSETTED'), 'SUBSETTED coding survives selection');
  assert.ok((meta.tag as unknown[]).every(tag => tag === undefined || (tag as { code?: string }).code === 'SUBSETTED'), 'unselected tags are not delivered');
  assert.ok(projected.meta.omitted_fields.some(path => path.startsWith('/meta/tag')), 'the unselected tag is disclosed as omitted');
});

// ---- Opus runtime review (2026-10-22): page-load race, trusted-proof gate binding, futile retention eviction, contained meta.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { FhirGateway } from '../packages/core/src/index.js';
import { toMcpToolResult02, validateCrossField02, validateDeliverable02 } from '../packages/core/src/contracts.js';
import { lab, output, withGateway, withSdk } from './s57-sdk-helpers.js';

const capabilityStatement = JSON.stringify({ resourceType: 'CapabilityStatement', fhirVersion: '4.0.1', rest: [{ mode: 'server', resource: [
  { type: 'Observation', interaction: [{ code: 'read' }, { code: 'search-type' }], searchParam: [{ name: 'subject', type: 'reference' }, { name: 'patient', type: 'reference' }, { name: 'code', type: 'token' }] }] }] });

test('concurrent fhir_page on one unloaded cursor never skips a page or re-points the cursor', async () => {
  const patient = 'synthetic-a';
  const obs = (id: string) => ({ resourceType: 'Observation', id, status: 'final', subject: { reference: `Patient/${patient}` }, code: { text: 'A1c' } });
  const pages = [[obs('synthetic-p1')], [obs('synthetic-p2')], [obs('synthetic-p3')], [obs('synthetic-p4')]];
  const log: string[] = [];
  let base = '', metadataSeen = 0, release = (): void => undefined, held = Promise.resolve();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, base);
    res.setHeader('content-type', 'application/fhir+json');
    if (url.pathname.endsWith('/metadata')) {
      metadataSeen++; log.push('metadata');
      // The third refresh (the second waiter's) completes only after one waiter has rendered its page.
      if (metadataSeen >= 3) await held;
      res.end(capabilityStatement); return;
    }
    const index = Number(url.searchParams.get('_offset') ?? 0); log.push(`page${index + 1}`);
    const next = new URL(url); next.searchParams.set('_offset', String(index + 1));
    res.end(JSON.stringify({ resourceType: 'Bundle', type: 'searchset', link: [{ relation: 'self', url: url.href }, ...(index + 1 < pages.length ? [{ relation: 'next', url: next.href }] : [])],
      entry: (pages[index] ?? []).map(resource => ({ search: { mode: 'match' }, resource })) }));
  });
  await new Promise<void>(listening => server.listen(0, '127.0.0.1', listening));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/fhir/`;
  try {
    for (const era of ['modern', 'legacy'] as const) {
      log.length = 0; metadataSeen = 0; held = new Promise<void>(resolve => { release = resolve; });
      const gateway = new FhirGateway({ mode: 'synthetic', source: { alias: 'race', baseUrl: base }, patientId: patient, discovery: { metadataTtlMs: 1 } } as never);
      try {
        const out = { format: 'fhir', max_bytes: 24576 } as const;
        const ids = (e: any): string => e.error ? `ERROR:${e.error.code}` : e.data.resources.map((r: any) => r.id).join(',');
        const first: any = await gateway.execute('fhir_search', { resource_type: 'Observation', page_size: 1, output: out }, { era });
        assert.equal(ids(first), 'synthetic-p1');
        const cursor = first.pagination.next_cursor;
        const w1 = gateway.execute('fhir_page', { cursor, output: out }, { era });
        const w2 = gateway.execute('fhir_page', { cursor, output: out }, { era });
        await Promise.race([w1, w2]); release();
        const [a, b]: any[] = await Promise.all([w1, w2]);
        const again: any = await gateway.execute('fhir_page', { cursor, output: out }, { era });
        assert.equal(ids(a), 'synthetic-p2', `${era}: first waiter`);
        assert.equal(ids(b), 'synthetic-p2', `${era}: second waiter must render the page the first flight loaded`);
        assert.equal(ids(again), 'synthetic-p2', `${era}: the cursor still points at page 2`);
        assert.ok(!log.includes('page3'), `${era}: no page was skipped (upstream: ${log.join(',')})`);
      } finally { gateway.close(); }
    }
  } finally { server.closeAllConnections(); server.close(); }
});

const freeze = <T>(value: T): T => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
function captureFor(envelope: any, invocation: any) {
  const render = () => ({ ...toMcpToolResult02(envelope), ...(invocation.era === 'modern' ? { resultType: 'complete', _meta: { 'io.modelcontextprotocol/serverInfo': invocation.serverIdentity } } : {}) });
  for (let i = 0; i < 8; i++) envelope.budget.bytes_returned = Buffer.byteLength(JSON.stringify(render()));
  const result = render();
  return freeze({ ...invocation, result, renderedText: result.content[0]!.text });
}
const stripCaveat = (e: any): void => {
  e.coverage.reasons = e.coverage.reasons.filter((x: string) => x !== 'FILTER_EXECUTION_UNVERIFIED');
  e.warnings = e.warnings.filter((w: any) => w.code !== 'FILTER_EXECUTION_UNVERIFIED');
};

test('the trusted proof binds completeness and evidence kind on an empty material set and on shorthand pages', async () => {
  for (const era of ['modern', 'legacy'] as const) {
    // Unconfined shared-type search, drained: trusted proof is empty, so it can never be complete or exact.
    await withGateway({ pages: [[{ resourceType: 'Organization', id: 'synthetic-directory', active: true, name: 'Synthetic directory' }]] }, gateway => withSdk(gateway, era, async sdk => {
      const r: any = await sdk.call('fhir_search', { resource_type: 'Organization', output });
      assert.equal(r.e.error, undefined); assert.deepEqual(r.capture.query?.constraintProof, []);
      assert.deepEqual(validateDeliverable02('fhir_search', r.e, r.capture), { ok: true }, `${era}: valid control`);
      const forged = structuredClone(r.e); forged.coverage.state = 'complete_for_query'; forged.coverage.query_evidence = 'exact_id_and_subject_linkage';
      const capture = captureFor(forged, r.capture);
      assert.deepEqual(validateCrossField02('fhir_search', forged, capture), { ok: false, reason: 'INVALID_CROSS_FIELDS' }, `${era}: empty proof cannot be complete`);
      assert.equal(validateDeliverable02('fhir_search', forged, capture).ok, false);
    }));
    // Shorthand continuation whose trusted proof contains an unknown execution.
    await withGateway({ pages: [[lab('synthetic-a1'), lab('synthetic-a2')]] }, gateway => withSdk(gateway, era, async sdk => {
      const first: any = await sdk.call('fhir_search', { resource_type: 'Observation', params: [{ name: 'code', value: 'http://loinc.org|4548-4' }], page_size: 1, output });
      const page: any = await sdk.call('fhir_page', { cursor: first.e.pagination.next_cursor, output });
      assert.equal(page.e.coverage.constraints_on_first_page, true, `${era}: shorthand control`);
      assert.ok(page.capture.query?.constraintProof?.some((p: any) => p.execution === 'unknown'));
      assert.deepEqual(validateDeliverable02('fhir_page', page.e, page.capture), { ok: true }, `${era}: valid shorthand control`);
      for (const kind of ['tested_adapter', 'exact_id_and_subject_linkage'] as const) {
        const forged = structuredClone(page.e); forged.coverage.query_evidence = kind; stripCaveat(forged);
        const capture = captureFor(forged, page.capture);
        assert.equal(validateCrossField02('fhir_page', forged, capture).ok, false, `${era}: shorthand page cannot claim ${kind} against an unknown proof`);
        // With the caveat kept, only the kind rules themselves can reject the claim.
        const kept = structuredClone(page.e); kept.coverage.query_evidence = kind;
        assert.deepEqual(validateCrossField02('fhir_page', kept, captureFor(kept, page.capture)), { ok: false, reason: 'INVALID_CROSS_FIELDS' }, `${era}: ${kind} is bound to the trusted proof even with the caveat present`);
      }
      // Full-evidence first page: dropping only the caveat while the proof says unknown is rejected.
      const caveatless = structuredClone(first.e); stripCaveat(caveatless);
      assert.equal(validateCrossField02('fhir_search', caveatless, captureFor(caveatless, first.capture)).ok, false, `${era}: the unverified-filter caveat is bound to the proof`);
      assert.deepEqual(validateDeliverable02('fhir_search', first.e, first.capture), { ok: true }, `${era}: unmodified first page stays valid`);
    }));
  }
});

test('a refused best-effort res_ retention restores the evictions it made (no futile eviction of a pinned result)', async () => {
  for (const era of ['modern', 'legacy'] as const) {
    const small = [lab('synthetic-s1'), lab('synthetic-s2')];
    const big = Array.from({ length: 3 }, (_, i) => lab(`synthetic-b${i}`, { note: [{ text: 'y'.repeat(3000) }] }));
    await withGateway({ pages: [small], limits: { retentionBytes: 14000 } }, async (gateway: any) => {
      const o = { format: 'fhir', max_bytes: 24576 } as const;
      const a: any = await gateway.execute('fhir_search', { resource_type: 'Observation', page_size: 1, output: o }, { era });
      assert.ok(a.result?.handle && a.pagination?.next_cursor, `${era}: result A is retained and its cursor is live`);
      const bytesBefore = gateway.store.usedBytes();
      const original = gateway.transport.get.bind(gateway.transport);
      gateway.transport.get = async (url: URL, stats: unknown, budget: unknown) => {
        const body: any = await original(url, stats, budget);
        if (url.searchParams.get('code')) body.entry = big.map(resource => ({ search: { mode: 'match' }, resource }));
        return body;
      };
      const b: any = await gateway.execute('fhir_search', { resource_type: 'Observation', params: [{ name: 'code', value: 'http://loinc.org|4548-4' }], output: { format: 'fhir', max_bytes: 131072 } }, { era });
      assert.equal(b.error, undefined, `${era}: search B succeeds`);
      assert.ok(b.warnings.some((w: any) => w.code === 'RESULT_NOT_RETAINED'), `${era}: B's result could not be retained`);
      const inspectA: any = await gateway.execute('fhir_result', { handle: a.result.handle, action: 'inspect', output: o }, { era });
      assert.equal(inspectA.error, undefined, `${era}: result A survives B's refused retention (got ${inspectA.error?.code})`);
      assert.equal(gateway.store.usedBytes(), bytesBefore, `${era}: the refused admission left retention bytes unchanged`);
    });
  }
});

test('selecting into a contained resource keeps that contained evidence whole', () => {
  const specimen = { resourceType: 'Specimen', id: 'sp1', meta: { versionId: '3', security: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-Confidentiality', code: 'R' }], tag: [{ code: 'SUBSETTED' }] }, type: { text: 'blood' } };
  const projected = projectSanitized({
    resource: { resourceType: 'Observation', id: 'synthetic-o1', status: 'final', contained: [specimen], specimen: { reference: '#sp1' } } as SanitizedProjectionRecord['resource'],
    retrievedAt: '2026-10-22T00:00:00Z', policyOmitted: [], withheldReasons: [], requiresStructuralView: false,
  }, 'fhir', ['contained.meta.security.code']);
  assert.deepEqual((projected.resource as any).contained, [specimen], 'the contained resource is delivered whole, security system and version included');
  assert.ok(!projected.meta.omitted_fields.some(path => path.startsWith('/contained')), `no contained omission: ${projected.meta.omitted_fields.join(', ')}`);
});
