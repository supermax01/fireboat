import { SERVER_IDENTITY } from '../packages/core/src/identity.js';
// R2-1/R2-2/R2-8: the strict core gate inside `execute` (Addendum B.1).
// Envelopes are corrupted INSIDE execute via the test-only corruptor seam
// (delivery.ts GatewayTestOptions, never publicly exported) on both the
// success and error paths in both protocol eras. Every corruption must be
// discarded to a fitted INTERNAL_ERROR whose reported bytes equal the bytes
// actually sent, with reserved handles released and no raw canary leaked.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FhirGateway, envelopeV2Schema, validateSpine,
  type GatewayEnvelope,
} from '../packages/core/src/index.js';
import { validateCrossField02, validateDeliverable02 } from '../packages/core/src/contracts.js';
import type { GatewayTestOptions } from '../packages/core/src/delivery.js';
import { startSyntheticFhirServer } from '../examples/synthetic-server.js';

type Rec = Record<string, unknown>;
type Corruptor = NonNullable<GatewayTestOptions['testEnvelopeCorruptor']>;

const storeSize = (gateway: FhirGateway): number => (gateway as unknown as { store: { size: number } }).store.size;

function measuredWireBytes(gateway: FhirGateway, envelope: GatewayEnvelope, era: 'modern' | 'legacy'): number {
  const result = gateway.toToolResult(envelope, { era, profile: gateway.deliveryProfile });
  const sdkExtra = era === 'modern'
    ? { resultType: 'complete', _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_IDENTITY } }
    : {};
  return Buffer.byteLength(JSON.stringify({ ...result, ...sdkExtra }));
}

function assertFittedInternalError(gateway: FhirGateway, envelope: GatewayEnvelope, era: 'modern' | 'legacy', label: string): void {
  assert.equal(envelope.error?.code, 'INTERNAL_ERROR', label);
  const result = gateway.toToolResult(envelope, { era, profile: gateway.deliveryProfile });
  assert.equal(result.isError, true, label);
  assert.equal(validateSpine(result.structuredContent), true, `${label}: delivered spine`);
  assert.equal(envelopeV2Schema.safeParse(result.structuredContent).success, true, `${label}: delivered 0.2`);
  assert.equal(validateCrossField02('fhir_search', result.structuredContent).ok, true, `${label}: delivered strict gate`);
  assert.ok(envelope.budget.bytes_returned <= envelope.budget.byte_limit, `${label}: within limit`);
  assert.equal(envelope.budget.bytes_returned, measuredWireBytes(gateway, envelope, era), `${label}: bytes_returned equals bytes actually sent`);
  assert.ok(!JSON.stringify(envelope).includes('canary'), `${label}: no canary in envelope`);
  assert.ok(!JSON.stringify(result).includes('canary'), `${label}: no canary in tool result`);
  const resources = (envelope.data as Rec).resources;
  assert.ok(resources === undefined || (Array.isArray(resources) && resources.length === 0), `${label}: no clinical resources delivered`);
  assert.equal(gateway.auditEvents.at(-1)?.outcome, 'failed', `${label}: audit failed`);
  assert.equal(gateway.auditEvents.at(-1)?.code, 'INTERNAL_ERROR', label);
}

const gatewayWith = (baseUrl: string, corruptor?: Corruptor): FhirGateway => new FhirGateway(
  { mode: 'synthetic', source: { alias: 'local-synthetic', baseUrl }, patientId: 'synthetic-patient-a' },
  corruptor ? { testEnvelopeCorruptor: corruptor } : undefined,
);

const onlyPhase = (phase: 'success' | 'error', fn: (env: GatewayEnvelope) => void): Corruptor =>
  (env, seen) => { if (seen === phase) fn(env); };

const SUCCESS_CORRUPTIONS: [string, (env: GatewayEnvelope) => void][] = [
  ['schema_version 0.1 on the 0.2 runtime (listed schema passes, strict schema fails)', env => { (env as unknown as Rec).schema_version = '0.1'; }],
  ['bad delivery_profile (strict schema fails)', env => { (env.transform as Rec).delivery_profile = 'slim-canary'; }],
  ['bad coverage state', env => { (env.coverage as Rec).state = 'canary-state'; }],
  ['cursor present with has_more false', env => { env.pagination!.has_more = false; env.pagination!.next_cursor = 'cur_canarycursor'; }],
  ['provenance id does not match delivered resource', env => { env.provenance![0]!.resource_index = 999; }],
  ['provenance version disagrees with delivered meta.versionId', env => { (env.data.resources as Rec[])[0]!.meta = { versionId: 'canary-version' }; }],
  ['duplicate provenance entry', env => { env.provenance![1] = { ...env.provenance![0]! }; }],
  ['returned_matches disagrees with delivered count', env => { env.pagination!.returned_matches = 999; }],
  ['error attached to a resource-bearing envelope', env => { env.error = { code: 'NOT_FOUND', safe_message: 'canary error', retryable: false }; }],
  ['throwing accessor on the internal envelope (R2-8)', env => {
    Object.defineProperty(env, 'coverage', { configurable: true, enumerable: true, get() { throw new Error('canary-accessor'); } });
  }],
];

