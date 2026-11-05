// Bound scan regression fixtures mirror the assembler shapes; the loopback test below also uses assembled envelopes.
import assert from 'node:assert/strict';
import test from 'node:test';
import { scanObservedCodes, type ScanClient, type ScanOptions } from '../examples/observed-code-scan.js';
import { withSource, gate } from './s53-r2-helpers.js';
import { repairForNoMatches } from '../packages/core/src/repairs.js';

const opts: ScanOptions = { resourceType: 'Observation', trustedBinding: { source: 'local', contextHandle: 'ctx_test', selector: { name: 'subject', value: 'Patient/synthetic-a' } },
  dateWindow: [{ name: 'date', value: 'ge2025-01-01' }, { name: 'date', value: 'le2025-02-01' }] };
const bound = { context: { handle: 'ctx_test' }, source: { alias: 'local' } };
const metadata = () => ({ structuredContent: { schema_version: '0.3', ...bound, data: { search_parameters: [{ name: 'code', type: 'token', definition_evidence: 'pinned_r4' }] } } });
/** Realistic v2 page shapes as the FIXED assembler produces them. */
const page = (kind: 'first-more' | 'middle' | 'terminal-continuation' | 'terminal-single' | 'noncontinuable', type = 'Observation', code = '4548-4') => {
  const coverage = kind === 'first-more' ? { state: 'partial', query_exhausted: false, reasons: ['CLINICAL_RECORD_COMPLETENESS_UNKNOWN', 'MORE_PAGES'] }
    : kind === 'middle' ? { state: 'partial', query_exhausted: false, reasons: ['CLINICAL_RECORD_COMPLETENESS_UNKNOWN', 'MORE_PAGES'] }
    : kind === 'terminal-continuation' ? { state: 'partial', query_exhausted: null, reasons: ['CLINICAL_RECORD_COMPLETENESS_UNKNOWN', 'CONTINUATION_QUERY_UNVERIFIED'] }
    : kind === 'noncontinuable' ? { state: 'partial', query_exhausted: null, reasons: ['CLINICAL_RECORD_COMPLETENESS_UNKNOWN', 'NON_CONTINUABLE_UPSTREAM_LINK'] }
    : { state: 'unknown', query_exhausted: true, reasons: ['CLINICAL_RECORD_COMPLETENESS_UNKNOWN', 'FILTER_EXECUTION_UNVERIFIED'] };
  const more = kind === 'first-more' || kind === 'middle';
  return { structuredContent: { schema_version: '0.3', ...bound, coverage, transform: { unresolved_fields: [], withheld_payloads: [] },
    data: { resources: [{ resourceType: type, id: `o-${kind}`, code: { coding: [{ system: 'http://loinc.org', code }] } }] },
    pagination: { has_more: kind === 'noncontinuable' ? null : more, ...(more ? { next_cursor: 'cur_x' } : {}) } } };
};
function driver(responses: unknown[], o: { perCallWork?: number; total?: (calls: number) => number; maxPerCall?: number } = {}) {
  const calls: { name: string; arguments: Record<string, unknown> }[] = [];
  let work = 0;
  const client: ScanClient = { upstreamWork: { total: () => (o.total ? o.total(calls.length) : work), maxPerCall: o.maxPerCall ?? 1 }, callTool: async request => {
    calls.push(structuredClone(request)); work += o.perCallWork ?? 1;
    if (calls.length > responses.length) throw new Error('extra');
    return structuredClone(responses[calls.length - 1]) as never;
  } };
  return { client, calls, work: () => work };
}
test('SC-1 realistic 3-page chain under the fixed assembler (terminal continuation page has query_exhausted:null)', async () => {
  const d = driver([metadata(), page('first-more'), page('middle', 'Observation', '2345-7'), page('terminal-continuation', 'Observation', '718-7')]);
  const r = await scanObservedCodes(d.client, opts);
  assert.equal(r.status, 'exhaustion_unverified');
  assert.equal(r.code, 'SCAN_EXHAUSTION_UNVERIFIED');
  assert.equal(r.chainExhausted, undefined);
  assert.equal(r.requery, undefined);
  assert.equal(r.observed.length, d.calls.length - 1);
});
test('SC-1b realistic 2-page chain', async () => {
  const d = driver([metadata(), page('first-more'), page('terminal-continuation', 'Observation', '718-7')]);
  const r = await scanObservedCodes(d.client, opts);
  assert.equal(r.status, 'exhaustion_unverified');
  assert.equal(r.code, 'SCAN_EXHAUSTION_UNVERIFIED');
  assert.equal(r.chainExhausted, undefined);
  assert.equal(r.requery, undefined);
  assert.equal(r.observed.length, d.calls.length - 1);
});
test('SC-2 non-continuable next link (has_more:null) is not a scan limit', async () => {
  const d = driver([metadata(), page('noncontinuable')]);
  const r = await scanObservedCodes(d.client, opts);
  assert.notEqual(r.code, 'SCAN_LIMIT_REACHED');
});
test('SC-3 malformed page without pagination is not a scan limit', async () => {
  const p: any = page('terminal-single'); delete p.structuredContent.pagination;
  const d = driver([metadata(), p]);
  const r = await scanObservedCodes(d.client, opts);
  assert.notEqual(r.code, 'SCAN_LIMIT_REACHED');
});
test('SC-4 declared maxPerCall=1 but each call performs 9 upstream calls: actual work must stay <= 20', async () => {
  const d = driver([metadata(), page('first-more'), page('middle'), page('terminal-single')], { perCallWork: 9, maxPerCall: 1 });
  const r = await scanObservedCodes(d.client, opts);
  assert.equal(r.status, 'refused'); assert.equal(r.code, 'SCAN_REFUSED');
  assert.equal(d.calls.length, 1);
  assert.ok(d.work() <= 20, `actual upstream work ${d.work()} > 20`);
});
test('N-09 windowless original gets discovery advice; explicit valid window gets runnable scan advice', async () => {
  const reviewed = { resource: () => true, parameter: () => true } as never;
  const repair = repairForNoMatches('Observation', reviewed);
  assert.equal(repair?.action, 'discover_search_parameter');
  assert.equal(repairForNoMatches('Observation', reviewed, opts.dateWindow)?.action, 'inspect_observed_codes');
  assert.equal(repairForNoMatches('Observation', reviewed, [{ name: 'onset-date', value: 'ge2024-01-01' }])?.action, 'discover_search_parameter');
  const d = driver([metadata(), page('terminal-single')]);
  const r = await scanObservedCodes(d.client, { ...opts, dateWindow: [] });
  assert.equal(r.status, 'refused'); assert.equal(d.calls.length, 0);
  for (const window of [[], opts.dateWindow]) await withSource({ pages: 1, perPage: [0], profile: true }, async (g, c) => {
    const response = await g.execute('fhir_search', { resource_type: 'Observation', params: [{ name: 'code', value: 'http://loinc.org|4548-4' }, ...window] });
    assert.equal(response.error, undefined);
    const x = gate(c, 'fhir_search', c.last(), { tool: 'fhir_search', deliveredCount: 0 }, [], { has_more: false }, { chainDeliveredCount: 0 });
    assert.equal(x.r.warnings.find((w: { code: string }) => w.code === 'NO_MATCHES')?.repair?.action, window.length ? 'inspect_observed_codes' : 'discover_search_parameter');
    assert.deepEqual(x.result, { ok: true });
  });
});
test('N-10 refused terminal page does not report chainExhausted', async () => {
  const p: any = page('terminal-single'); p.structuredContent.transform.unresolved_fields = ['/code'];
  const d = driver([metadata(), p]);
  const r = await scanObservedCodes(d.client, opts);
  assert.equal(r.status, 'refused'); assert.equal(r.chainExhausted, undefined);
});
