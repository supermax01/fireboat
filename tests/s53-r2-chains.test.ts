// Real 0.1 snapshots from a loopback synthetic source,
// assembled by the inert v2 coverageV2, then wrapped by envelopeV2 and checked against the S5.1
// strict gate under a correct trusted context.
import assert from 'node:assert/strict';
import test from 'node:test';

import { withSource, gate } from './s53-r2-helpers.js';
// N-1: middle page of a >=3 page chain. Spec line 640: query_exhausted is false with a valid advertised next page.
for (const opaque of [false, true]) test(`N-1 middle continuation page with a valid next link (${opaque ? '_getpages' : '_offset'}): exhausted must be false and the gate must pass`, async () => {
  await withSource({ pages: 3, opaque }, async (g, c) => {
    const first = await g.execute('fhir_search', { resource_type: 'Observation', output: { format: 'fhir' } });
    assert.equal(first.error, undefined);
    const firstSnap = c.last();
    const g1 = gate(c, 'fhir_search', firstSnap, { tool: 'fhir_search', deliveredCount: 0, filtered: false }, first.data.resources as unknown[], { has_more: true, next_cursor: 'cur_next' });
    const cursor = first.pagination!.next_cursor!;
    const second = await g.execute('fhir_page', { cursor, output: { format: 'fhir' } });
    assert.equal(second.error, undefined);
    assert.ok(second.pagination!.next_cursor, 'page 2 has a next cursor');
    const snap = c.last();
    const g2 = gate(c, 'fhir_page', snap, { tool: 'fhir_page', deliveredCount: (second.data.resources as unknown[]).length, filtered: false, previousEvidence: g1.r.evidence }, second.data.resources as unknown[], { has_more: true, next_cursor: 'cur_next2' });
    assert.equal(g2.r.coverage.query_exhausted, false, 'middle page with a valid next link must be known-unexhausted (spec 640)');
    assert.deepEqual(g2.result, { ok: true });
  });
});

// N-4: benign SOURCE_OUTCOME on a zero-result filtered query: assembler NO_MATCHES vs S5.1 gate.
test('N-4 zero-result filtered query + benign informational OperationOutcome: NO_MATCHES must be gate-compatible', async () => {
  const outcome = () => ({ resourceType: 'OperationOutcome', issue: [{ severity: 'information', code: 'informational', diagnostics: 'index warm' }] });
  await withSource({ pages: 1, profile: true, perPage: [0], outcome }, async (g, c) => {
    const params = [{ name: 'code', value: 'http://loinc.org|4548-4' }];
    const first = await g.execute('fhir_search', { resource_type: 'Observation', params, output: { format: 'fhir' } });
    assert.equal(first.error, undefined, JSON.stringify(first.error));
    const snap = c.last();
    const x = gate(c, 'fhir_search', snap, { tool: 'fhir_search', deliveredCount: 0, filtered: true }, [], { has_more: false }, { chainDeliveredCount: 0 });
    assert.equal(x.r.warnings.some((w: any) => w.code === 'NO_MATCHES'), false);
    assert.deepEqual(x.result, { ok: true });
  });
});

// N-5: _id filter on a non-Patient type: assembler "filtered" vs gate "filtered".
test('N-5 Observation _id filter zero result: assembler/gate filtered agreement', async () => {
  await withSource({ pages: 1, perPage: [0] }, async (g, c) => {
    const first = await g.execute('fhir_search', { resource_type: 'Observation', params: [{ name: '_id', value: 'synthetic-zzz' }], output: { format: 'fhir' } });
    assert.equal(first.error, undefined);
    const snap = c.last();
    const x = gate(c, 'fhir_search', snap, { tool: 'fhir_search', deliveredCount: 0, filtered: true }, [], { has_more: false }, { chainDeliveredCount: 0 });
    assert.equal(x.r.warnings.some((w: any) => w.code === 'NO_MATCHES'), false);
    assert.deepEqual(x.result, { ok: true });
  });
});

// N-6: local remainder delivered from an upstream continuation snapshot.
test('N-6 local remainder sliced from an upstream continuation page: exhausted must be false (cursor exists)', async () => {
  await withSource({ pages: 2, perPage: [1, 5] }, async (g, c) => {
    const first = await g.execute('fhir_search', { resource_type: 'Observation', page_size: 2, output: { format: 'fhir' } });
    assert.equal(first.error, undefined);
    const cursor = first.pagination!.next_cursor!;
    const second = await g.execute('fhir_page', { cursor, output: { format: 'fhir', max_bytes: 5000 } });
    assert.equal(second.error, undefined); assert.ok(second.pagination?.next_cursor);
    const snap = c.last();
    const x = gate(c, 'fhir_page', snap, { tool: 'fhir_page', deliveredCount: (second.data.resources as unknown[]).length, filtered: false, localRemainder: true }, second.data.resources as unknown[], { has_more: true, next_cursor: 'cur_local' });
    assert.equal(x.r.coverage.query_exhausted, false);
    assert.deepEqual(x.result, { ok: true });
  });
  // A rejected upstream link does not erase a locally retained next slice.
  await withSource({ pages: 2, perPage: [6], nextHost: 'example.invalid' }, async (g, c) => {
    const response = await g.execute('fhir_search', { resource_type: 'Observation', output: { format: 'fhir', max_bytes: 5000 } });
    assert.equal(response.error, undefined); assert.ok(response.pagination?.next_cursor);
    assert.equal(c.last().nonContinuable, true);
    const x = gate(c, 'fhir_search', c.last(), { tool: 'fhir_search', deliveredCount: (response.data.resources as unknown[]).length, localRemainder: true }, response.data.resources as unknown[], { has_more: true, next_cursor: 'cur_local' });
    assert.equal(x.r.coverage.query_exhausted, false);
    assert.deepEqual(x.result, { ok: true });
  });
});