const ERROR_CORRUPTIONS: [string, (env: GatewayEnvelope) => void][] = [
  ['error plus clinical resources', env => { env.data = { resources: [{ resourceType: 'Observation', id: 'canary-obs' }] }; }],
  ['error plus result handle', env => { env.result = { handle: 'res_canaryhandle0123456789ab', expires_at: '2026-01-01T00:00:00.000Z', formats: ['fhir', 'compact'] }; }],
  ['error plus provenance', env => { env.provenance = [{ resource_index: 0, retrieved_at: '2025-01-01T00:00:00Z' }]; }],
  ['error plus pagination with cursor and has_more false', env => { env.pagination = { has_more: false, next_cursor: 'cur_canarycursor', returned_matches: 0, returned_includes: 0 }; }],
  ['bad coverage state on the error path', env => { (env.coverage as Rec).state = 'canary-state'; }],
];

for (const era of ['modern', 'legacy'] as const) {
  test(`strict gate discards success-path corruptions inside execute (${era}, R2-1/R2-2)`, async () => {
    const synthetic = await startSyntheticFhirServer();
    try {
      // Positive control: the uncorrupted search succeeds and retains a handle.
      const clean = gatewayWith(synthetic.baseUrl);
      try {
        const ok = await clean.execute('fhir_search', { resource_type: 'Observation', output: { max_bytes: 8192 } }, { era });
        assert.equal(ok.error, undefined);
        assert.ok(((ok.data as Rec).resources as unknown[]).length > 1, 'control delivers resources');
        assert.ok(storeSize(clean) > 0, 'control retains handles');
      } finally { clean.close(); }

      for (const [label, corrupt] of SUCCESS_CORRUPTIONS) {
        const gateway = gatewayWith(synthetic.baseUrl, onlyPhase('success', corrupt));
        try {
          const before = storeSize(gateway);
          const envelope = await gateway.execute('fhir_search', { resource_type: 'Observation', output: { max_bytes: 8192 } }, { era });
          assertFittedInternalError(gateway, envelope, era, `${era} success: ${label}`);
          assert.equal(storeSize(gateway), before, `${label}: reserved handles released`);
        } finally { gateway.close(); }
      }
    } finally { await synthetic.close(); }
  });

  test(`strict gate discards error-path corruptions inside execute via the emergency template (${era}, R2-1/R2-2)`, async () => {
    const synthetic = await startSyntheticFhirServer();
    try {
      // Positive control: the uncorrupted fault keeps its own fitted code.
      const clean = gatewayWith(synthetic.baseUrl);
      try {
        const missing = await clean.execute('fhir_read', { resource_type: 'Observation', id: 'does-not-exist-1' }, { era });
        assert.equal(missing.error?.code, 'NOT_FOUND');
      } finally { clean.close(); }

      for (const [label, corrupt] of ERROR_CORRUPTIONS) {
        const gateway = gatewayWith(synthetic.baseUrl, onlyPhase('error', corrupt));
        try {
          const before = storeSize(gateway);
          const envelope = await gateway.execute('fhir_read', { resource_type: 'Observation', id: 'does-not-exist-1' }, { era });
          assertFittedInternalError(gateway, envelope, era, `${era} error: ${label}`);
          assert.equal(storeSize(gateway), before, `${label}: no handle committed`);
        } finally { gateway.close(); }
      }

      // The emergency template also fits the 4,096 B floor in both eras.
      const floor = gatewayWith(synthetic.baseUrl, onlyPhase('error', ERROR_CORRUPTIONS[0]![1]));
      try {
        const envelope = await floor.execute('fhir_read', { resource_type: 'Observation', id: 'does-not-exist-1', output: { max_bytes: 4096 } }, { era });
        assertFittedInternalError(floor, envelope, era, `${era} error floor`);
        assert.ok(envelope.budget.bytes_returned <= 4096, 'emergency fits the byte floor');
      } finally { floor.close(); }
    } finally { await synthetic.close(); }
  });
}

test('direct execute without era uses conservative modern accounting (R2-7)', async () => {
  const synthetic = await startSyntheticFhirServer();
  try {
    const gateway = gatewayWith(synthetic.baseUrl);
    try {
      const envelope = await gateway.execute('fhir_capabilities', { topic: 'context' });
      assert.equal(envelope.error, undefined);
      const modernBytes = measuredWireBytes(gateway, envelope, 'modern');
      const legacyBytes = measuredWireBytes(gateway, envelope, 'legacy');
      assert.ok(modernBytes > legacyBytes, 'modern wire shape is the larger one');
      assert.equal(envelope.budget.bytes_returned, modernBytes, 'no era supplied: modern accounting, never under-reporting');
    } finally { gateway.close(); }
  } finally { await synthetic.close(); }
});

