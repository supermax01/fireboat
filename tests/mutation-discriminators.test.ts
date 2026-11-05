// These cases isolate guards whose original fixtures are masked by later checks.
// Direct controls retain the original contract boundary and name its mutant.
import assert from 'node:assert/strict';
import test from 'node:test';
import { validateCrossField02, type GatewayEnvelope02 } from '../packages/core/src/contracts.js';
import { scanObservedCodes, type ScanClient, type ScanOptions } from '../examples/observed-code-scan.js';
import { withGateway } from './s57-sdk-helpers.js';
import { SERVER_IDENTITY } from '../packages/core/src/identity.js';
import { listedSearchParameters } from '../packages/core/src/discovery.js';

// kills: g5-custom-name-echo
test('mutation discriminator: listed search names exclude source-only tokens and preserve reviewed names', () => {
  assert.deepEqual(listedSearchParameters('Observation', [
    { name: 'code', type: 'token', source_description_present: false },
    { name: 'synthetic-vendor-field', type: 'string', source_description_present: false },
  ]), { names: ['code'], withheldCount: 1 });
});

function oversizeRead(): GatewayEnvelope02 {
  return {
    schema_version: '0.3', request_id: 'req_mutation_control',
    source: { alias: 'local', fhir_version: '4.0.1', capability_revision: 'cap-v1' },
    context: { handle: 'ctx_mutation_control', mode: 'patient-bound', policy_revision: 'policy-v1' },
    data: { resources: [], manifest: { reason: 'RESOURCE_EXCEEDS_INLINE_BUDGET', action: 'Retry with fewer selected fields.' } },
    provenance: [], pagination: { has_more: false, returned_matches: 0, returned_includes: 0 },
    coverage: { state: 'partial', scope: 'resource', reasons: ['CLINICAL_RECORD_COMPLETENESS_UNKNOWN', 'OVERSIZED_RESOURCE'],
      authorization_limited: true, query_exhausted: null, pages_observed: 1, query_evidence: 'exact_id_and_subject_linkage' },
    transform: { format: 'fhir', projected: false, withheld_payloads: [], omitted_fields: [], unresolved_fields: [],
      narrative_omitted: false, recipe_ids: [], structural_resource_indices: [], delivery_profile: 'full-text-v1' },
    warnings: [], budget: { bytes_returned: 0, byte_limit: 24576, limit_reached: false, upstream_calls: 1, elapsed_ms: 0 },
  };
}

// kills: S51-M02-delivery-loss
test('mutation discriminator: a non-retained oversize read remains partial even with otherwise complete coverage', () => {
  const valid = oversizeRead();
  assert.deepEqual(validateCrossField02('fhir_read', valid), { ok: true });
  const falseComplete = structuredClone(valid);
  falseComplete.coverage.state = 'complete_for_query';
  falseComplete.coverage.query_exhausted = true;
  assert.deepEqual(validateCrossField02('fhir_read', falseComplete), { ok: false, reason: 'INVALID_CROSS_FIELDS' });
});

// kills: C53-M05-scan-post-upstream-overrun
test('mutation discriminator: absolute scan budget survives a driver bound change after reservation', async () => {
  const options: ScanOptions = {
    resourceType: 'Observation',
    trustedBinding: { source: 'local', contextHandle: 'ctx_mutation_control', selector: { name: 'subject', value: 'Patient/synthetic-control' } },
    dateWindow: [{ name: 'date', value: 'ge2020-01-01' }],
  };
  for (const clinicalWork of [1, 20]) {
    let calls = 0, work = 0;
    const client: ScanClient = {
      upstreamWork: { total: () => work, maxPerCall: 1 },
      callTool: async () => {
        calls++;
        work += calls === 1 ? 1 : clinicalWork;
        // The mutable driver changes its claim after the reservation. Its new
        // claim must never override the task's independent absolute budget.
        if (calls === 2) client.upstreamWork.maxPerCall = clinicalWork;
        return { structuredContent: {
          schema_version: '0.3', source: { alias: 'local' }, context: { handle: 'ctx_mutation_control' },
          data: calls === 1 ? { search_parameters: [{ name: 'code', type: 'token', definition_evidence: 'pinned_r4' }] } : { resources: [] },
          coverage: { state: 'unknown', reasons: [], query_exhausted: true }, pagination: { has_more: false },
        } };
      },
    };
    const report = await scanObservedCodes(client, options);
    assert.equal(calls, 2);
    assert.equal(report.upstreamCalls, 1 + clinicalWork);
    if (clinicalWork === 1) assert.equal(report.status, 'chain_exhausted');
    else {
      assert.equal(report.status, 'partial');
      assert.equal(report.code, 'SCAN_LIMIT_REACHED');
      assert.equal(report.requery, undefined);
    }
  }
});

