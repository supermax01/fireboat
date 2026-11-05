import assert from 'node:assert/strict';
import test from 'node:test';
import { ResultStore, RetentionLedger } from '../packages/core/src/store.js';
import { validateCrossField02, validateDeliverable02, toMcpToolResult02, type ValidationContext02 } from '../packages/core/src/contracts.js';
import { withGateway, withSdk, lab, output, hba1c } from './s57-sdk-helpers.js';

const freeze = <T>(value: T): T => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
// Construction counterexamples supply a freshly measured immutable result,
// keeping the independently observed invocation/proof. Snapshot inequality
// must not be the reason an invented execution proof is rejected.
function captureFor(envelope: any, invocation: ValidationContext02): ValidationContext02 {
  const render = () => ({ ...toMcpToolResult02(envelope), ...(invocation.era === 'modern'
    ? { resultType: 'complete', _meta: { 'io.modelcontextprotocol/serverInfo': invocation.serverIdentity } } : {}) });
  for (let i = 0; i < 8; i++) envelope.budget.bytes_returned = Buffer.byteLength(JSON.stringify(render()));
  const result = render();
  return freeze({ ...invocation, result, renderedText: result.content[0]!.text }) as ValidationContext02;
}

for (const era of ['modern', 'legacy'] as const) {
  for (const format of ['fhir', 'compact'] as const) test(`S57fix S5H-01 ${era}/${format} nested and full meta preserve the supplement on every serving surface`, async () => {
    const meta = { versionId: '7', _versionId: { id: 'version-companion' },
      profile: ['http://example.test/lab'], _profile: [{ id: 'profile-companion' }],
      security: [{ system: 'http://example.test/security', _system: { id: 'system-companion' }, code: 'R', display: 'Restricted' }],
      tag: [{ system: 'http://example.test/tags', code: 'ordinary', display: 'Ordinary' },
        { system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationValue', code: 'SUBSETTED', _code: { id: 'tag-companion' }, display: 'Subsetted' }],
      source: 'urn:synthetic:source', lastUpdated: '2026-10-19T00:00:00Z' };
    const record = lab('synthetic-meta', { meta });
    await withGateway({ pages: [[record], [record]], records: [record] }, g => withSdk(g, era, async sdk => {
      for (const fields of [['meta.security.code', 'meta.tag.display'], ['meta', 'status'], ['status']]) {
        const selected = { format, fields, max_bytes: 24576 };
        const read = await sdk.call('fhir_read', { resource_type: 'Observation', id: record.id, output: selected });
        const search = await sdk.call('fhir_search', { resource_type: 'Observation', page_size: 1, output: selected });
        const page = await sdk.call('fhir_page', { cursor: search.e.pagination.next_cursor, output: selected });
        const retained = await sdk.call('fhir_result', { handle: read.e.result.handle, action: 'project', output: selected });
        for (const { e } of [read, search, page, retained]) {
          assert.equal(e.error, undefined);
          const delivered = e.data.resources[0].meta;
          for (const key of ['versionId', '_versionId', 'profile', '_profile', 'security'] as const) assert.deepEqual(delivered[key], meta[key], key);
          assert.deepEqual(delivered.tag.find((tag: any) => tag.code === 'SUBSETTED'), meta.tag[1]);
          if (fields.includes('meta')) assert.deepEqual(delivered, meta);
          else {
            assert.ok(e.transform.omitted_fields.includes('/meta/source'));
            assert.ok(e.transform.omitted_fields.includes('/meta/lastUpdated'));
            if (fields.includes('meta.tag.display')) {
              assert.equal(delivered.tag[0].display, 'Ordinary');
              assert.ok(e.transform.omitted_fields.includes('/meta/tag/code'));
              assert.ok(e.transform.omitted_fields.includes('/meta/tag/system'));
              assert.ok(!e.transform.omitted_fields.includes('/meta/tag/display'));
            }
          }
          assert.ok(!e.transform.omitted_fields.some((path: string) => /\/\d+(?:\/|$)/.test(path)));
          assert.ok(!e.transform.omitted_fields.includes('/meta/security/system'));
          assert.ok(!e.transform.omitted_fields.includes('/meta/versionId'));
        }
      }
    }));
  });

  test(`S57fix S5H-02 ${era} loaded page obeys the shared ledger even when output refuses`, async () => {
    const ceiling = 33000;
    await withGateway({ pages: [[lab()], [lab('synthetic-large', { note: [{ text: 'x'.repeat(25500) }] })]], limits: { retentionBytes: ceiling } },
      (g, requests) => withSdk(g, era, async sdk => {
        const stores = g as any;
        const first = await sdk.call('fhir_search', { resource_type: 'Observation', params: hba1c, page_size: 1, output });
        const metadata = await sdk.call('fhir_capabilities', { topic: 'support', limit: 1, output });
        assert.ok(first.e.pagination.next_cursor); assert.ok(metadata.e.data.next_cursor);
        assert.ok(stores.retentionLedger.usedBytes() < ceiling);
        assert.ok(stores.discoveryStore.usedBytes() > 0);
        const next = await sdk.call('fhir_page', { cursor: first.e.pagination.next_cursor, output: { format: 'fhir', max_bytes: 4096 } });
        assert.equal(next.e.error?.code, 'OUTPUT_LIMIT');
        assert.ok(stores.retentionLedger.usedBytes() <= ceiling, 'output failure cannot leave over-quota loaded state');
        assert.ok(stores.store.get(first.e.pagination.next_cursor), 'live clinical cursor survives');
        assert.equal(stores.discoveryStore.size, 0, 'regenerable discovery evicted to admit clinical load');
        const beforeRetry = requests.length;
        const retry = await sdk.call('fhir_page', { cursor: first.e.pagination.next_cursor, output: { format: 'fhir', max_bytes: 131072 } });
        assert.equal(retry.e.error, undefined); assert.equal(retry.e.data.resources.length, 1);
        assert.equal(requests.length, beforeRetry, 'loaded page was retained without another upstream call');
      }));
  });

  test(`S57fix S5H-03 ${era} full evidence matches trusted current proof, including proof references`, async () => {
    await withGateway({}, g => withSdk(g, era, async sdk => {
      const original = await sdk.call('fhir_search', { resource_type: 'Observation', params: hba1c, output });
      assert.deepEqual(validateDeliverable02('fhir_search', original.e, original.capture), { ok: true });
      for (const kind of ['invented-complete', 'invented-partial', 'reference'] as const) {
        const e = structuredClone(original.e);
        e.coverage.constraints.forEach((c: any) => { c.execution = 'tested_adapter'; c.evidence_ref = 'invented@1'; });
        e.coverage.query_evidence = 'tested_adapter';
        e.coverage.reasons = e.coverage.reasons.filter((reason: string) => reason !== 'FILTER_EXECUTION_UNVERIFIED');
        e.warnings = e.warnings.filter((w: any) => w.code !== 'FILTER_EXECUTION_UNVERIFIED');
        e.coverage.state = kind === 'invented-partial' ? 'partial' : 'complete_for_query';
        const trusted = kind === 'reference' ? freeze({ ...original.capture, query: { ...original.capture.query!,
          constraintProof: original.capture.query!.orderedPairs.map(() => ({ execution: 'tested_adapter', evidence_ref: 'trusted@1' })) } }) : original.capture;
        const capture = captureFor(e, trusted as ValidationContext02);
        assert.deepEqual(validateCrossField02('fhir_search', e, capture), { ok: false, reason: 'INVALID_CROSS_FIELDS' }, kind);
        assert.deepEqual(validateDeliverable02('fhir_search', e, capture), { ok: false, reason: 'INVALID_CROSS_FIELDS' }, kind);
      }
    }));
  });

  test(`S57fix H11 ${era} trusted capture uses downgraded proof on initial and retained output`, async () => {
    await withGateway({ profile: true, outcome: { resourceType: 'OperationOutcome', issue: [{ severity: 'information', code: 'not-supported', expression: ['code'] }] } },
      g => withSdk(g, era, async sdk => {
        const first = await sdk.call('fhir_search', { resource_type: 'Observation', params: [{ name: 'code', value: 'http://loinc.org|4548-4' }], output });
        const retained = await sdk.call('fhir_result', { handle: first.e.result.handle, action: 'project', output });
        for (const { e, capture } of [first, retained]) {
          assert.equal(e.error, undefined);
          const index = capture.query!.orderedPairs.findIndex(pair => pair.name === 'code');
          assert.equal(e.coverage.constraints[index].execution, 'unknown');
          assert.deepEqual(capture.query!.constraintProof![index], { execution: 'unknown' });
          assert.ok(Object.isFrozen(capture.query!.constraintProof));
        }
      }));
  });

  test(`S57fix S57-R02 ${era} syntax repair only names a reviewed base`, async () => {
    await withGateway({ patientParameters: [{ name: 'age', type: 'number' }] }, (g, requests) => withSdk(g, era, async sdk => {
      for (const [resource_type, name, value, code, parameter] of [
        ['Observation', 'code:text', 'x', 'UNSUPPORTED_MODIFIER', 'code'], ['Observation', 'date:missing', 'x', 'UNSUPPORTED_MODIFIER', 'date'],
        ['Patient', 'age', 'ge30', 'UNSUPPORTED_COMPARATOR', 'age'], ['Observation', 'unreviewed:text', 'x', 'UNSUPPORTED_MODIFIER', undefined],
      ] as const) {
        for (const sortFirst of [false, true]) {
          const before = requests.filter(url => !url.pathname.endsWith('/metadata')).length;
          // Sort validation is deferred by the real validator. A preceding
          // invalid sort cannot hide the reviewed base of an earlier fault.
          const params = [...(sortFirst ? [{ name: '_sort', value: 'unreviewed-sort' }] : []), { name, value }];
          const { e } = await sdk.call('fhir_search', { resource_type, params, output });
          assert.equal(e.error?.code, code); assert.equal(e.error?.repair?.parameter, parameter);
          assert.equal(requests.filter(url => !url.pathname.endsWith('/metadata')).length, before);
        }
      }
    }));
  });
}

test('S57fix S5H-02 replacement credits exclusively freed blobs and shared metadata', () => {
  const ledger = new RetentionLedger(430);
  const clinical = new ResultStore<any>(430, 10, 60000, Date.now, { ledger, sharedFields: ['query'] });
  const discovery = new ResultStore<any>(430, 10, 60000, Date.now, { ledger, role: 'discovery', evictableKinds: ['cur'] });
  try {
    const handle = clinical.put('cur', { body: 'a'.repeat(120), query: 'q'.repeat(100) }).handle;
    const metadata = discovery.put('cur', { body: 'm'.repeat(100) }).handle;
    clinical.update(handle, { body: 'b'.repeat(130), query: 'r'.repeat(100) });
    assert.ok(discovery.get(metadata), 'replacement admits net growth without unnecessary metadata eviction');
    assert.ok(ledger.usedBytes() <= ledger.totalBytes);
  } finally { clinical.close(); discovery.close(); }
});

test('S57fix S5H-02 failed replacement restores clinical and discovery evictions atomically', () => {
  const ledger = new RetentionLedger(320);
  const clinical = new ResultStore<any>(320, 10, 60000, Date.now, { ledger });
  const discovery = new ResultStore<any>(320, 10, 60000, Date.now, { ledger, role: 'discovery', evictableKinds: ['cur'] });
  try {
    const target = clinical.put('cur', { body: 'a'.repeat(30) }).handle;
    const other = clinical.put('cur', { body: 'b'.repeat(180) }).handle;
    const bestEffort = clinical.put('res', { body: 'c'.repeat(15) }).handle;
    const metadata = discovery.put('cur', { body: 'm'.repeat(30) }).handle;
    const before = ledger.usedBytes();
    assert.throws(() => clinical.update(target, { body: 'd'.repeat(200) }), { code: 'RETENTION_LIMIT' });
    assert.equal(ledger.usedBytes(), before);
    for (const h of [target, other, bestEffort]) assert.ok(clinical.get(h));
    assert.ok(discovery.get(metadata));
    const install = (clinical as any).install.bind(clinical);
    (clinical as any).install = () => { throw new Error('synthetic replacement failure'); };
    assert.throws(() => clinical.update(target, { body: 'e'.repeat(115) }), /synthetic replacement failure/);
    (clinical as any).install = install;
    assert.equal(ledger.usedBytes(), before);
    for (const h of [target, other, bestEffort]) assert.ok(clinical.get(h));
    assert.ok(discovery.get(metadata));
  } finally { clinical.close(); discovery.close(); }
});
