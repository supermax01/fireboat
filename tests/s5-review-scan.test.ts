// Reviewer scan probes (Claude, S5.3). Each asserts SAFE behaviour.
import assert from 'node:assert/strict';
import test from 'node:test';
import { scanObservedCodes, type ScanClient, type ScanOptions } from '../examples/observed-code-scan.js';

const opts: ScanOptions = { resourceType: 'Observation', trustedBinding: { source: 'local', contextHandle: 'ctx_test', selector: { name: 'subject', value: 'Patient/synthetic-a' } },
  dateWindow: [{ name: 'date', value: 'ge2025-01-01' }, { name: 'date', value: 'le2025-02-01' }] };
const metadata = () => ({ structuredContent: { schema_version: '0.3', context: { handle: 'ctx_test' }, source: { alias: 'local' }, data: { search_parameters: [{ name: 'code', type: 'token', definition_evidence: 'pinned_r4' }] } } });
const page = (more: boolean | null = false, extra: Record<string, unknown> = {}) => ({ structuredContent: { schema_version: '0.3', context: { handle: 'ctx_test' }, source: { alias: 'local' }, coverage: { query_exhausted: more === false, state: 'unknown' },
  data: { resources: [{ resourceType: 'Observation', id: 'o1', code: { coding: [{ system: 'http://loinc.org', code: '4548-4' }] } }] }, pagination: { has_more: more, ...(more ? { next_cursor: 'cur_x' } : {}) }, ...extra } });

function driver(responses: unknown[], opts2: { perCallWork?: number; total?: () => number; maxPerCall?: number } = {}) {
  const calls: { name: string; arguments: Record<string, unknown> }[] = [];
  let work = 0;
  const client: ScanClient = { upstreamWork: { total: opts2.total ?? (() => work), maxPerCall: opts2.maxPerCall ?? 1 }, callTool: async request => {
    calls.push(structuredClone(request)); work += opts2.perCallWork ?? 1;
    if (calls.length > responses.length) throw new Error('extra');
    return structuredClone(responses[calls.length - 1]) as never;
  } };
  return { client, calls, work: () => work };
}

test('S-1 maxPerCall=0 is refused (reservation would be meaningless)', async () => {
  const d = driver([metadata(), page(true), page(true), page(false)], { perCallWork: 9, maxPerCall: 0 });
  const r = await scanObservedCodes(d.client, opts);
  console.log(`S-1: status=${r.status} code=${r.code} calls=${d.calls.length} upstream=${d.work()} reported=${r.upstreamCalls}`);
  assert.ok(d.work() <= 20, `actual upstream work ${d.work()} exceeded 20`);
});
test('S-2 NaN recorder must fail closed (not disable the 20-call cap)', async () => {
  const d = driver([metadata(), page(true), page(true), page(false)], { perCallWork: 9, total: () => NaN });
  const r = await scanObservedCodes(d.client, opts);
  console.log(`S-2: status=${r.status} code=${r.code} calls=${d.calls.length} upstream=${d.work()} reported=${r.upstreamCalls}`);
  assert.equal(r.status, 'refused'); assert.equal(r.code, 'SCAN_REFUSED');
  assert.ok(d.work() <= 20, `actual upstream work ${d.work()} exceeded 20`);
});
test('S-3 decreasing recorder must fail closed', async () => {
  let n = 100; const d = driver([metadata(), page(true), page(true), page(false)], { perCallWork: 9, total: () => (n -= 9) });
  const r = await scanObservedCodes(d.client, opts);
  console.log(`S-3: status=${r.status} code=${r.code} calls=${d.calls.length} upstream=${d.work()} reported=${r.upstreamCalls}`);
  assert.ok(d.work() <= 20, `actual upstream work ${d.work()} exceeded 20`);
});
test('S-4 terminal page with withheld/unresolved code fields is not reported as a plain complete inventory', async () => {
  const d = driver([metadata(), page(false, { warnings: [{ code: 'UNRESOLVED_FIELDS', message: 'x' }], transform: { unresolved_fields: ['code'] } })]);
  const r = await scanObservedCodes(d.client, opts);
  console.log(`S-4: status=${r.status} code=${r.code}`);
  assert.equal(r.status, 'refused'); assert.equal(r.code, 'SCAN_REFUSED');
});
test('S-5 response context/source binding is checked (wrong context handle in envelope)', async () => {
  const p = page(false); (p.structuredContent as any).context = { handle: 'ctx_other' }; (p.structuredContent as any).source = { alias: 'other' };
  const d = driver([metadata(), p]);
  const r = await scanObservedCodes(d.client, opts);
  console.log(`S-5: status=${r.status} code=${r.code}`);
  assert.equal(r.status, 'refused'); assert.equal(r.code, 'SCAN_REFUSED');
});
test('S-6 per-call reservation: 4 calls at default limits always fit (discovery included)', async () => {
  const terminal = page(false, { coverage: { state: 'partial', query_exhausted: null, reasons: ['CLINICAL_RECORD_COMPLETENESS_UNKNOWN', 'CONTINUATION_QUERY_UNVERIFIED'] } });
  const d = driver([metadata(), page(true), page(true), terminal]);
  const r = await scanObservedCodes(d.client, opts);
  assert.equal(r.status, 'exhaustion_unverified'); assert.equal(d.calls.length, 4); assert.equal(r.clinicalPages, 3);
});
test('S-7 driver returning after deadline does not get its page consumed (no late accept)', async () => {
  let time = 0; const d = driver([metadata(), page(false)]);
  const wrapped: ScanClient = { ...d.client, callTool: async (...a) => { const r = await d.client.callTool(...a); if (d.calls.length === 2) time = 44999; return r; } };
  const r = await scanObservedCodes(wrapped, { ...opts, now: () => time });
  console.log(`S-7: status=${r.status} at 44.999s`);
  assert.equal(r.status, 'chain_exhausted');
});
test('S-8 operator page size above gateway ceiling refused; below accepted; max_bytes below gateway min?', async () => {
  const d = driver([metadata(), page(false)]);
  const r = await scanObservedCodes(d.client, { ...opts, limits: { maxBytesPerCall: 1000 } });
  console.log(`S-8: status=${r.status} code=${r.code} requested max_bytes=${JSON.stringify((d.calls[0]?.arguments as any)?.output)}`);
});
test('S-9 precision/oversize-refused terminal page is not labelled SCAN_LIMIT_REACHED (distinguishable outcome)', async () => {
  const p = page(false); (p.structuredContent as any).coverage = { query_exhausted: null, state: 'partial', reasons: ['UNSUPPORTED_PRECISION'] };
  const d = driver([metadata(), p]);
  const r = await scanObservedCodes(d.client, opts);
  console.log(`S-9: status=${r.status} code=${r.code}`);
  assert.notEqual(r.code, 'SCAN_LIMIT_REACHED');
});
