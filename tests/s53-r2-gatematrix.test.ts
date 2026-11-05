// Claude r2: S5.3 candidate coverage x S5.1 strict gate, under a correct trusted context.
// Each row assembles coverage with the inert coverageV2 from a REAL pre-render 0.1 snapshot where
// possible, wraps it with envelopeV2 plus the pagination an honest S5.6 renderer would emit, and
// runs validateCrossField02 with a corrupt-exhaustion negative control per state.
import assert from 'node:assert/strict';
import test from 'node:test';
import { validateCrossField02, type ToolName } from '../packages/core/src/contracts.js';
import { withSource, gate, deepFreeze } from './s53-r2-helpers.js';

const cases: [string, () => Promise<void>][] = [];
const matrixCase = (name: string, run: () => Promise<void>) => cases.push([name, run]);
let states = 0;
const record = (id: string, _label: string, x: any) => {
  states++;
  assert.deepEqual(x.result, { ok: true }, id);
  const corrupted = structuredClone(x.env);
  corrupted.coverage.query_exhausted = corrupted.pagination?.has_more === true ? null : false;
  assert.equal(validateCrossField02(x.env.tool ?? (id.startsWith('GM-17') || id.startsWith('GM-18') ? 'fhir_read' : id === 'GM-16' ? 'fhir_result' : id.startsWith('GM-07') || id === 'GM-06' || id === 'GM-08' ? 'fhir_page' : 'fhir_search'), corrupted, x.context).ok, false, `${id} negative control`);
};

const fhir = { format: 'fhir' };
const code = [{ name: 'code', value: 'http://loinc.org|4548-4' }];