test('emergency template is validated at gateway construction (R2-1)', async () => {
  const synthetic = await startSyntheticFhirServer();
  try {
    assert.throws(
      () => gatewayWith(synthetic.baseUrl, (env, phase) => { if (phase === 'construction') (env.coverage as Rec).state = 'canary-state'; }),
      (error: unknown) => (error as { code?: string }).code === 'INVALID_CONFIG' && /Emergency error template/.test((error as Error).message),
    );
    // Corrupting only execute phases leaves construction (and its template) intact.
    const gateway = gatewayWith(synthetic.baseUrl, onlyPhase('success', env => { (env.coverage as Rec).state = 'canary-state'; }));
    gateway.close();
  } finally { await synthetic.close(); }
});

test('strict v2 gate enforces each migrated R2-2 invariant', async () => {
  const synthetic = await startSyntheticFhirServer();
  const gateway = gatewayWith(synthetic.baseUrl);
  try {
  const valid = await gateway.execute('fhir_search', { resource_type: 'Observation', page_size: 1, output: { format: 'fhir' } });
  assert.equal(valid.error, undefined, 'uncorrupted resource-bearing control');
  const context = (gateway as any).capturesV2.get(valid);
  assert.equal(validateDeliverable02('fhir_search', valid, context).ok, true);
  // The reason names the rejecting layer: INVALID_SHAPE rows are rejected by the Zod spine, VALIDATION_CONTEXT_MISMATCH rows by
  // the frozen capture snapshot, and only INVALID_CROSS_FIELDS rows pin a v2 cross-field rule (S5 review).
  const bad = (label: string, patch: (env: any) => void, reason: 'INVALID_SHAPE' | 'INVALID_CROSS_FIELDS' | 'INVALID_FINAL_BYTES' | 'VALIDATION_CONTEXT_MISMATCH' = 'INVALID_CROSS_FIELDS') => {
    assert.deepEqual(validateDeliverable02('fhir_search', valid, context), { ok: true }, `${label}: valid control`);
    const env: any = structuredClone(valid);
    patch(env);
    assert.deepEqual(validateDeliverable02('fhir_search', env, context), { ok: false, reason }, label);
  };
  bad('error with resources', env => { (env as Rec).error = { code: 'X', safe_message: 'm', retryable: false }; }, 'INVALID_SHAPE');
  bad('error with result handle only', env => { env.data = { resources: [] } as never; env.provenance = []; delete (env as Rec).pagination; (env as Rec).error = { code: 'X', safe_message: 'm', retryable: false }; (env as Rec).result = { handle: 'res_x', expires_at: '2026-01-01T00:00:00.000Z', formats: ['fhir', 'compact'] }; }, 'INVALID_SHAPE');
  bad('cursor with has_more false', env => { env.pagination.has_more = false; }, 'INVALID_SHAPE');
  bad('cursor with has_more null', env => { env.pagination.has_more = null as never; }, 'INVALID_SHAPE');
  bad('provenance count mismatch', env => { env.provenance.pop(); });
  bad('provenance type mismatch', env => { env.provenance[0]!.resource_index = 1; }, 'INVALID_SHAPE');
  bad('changed delivered versionId is caught by the capture snapshot (no cross-field rule compares provenance to meta.versionId)', env => { env.data.resources[0].meta.versionId = '9'; }, 'VALIDATION_CONTEXT_MISMATCH');
  bad('delivered version without provenance citation', env => { delete env.provenance[0]; }, 'INVALID_SHAPE');
  bad('duplicate provenance (type,id)', env => {
    env.data.resources[1] = { ...env.data.resources[0]! };
    env.provenance[1] = { ...env.provenance[0]! };
  }, 'INVALID_SHAPE');
  bad('returned_matches mismatch', env => { env.pagination.returned_matches = 0; });
  bad('returned_includes nonzero', env => { env.pagination.returned_includes = 1; }, 'INVALID_SHAPE');
  bad('resources without provenance', env => { delete (env as Rec).provenance; });
  bad('mixed clinical/summary resources', env => { (env.data.resources as unknown[])[1] = { type: 'Observation', resource_class: 'patient' }; }, 'INVALID_SHAPE');
  bad('understated final bytes', env => { env.budget.bytes_returned--; }, 'INVALID_FINAL_BYTES');
  bad('same-length request correlation mutation', env => { env.request_id = 'x'.repeat(env.request_id.length); }, 'VALIDATION_CONTEXT_MISMATCH');
  } finally { gateway.close(); await synthetic.close(); }
});
