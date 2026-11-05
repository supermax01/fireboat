// Explicit opt-in only: this directory is outside npm test's tests/*.test.ts discovery.
// FHIR_MCP_HAPI_BASE_URL=http://127.0.0.1:18091/fhir node --import tsx --test tests/integration/gbackend-hapi-public.test.ts
// Reads the already loaded synthetic source. No loader, transaction, corpus rewrite or container operation.
import assert from 'node:assert/strict';
import test from 'node:test';
import { FhirGateway, type GatewayEnvelope } from '../../packages/core/src/index.js';
import { declaredSearchProfile } from '../../packages/core/src/query.js';
import { ExternalClient, HAPI_IMAGE_DIGEST, censusExternalCorpus, externalCorpus, externalTaskHash, type ExternalIdentity } from '../../packages/evals/src/external.js';
import { EVAL_PATIENT_ID } from '../../packages/evals/src/fixture.js';
import { profileDrift } from '../../packages/evals/src/runner.js';
import { ARM_ORDER } from '../../packages/evals/src/tasks.js';
import { HAPI_PROFILE, HAPI_RECORDED_EVIDENCE, HAPI_WINDOW_PARAMS, assertHapiProfilePins, hapiIntegrationBaseUrl, publicHapiConfig } from '../gbackend-profile-helpers.js';
import { withSdk } from '../s57-sdk-helpers.js';

// Validate the exact value before constructing any client or gateway; malformed values fail, never skip.
const baseUrl = hapiIntegrationBaseUrl(process.env.FHIR_MCP_HAPI_BASE_URL);

function assertPublicEnvelope(gateway: FhirGateway, envelope: GatewayEnvelope): void {
  assert.equal(envelope.error, undefined);
  assert.equal(envelope.source.capability_revision, HAPI_RECORDED_EVIDENCE.capability_revision);
  assert.equal(envelope.source.fhir_version, '4.0.1');
  assert.ok(!envelope.warnings.some(warning => warning.code === 'TEST_QUERY_EVIDENCE'));
  assert.deepEqual(gateway.describeSearchProfile(), { id: HAPI_PROFILE, eligible: true, proving: true, private: false });
}

function memberIds(envelope: GatewayEnvelope): string[] {
  assert.ok(Array.isArray(envelope.data.resources));
  return envelope.data.resources.map(resource => {
    assert.ok(resource && typeof resource === 'object' && typeof (resource as { id?: unknown }).id === 'string');
    return (resource as { id: string }).id;
  });
}

function assertWindowProof(envelope: GatewayEnvelope): void {
  assert.equal(envelope.coverage.query_evidence, 'tested_adapter');
  assert.deepEqual(envelope.coverage.constraints!.filter(pair => pair.name === 'code' || pair.name === 'date'), HAPI_WINDOW_PARAMS.map(pair => ({
    ...pair, source_reported: 'matched', execution: 'tested_adapter', evidence_ref: `${HAPI_PROFILE}@1`,
  })), 'all code and repeated date occurrences are individually proved');
}