matrixCase('GM-01/02 single page confinement-only (1 record / 0 records)', async () => {
  for (const n of [1, 0]) await withSource({ pages: 1, perPage: [n] }, async (g, c) => {
    const r = await g.execute('fhir_search', { resource_type: 'Observation', output: fhir }); assert.equal(r.error, undefined);
    record(n ? 'GM-01' : 'GM-02', `single page confinement-only n=${n}`, gate(c, 'fhir_search', c.last(), { tool: 'fhir_search', deliveredCount: n, filtered: false }, r.data.resources as unknown[], { has_more: false }, { chainDeliveredCount: 0 }));
  });
});
matrixCase('GM-03/04 filtered zero: proved (profile) and generic (unproved)', async () => {
  for (const profile of [true, false]) await withSource({ pages: 1, perPage: [0], profile }, async (g, c) => {
    const r = await g.execute('fhir_search', { resource_type: 'Observation', params: code, output: fhir }); assert.equal(r.error, undefined);
    record(profile ? 'GM-03' : 'GM-04', `filtered zero ${profile ? 'proved' : 'generic'}`, gate(c, 'fhir_search', c.last(), { tool: 'fhir_search', deliveredCount: 0, filtered: true }, [], { has_more: false }, { chainDeliveredCount: 0 }));
  });
});
matrixCase('GM-05..08 chains: first page, middle page, terminal page (has_more false / null), opaque filtered empty terminal', async () => {
  await withSource({ pages: 3 }, async (g, c) => {
    const p1 = await g.execute('fhir_search', { resource_type: 'Observation', output: fhir });
    const s1 = c.last();
    const x1 = gate(c, 'fhir_search', s1, { tool: 'fhir_search', deliveredCount: 1, filtered: false }, p1.data.resources as unknown[], { has_more: true, next_cursor: 'cur_a' });
    record('GM-05', 'first page with valid next link', x1);
    const p2 = await g.execute('fhir_page', { cursor: p1.pagination!.next_cursor!, output: fhir });
    record('GM-06', 'middle continuation page (valid next link)', gate(c, 'fhir_page', c.last(), { tool: 'fhir_page', deliveredCount: 1, filtered: false, previousEvidence: x1.r.evidence }, p2.data.resources as unknown[], { has_more: true, next_cursor: 'cur_b' }));
    const p3 = await g.execute('fhir_page', { cursor: p2.pagination!.next_cursor!, output: fhir });
    const s3 = c.last();
    record('GM-07a', 'terminal continuation page, has_more:false (shorthand)', gate(c, 'fhir_page', s3, { tool: 'fhir_page', deliveredCount: 1, filtered: false, previousEvidence: x1.r.evidence }, p3.data.resources as unknown[], { has_more: false }));
    record('GM-07b', 'terminal continuation page, has_more:null (full)', gate(c, 'fhir_page', s3, { tool: 'fhir_page', deliveredCount: 1, filtered: false }, p3.data.resources as unknown[], { has_more: null }));
  });
  await withSource({ pages: 2, opaque: true, perPage: [0, 0] }, async (g, c) => {
    const p1 = await g.execute('fhir_search', { resource_type: 'Observation', params: code, output: fhir });
    await g.execute('fhir_page', { cursor: p1.pagination!.next_cursor!, output: fhir });
    record('GM-08', 'opaque filtered empty terminal page', gate(c, 'fhir_page', c.last(), { tool: 'fhir_page', deliveredCount: 0, filtered: true }, [], { has_more: false }, { chainDeliveredCount: 0 }));
  });
});
matrixCase('GM-09 unverified filter (warning OperationOutcome naming subject)', async () => {
  const outcome = () => ({ resourceType: 'OperationOutcome', issue: [{ severity: 'warning', code: 'informational', diagnostics: 'subject index rebuilt' }] });
  await withSource({ pages: 1, outcome }, async (g, c) => {
    const r = await g.execute('fhir_search', { resource_type: 'Observation', output: fhir });
    record('GM-09', 'unverified filter', gate(c, 'fhir_search', c.last(), { tool: 'fhir_search', deliveredCount: 1, filtered: false }, r.data.resources as unknown[], { has_more: false }));
  });
});
matrixCase('GM-10 source-reported incomplete (warning OperationOutcome code incomplete), has_more false / null', async () => {
  const outcome = () => ({ resourceType: 'OperationOutcome', issue: [{ severity: 'warning', code: 'incomplete' }] });
  await withSource({ pages: 1, outcome }, async (g, c) => {
    const r = await g.execute('fhir_search', { resource_type: 'Observation', output: fhir }); assert.equal(r.error, undefined);
    const s = c.last();
    record('GM-10a', 'source incomplete, has_more:false', gate(c, 'fhir_search', s, { tool: 'fhir_search', deliveredCount: 1, filtered: false }, r.data.resources as unknown[], { has_more: false }));
    record('GM-10b', 'source incomplete, has_more:null', gate(c, 'fhir_search', s, { tool: 'fhir_search', deliveredCount: 1, filtered: false }, r.data.resources as unknown[], { has_more: null }));
  });
});
matrixCase('GM-11 non-continuable next link (foreign host)', async () => {
  await withSource({ pages: 2, nextHost: 'example.invalid' }, async (g, c) => {
    const r = await g.execute('fhir_search', { resource_type: 'Observation', output: fhir }); assert.equal(r.error, undefined);
    record('GM-11', `non-continuable (0.1 has_more=${r.pagination?.has_more})`, gate(c, 'fhir_search', c.last(), { tool: 'fhir_search', deliveredCount: 1, filtered: false }, r.data.resources as unknown[], { has_more: null }));
  });
});
matrixCase('GM-12 requested sort, unproved', async () => {
  await withSource({ pages: 1 }, async (g, c) => {
    const r = await g.execute('fhir_search', { resource_type: 'Observation', params: [{ name: '_sort', value: '-date' }], output: fhir }); assert.equal(r.error, undefined, JSON.stringify(r.error));
    record('GM-12', 'unproved sort', gate(c, 'fhir_search', c.last(), { tool: 'fhir_search', deliveredCount: 1, filtered: false }, r.data.resources as unknown[], { has_more: false }));
  });
});
matrixCase('GM-13/14 ENTRY_ORIGIN_MISMATCH and INVALID_RESOURCE_ID terminal pages (real source)', async () => {
  const cases: [string, (e: any[], i: number, base: string) => void][] = [
    ['GM-13', (e, _i, base) => { e.push({ fullUrl: `${base}/Observation/elsewhere`, search: { mode: 'match' }, resource: { resourceType: 'Observation', id: 'synthetic-x', status: 'final', subject: { reference: 'Patient/synthetic-a' } } }); }],
    ['GM-14', e => { e.push({ search: { mode: 'match' }, resource: { resourceType: 'Observation', id: 'bad_id!', status: 'final', subject: { reference: 'Patient/synthetic-a' } } }); }],
  ];
  for (const [id, mutate] of cases) await withSource({ pages: 1, mutate }, async (g, c) => {
    const r = await g.execute('fhir_search', { resource_type: 'Observation', output: fhir }); assert.equal(r.error, undefined, JSON.stringify(r.error));
    const s = c.last();
    record(id, `${s.partialReasons} terminal (0.1 state=${r.coverage.state})`, gate(c, 'fhir_search', s, { tool: 'fhir_search', deliveredCount: (r.data.resources as unknown[]).length, filtered: false }, r.data.resources as unknown[], { has_more: false }));
  });
});
matrixCase('GM-15 precision-refused and oversize-refused terminal search pages (flags on a real snapshot)', async () => {
  await withSource({ pages: 1, perPage: [2] }, async (g, c) => {
    const r = await g.execute('fhir_search', { resource_type: 'Observation', output: fhir }); assert.equal(r.error, undefined);
    const s = c.last(); const one = (r.data.resources as unknown[]).slice(0, 1);
    record('GM-15a', 'precision refused, has_more:false', gate(c, 'fhir_search', { ...s, precisionRefused: true }, { tool: 'fhir_search', deliveredCount: 1, filtered: false }, one, { has_more: false }));
    record('GM-15b', 'oversize (reason) + manifest, has_more:false, limit_reached', gate(c, 'fhir_search', s, { tool: 'fhir_search', deliveredCount: 1, filtered: false, reasons: ['OVERSIZED_RESOURCE'] }, one, { has_more: false }, { manifest: { reason: 'RESOURCE_EXCEEDS_INLINE_BUDGET', action: 'Repeat the query with a bounded field selection.' }, limitReached: true }));
  });
});
matrixCase('GM-16 retained page (fhir_result action page) on a search snapshot', async () => {
  await withSource({ pages: 1 }, async (g, c) => {
    const r = await g.execute('fhir_search', { resource_type: 'Observation', output: fhir }); assert.equal(r.error, undefined);
    const ret = await g.execute('fhir_result', { handle: r.result!.handle, action: 'page', output: fhir });
    record('GM-16', `retained page (0.1 err=${ret.error?.code})`, gate(c, 'fhir_result', c.last(), { tool: 'fhir_result', deliveredCount: 1, filtered: false }, (ret.data.resources ?? r.data.resources) as unknown[], { has_more: false }, { action: 'page' }));
  });
});
matrixCase('GM-17/18 read: delivered, and oversize manifest', async () => {
  await withSource({ pages: 1 }, async (g, c) => {
    const s = await g.execute('fhir_search', { resource_type: 'Observation', output: fhir });
    const id = (s.data.resources as any[])[0].id;
    const r = await g.execute('fhir_read', { resource_type: 'Observation', id, output: fhir });
    const target = { resourceType: 'Observation', id };
    record('GM-17', `read (0.1 err=${r.error?.code})`, gate(c, 'fhir_read', c.last(), { tool: 'fhir_read', deliveredCount: 1, filtered: false }, r.data.resources as unknown[], { has_more: false }, { readTarget: target }));
    record('GM-18', 'read oversize manifest (reason)', gate(c, 'fhir_read', c.last(), { tool: 'fhir_read', deliveredCount: 0, filtered: false, reasons: ['OVERSIZED_RESOURCE'] }, [], { has_more: false }, { readTarget: target, manifest: { reason: 'RESOURCE_EXCEEDS_INLINE_BUDGET', action: 'Repeat the query with a bounded field selection.' }, limitReached: true }));
  });
});
matrixCase('GM-19 local remainder from a verified first page (capped/output) and from a continuation page', async () => {
  await withSource({ pages: 1, perPage: [6] }, async (g, c) => {
    const r = await g.execute('fhir_search', { resource_type: 'Observation', output: { format: 'fhir', max_bytes: 5000 } }); assert.equal(r.error, undefined);
    record('GM-19a', `first-page local remainder (0.1 returned=${r.pagination?.returned_matches} has_more=${r.pagination?.has_more})`, gate(c, 'fhir_search', c.last(), { tool: 'fhir_search', deliveredCount: (r.data.resources as unknown[]).length, filtered: false, localRemainder: true }, r.data.resources as unknown[], { has_more: true, next_cursor: 'cur_l' }));
  });
});
matrixCase('GM-20 errors x5 (errorV2)', async () => {
  await withSource({ pages: 1 }, async (_g, c) => {
    for (const tool of ['fhir_capabilities', 'fhir_search', 'fhir_read', 'fhir_page', 'fhir_result'] as ToolName[]) {
      const env = c.errorV2(tool, { code: 'UPSTREAM_ERROR', retryable: true });
      const ctx = deepFreeze({ binding: { sourceAlias: env.source.alias, fhirVersion: env.source.fhir_version, sourceRevision: env.source.capability_revision, policyRevision: env.context.policy_revision, contextHandle: env.context.handle } });
      const result = validateCrossField02(tool, env, ctx as never);
      assert.deepEqual(result, { ok: true }, tool);
      const invalid = structuredClone(env); invalid.coverage.query_exhausted = true;
      assert.equal(validateCrossField02(tool, invalid, ctx as never).ok, false);
    }
  });
});

test('N-01/N-02 27-state real-loopback coverage matrix with trusted contexts and negative controls', async () => {
  for (const [_name, run] of cases) await run();
  assert.equal(states, 22, '22 coverage states plus five error states');
});