// kills: FIX-F10-zero-work-reserve
test('mutation discriminator: a zero-work reservation is refused before any client call', async () => {
  for (const maxPerCall of [0, 1]) {
    let calls = 0;
    const client: ScanClient = {
      upstreamWork: { total: () => calls, maxPerCall },
      callTool: async () => {
        calls++;
        return { structuredContent: {
          schema_version: '0.3', source: { alias: 'local' }, context: { handle: 'ctx_mutation_control' },
          data: calls === 1 ? { search_parameters: [{ name: 'code', type: 'token', definition_evidence: 'pinned_r4' }] } : { resources: [] },
          coverage: { state: 'unknown', reasons: [], query_exhausted: true }, pagination: { has_more: false },
        } };
      },
    };
    const report = await scanObservedCodes(client, {
      resourceType: 'Observation',
      trustedBinding: { source: 'local', contextHandle: 'ctx_mutation_control', selector: { name: 'subject', value: 'Patient/synthetic-control' } },
      dateWindow: [{ name: 'date', value: 'ge2020-01-01' }],
    });
    if (maxPerCall === 0) {
      assert.equal(calls, 0);
      assert.equal(report.upstreamCalls, 0);
      assert.equal(report.code, 'SCAN_REFUSED');
    } else {
      assert.equal(calls, 2);
      assert.equal(report.status, 'chain_exhausted');
    }
  }
});

// kills: FIX-F11-refused-label
test('mutation discriminator: malformed terminal exhaustion is a refusal without a false scan-limit claim', async () => {
  for (const exhausted of [true, false]) {
    let calls = 0;
    const client: ScanClient = {
      upstreamWork: { total: () => calls, maxPerCall: 1 },
      callTool: async () => {
        calls++;
        return { structuredContent: {
          schema_version: '0.3', source: { alias: 'local' }, context: { handle: 'ctx_mutation_control' },
          data: calls === 1 ? { search_parameters: [{ name: 'code', type: 'token', definition_evidence: 'pinned_r4' }] } : { resources: [] },
          coverage: { state: 'unknown', reasons: [], query_exhausted: exhausted }, pagination: { has_more: false },
        } };
      },
    };
    const report = await scanObservedCodes(client, {
      resourceType: 'Observation',
      trustedBinding: { source: 'local', contextHandle: 'ctx_mutation_control', selector: { name: 'subject', value: 'Patient/synthetic-control' } },
      dateWindow: [{ name: 'date', value: 'ge2020-01-01' }],
    });
    assert.equal(calls, 2);
    if (exhausted) assert.equal(report.status, 'chain_exhausted');
    else {
      assert.equal(report.status, 'refused');
      assert.equal(report.code, 'SCAN_REFUSED');
      assert.equal(report.requery, undefined);
    }
  }
});

// kills: R03-post-describe-check
test('mutation discriminator: discovery rejects invalidation immediately after describe before returning its snapshot', async () => {
  await withGateway({}, async gateway => {
    const internal = gateway as any;
    const valid = await internal.capabilitiesV2({ topic: 'support', limit: 1 });
    assert.equal(valid.error, undefined);
    assert.ok(Object.keys(valid.data).length > 0);
    const describe = internal.describeV2.bind(internal);
    let described = false;
    internal.describeV2 = (...args: any[]) => {
      described = true;
      describe(...args);
      internal.invalidateState();
    };
    await assert.rejects(internal.capabilitiesV2({ topic: 'support', limit: 1 }), (error: any) => error.code === 'CONNECTION_REQUIRED');
    assert.equal(described, true);
    assert.equal(internal.discoveryStore.size, 0);
    assert.equal(internal.capabilities, undefined);
  });
});

// kills: identity-ignored
test('mutation discriminator: SDK serialization honors the captured server identity and its default', async () => {
  await withGateway({}, async gateway => {
    const envelope = await gateway.execute('fhir_capabilities', { topic: 'server' });
    assert.equal(envelope.error, undefined);
    const internal = gateway as any;
    const defaults = internal.sdkResultV2(envelope, { era: 'modern', profile: 'full-text-v1', tool: 'fhir_capabilities' });
    assert.deepEqual(defaults._meta['io.modelcontextprotocol/serverInfo'], SERVER_IDENTITY);
    const identity = { name: 'synthetic-captured-identity', version: '0.0.0-synthetic' };
    const captured = internal.sdkResultV2(envelope, { era: 'modern', profile: 'full-text-v1', tool: 'fhir_capabilities', serverIdentity: identity });
    assert.deepEqual(captured._meta['io.modelcontextprotocol/serverInfo'], identity);
  });
});