test('G-BACKEND qualified public HAPI selection stays narrow in both SDK eras and every output arm', { skip: baseUrl === undefined, timeout: 120_000 }, async t => {
  assert.ok(baseUrl);
  assertHapiProfilePins();
  const corpus = externalCorpus();
  const profile = declaredSearchProfile(HAPI_PROFILE)!;
  const client = new ExternalClient(baseUrl);
  const metadata = await client.request(client.transport.url('metadata'));
  assert.equal(metadata.resourceType, 'CapabilityStatement');
  const software = metadata.software as { name: string; version: string };
  assert.equal(software.name, 'HAPI FHIR Server');
  assert.equal(software.version, '8.12.0');
  assert.equal(metadata.fhirVersion, '4.0.1');
  const discovery = new FhirGateway(publicHapiConfig(baseUrl));
  try {
    const envelope = await discovery.execute('fhir_capabilities', { topic: 'server' });
    assertPublicEnvelope(discovery, envelope);
    const identity: ExternalIdentity = { software: software.name, software_version: software.version, fhir_version: metadata.fhirVersion as string,
      capability_revision: envelope.source.capability_revision, corpus_sha256: corpus.sha256, tasks_sha256: externalTaskHash(),
      // FHIR does not attest a container image. This is the existing operator pin, not a measured claim.
      image_digest: HAPI_IMAGE_DIGEST };
    assert.equal(profileDrift(profile, identity), undefined, 'measured discovery plus pinned corpus/tasks still bind the recorded qualification');
  } finally { discovery.close(); }
  await censusExternalCorpus(client, corpus, true);

  // Confirm the source actually issues an opaque continuation before exercising its SDK-visible honesty labels.
  const probe = client.transport.url('Observation');
  for (const pair of HAPI_WINDOW_PARAMS) probe.searchParams.append(pair.name, pair.value);
  probe.searchParams.append('patient', `Patient/${EVAL_PATIENT_ID}`);
  probe.searchParams.append('_count', '1');
  const page = await client.request(probe);
  assert.equal(page.resourceType, 'Bundle');
  const next = (page.link as { relation: string; url: string }[]).filter(link => link.relation === 'next');
  assert.equal(next.length, 1);
  const nextUrl = client.transport.validate(next[0]!.url);
  assert.ok(nextUrl.searchParams.has('_getpages'), 'the source continuation is genuinely opaque');
  assert.equal(nextUrl.searchParams.has('code'), false);
  assert.equal(nextUrl.searchParams.has('date'), false);

  for (const era of ['modern', 'legacy'] as const) for (const arm of ARM_ORDER) {
    await t.test(`${era}/${arm}`, async () => {
      const gateway = new FhirGateway(publicHapiConfig(baseUrl));
      const output = { format: arm === 'compact' ? 'compact' : 'fhir', max_bytes: 24576,
        ...(arm === 'selected' ? { fields: ['status', 'code', 'subject', 'effectiveDateTime', 'valueQuantity'] } : {}) };
      try {
        await withSdk(gateway, era, async sdk => {
          const search = async (params: { name: string; value: string }[], page_size = 100): Promise<GatewayEnvelope> => {
            const { e } = await sdk.call('fhir_search', { resource_type: 'Observation', params, page_size, output });
            const envelope = e as GatewayEnvelope;
            assertPublicEnvelope(gateway, envelope);
            return envelope;
          };
          const proved = await search(HAPI_WINDOW_PARAMS);
          assertWindowProof(proved);
          assert.equal(proved.coverage.state, 'complete_for_query');
          assert.equal(proved.coverage.query_exhausted, true);
          assert.deepEqual(memberIds(proved).sort(), ['obs-hba1c-1', 'q-match'], 'exact unordered membership includes no extra or duplicate records');

          const sorted = await search([...HAPI_WINDOW_PARAMS, { name: '_sort', value: '-date' }]);
          assertWindowProof(sorted);
          assert.deepEqual(sorted.coverage.sort, { requested: ['-date'], effective: null, evidence: 'unknown', order: 'requested_unverified' });
          // proposals/m3b-spec.md §7 (coverage decision table): sort never changes set completeness.
          assert.equal(sorted.coverage.state, 'complete_for_query');
          assert.equal(sorted.coverage.query_exhausted, true);
          assert.ok(sorted.warnings.some(warning => warning.code === 'ORDER_UNVERIFIED'));
          assert.deepEqual(memberIds(sorted).sort(), ['obs-hba1c-1', 'q-match']);

          for (const value of ['4548-4', '|4548-4']) {
            const systemless = await search([{ name: 'code', value }]);
            assert.equal(systemless.coverage.query_evidence, 'declared_and_self_link_only');
            assert.notEqual(systemless.coverage.state, 'complete_for_query');
            assert.deepEqual(systemless.coverage.constraints!.filter(pair => pair.name === 'code'), [{ name: 'code', value, source_reported: 'matched', execution: 'unknown', evidence_ref: undefined }]);
            assert.ok(!systemless.coverage.constraints!.some(pair => pair.execution === 'tested_adapter'));
          }

          let current = await search(HAPI_WINDOW_PARAMS, 1);
          assertWindowProof(current);
          assert.equal(current.coverage.state, 'partial');
          assert.ok(current.pagination?.next_cursor);
          const ids = memberIds(current);
          let pages = 1;
          while (current.pagination?.next_cursor) {
            assert.ok(pages < 4, 'bounded two-member continuation drain');
            const { e, capture } = await sdk.call('fhir_page', { cursor: current.pagination.next_cursor, output });
            current = e as GatewayEnvelope;
            assertPublicEnvelope(gateway, current);
            assert.equal(current.coverage.query_evidence, 'unverified_continuation');
            assert.equal(current.coverage.state, 'partial');
            assert.equal(current.coverage.query_exhausted, null);
            assert.ok(current.warnings.some(warning => warning.code === 'CONTINUATION_QUERY_UNVERIFIED'));
            assert.equal(capture.query?.continuationUnverified, true);
            ids.push(...memberIds(current)); pages++;
          }
          assert.equal(pages, 2);
          assert.deepEqual(ids.sort(), ['obs-hba1c-1', 'q-match'], 'opaque paging neither drops nor duplicates an observed match');
          assert.equal(current.coverage.query_evidence, 'unverified_continuation', 'draining does not upgrade unproved continuation completeness');
        });
      } finally { gateway.close(); }
    });
  }
  await censusExternalCorpus(new ExternalClient(baseUrl), corpus, true);
});
