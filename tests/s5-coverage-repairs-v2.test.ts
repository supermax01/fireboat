// INTERNAL S5.3 preparation. No public v2 dispatcher; D01–D06 stay TODO until S5.7.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import test from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { McpServer, type StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { evidenceRender } from '../packages/core/src/delivery.js';
import type { GatewayEnvelope } from '../packages/core/src/contracts.js';
import { FhirGateway } from '../packages/core/src/index.js';
import { permissiveInputSchema, toMcpToolResult02, type GatewayEnvelope02, type ToolName } from '../packages/core/src/contracts.js';
import { buildQueryEvidence, downgradeEvidence, declaredSearchProfile, type SearchProfile } from '../packages/core/src/query.js';
import { resolveSearchParameters } from '../packages/core/src/search-parameters.js';
import { WARNING_MESSAGES, REFUSAL_MESSAGES, MODIFIER_NO_CLINICAL_MESSAGE } from '../packages/core/src/catalog.js';
import { NO_MATCHES_MESSAGE, NO_MATCHES_UNVERIFIED_SUFFIX, TEST_CORRUPTOR_WARNING, UNVERIFIED_DELIVERY_WARNING, repairForFault } from '../packages/core/src/repairs.js';
import type { QueryEvidence, QueryOverlay } from '../packages/core/src/m3b.js';

type Snapshot = { type: string; records: unknown[]; offset: number; suppressed: boolean; query: { name: string; value: string }[];
  queryEvidence?: QueryEvidence; queryOverlay?: QueryOverlay; nextUrl?: string; nonContinuable?: boolean; precisionRefused?: boolean;
  sourceIncomplete?: boolean; outcomeCodes?: string[]; unverifiedFilters?: string[]; partialReasons?: string[]; queryEvidenceKind?: string };
type Assembly = { tool: 'fhir_search' | 'fhir_page' | 'fhir_read' | 'fhir_result'; deliveredCount: number; filtered: boolean;
  previousEvidence?: QueryEvidence; localRemainder?: boolean; unknownContinuation?: boolean; capped?: boolean; refused?: boolean; reasons?: string[] };
type Body = { data: GatewayEnvelope02['data']; coverage: GatewayEnvelope02['coverage']; warnings?: GatewayEnvelope02['warnings']; pagination?: GatewayEnvelope02['pagination'] };
const internal = (g: FhirGateway) => g as unknown as {
  controlCoverageV2(clinical: boolean, faultCode?: string): GatewayEnvelope02['coverage'];
  coverageV2(s: Snapshot, a: Assembly): { coverage: GatewayEnvelope02['coverage']; warnings: GatewayEnvelope02['warnings']; evidence?: QueryEvidence };
  admitV2(tool: ToolName, args: unknown): never;
  envelopeV2(tool: ToolName, body: Body): GatewayEnvelope02;
  errorV2(tool: ToolName, fault: { code: string; retryable: boolean; message?: string }): GatewayEnvelope02;
  refusalV2(tool: ToolName, kind: string, work: { upstreamCalls: number; clinicalCalls: number }, admission?: unknown, meta?: { resource_type?: string; parameter?: string }): GatewayEnvelope02;
  reviewedNamesV2(): { resource(type: string): boolean; parameter(type: string, name: string): boolean };
  capabilities?: Map<string, unknown>;
  store: { get(handle: string): { value: Snapshot } };
};
const config = { mode: 'synthetic' as const, source: { alias: 'local', baseUrl: 'http://127.0.0.1:9/fhir' }, patientId: 'synthetic-a', contextId: 'ctx_test' };
function gateway() {
  const g = new FhirGateway(config), c = internal(g);
  const resolved = resolveSearchParameters({ resourceType: 'Observation', advertised: true,
    declared: [{ name: 'subject', type: 'reference' }, { name: 'date', type: 'date' }, { name: 'code', type: 'token' }, { name: 'unreviewed', type: 'token' }] as never });
  c.capabilities = new Map([['Observation', { declared: [{ name: 'subject', type: 'reference' }, { name: 'date', type: 'date' }, { name: 'code', type: 'token' }], resolvedParameters: new Map([['generic-r4', resolved]]) }]]);
  return { g, c };
}
function evidence(): QueryEvidence {
  return buildQueryEvidence({ resourceType: 'Observation', pairs: [{ name: 'date', value: 'ge2025-01-01' }, { name: 'date', value: 'le2025-02-01' },
    { name: 'date', value: 'ge2025-01-01' }, { name: 'code', value: 'http://loinc.org|4548-4' }, { name: 'subject', value: 'Patient/synthetic-a' }],
    sortRequested: ['-date'], gatewayEnforcedIndices: new Set([4]), sourceRevision: 'cap', policyRevision: 'policy', contextHandle: 'ctx_test',
    selfPairs: [{ name: 'date', value: 'ge2025-01-01' }, { name: 'date', value: 'le2025-02-01' }, { name: 'code', value: 'http://loinc.org|4548-4' }, { name: 'subject', value: 'Patient/synthetic-a' }, { name: '_sort', value: '-date' }] });
}
function state(e = evidence()): Snapshot {
  return { type: 'Observation', records: [], offset: 0, suppressed: false, query: e.constraints.map(({ name, value }) => ({ name, value })), queryEvidence: e,
    queryOverlay: { deliveredCount: 0, pagesObserved: 1, queryEvidence: { ...e, constraints: [] }, sortProof: 'none',
      constraintProof: e.constraints.map(({ source_reported, execution }) => ({ source_reported, execution })) } };
}
const call = (extra: Partial<Assembly> = {}): Assembly => ({ tool: 'fhir_search', deliveredCount: 0, filtered: true, ...extra });
function proved(): QueryEvidence {
  // Internal harness proof supplied by S4 tests; no public profile is enabled.
  const e = evidence();
  return { ...e, constraints: e.constraints.map(x => ({ ...x, execution: 'gateway_enforced' })), materialFilterProved: true, evidenceKind: 'exact_id_and_subject_linkage' };
}

test('D01 internal: filtered exhausted verified zero uses final coverage, chain deliveries and reviewed repair', () => {
  const { g, c } = gateway();
  try {
    const result = c.coverageV2(state(proved()), call());
    assert.equal(result.coverage.query_exhausted, true);
    assert.equal(result.warnings.find(w => w.code === 'NO_MATCHES')?.message, NO_MATCHES_MESSAGE);
    assert.deepEqual(result.warnings.find(w => w.code === 'NO_MATCHES')?.repair, { action: 'inspect_observed_codes', tool: 'fhir_search', resource_type: 'Observation', fields: ['code'], page_size: 100, max_pages: 3, max_calls: 4 });
  } finally { g.close(); }
});
test('D02 internal: unverified filtered zero has exactly the uncertainty suffix; self links never prove execution', () => {
  const { g, c } = gateway();
  try {
    const s = state(), r = c.coverageV2(s, call());
    assert.equal(r.coverage.state, 'unknown');
    assert.equal(r.warnings.find(w => w.code === 'NO_MATCHES')?.message, NO_MATCHES_MESSAGE + NO_MATCHES_UNVERIFIED_SUFFIX);
    assert.ok(r.coverage.constraints!.filter(e => e.name !== 'subject').every(e => e.source_reported === 'matched' && e.execution === 'unknown'));
    assert.equal(c.coverageV2(s, call({ tool: 'fhir_page', previousEvidence: r.evidence })).evidence!.materialFilterProved, false);
  } finally { g.close(); }
});
for (const [name, change, args] of [
  ['D03 unfiltered', {}, { filtered: false }], ['D04 intermediate upstream', { nextUrl: 'opaque-internal' }, {}],
  ['D04 local remainder', {}, { localRemainder: true }], ['D04 unknown continuation', {}, { unknownContinuation: true }],
  ['retained inspect/project/page', {}, { tool: 'fhir_result' }], ['resource read', {}, { tool: 'fhir_read' }],
  ['failed', {}, { refused: true }], ['capped', {}, { capped: true }], ['noncontinuable', { nonContinuable: true }, {}],
  ['source incomplete', { sourceIncomplete: true }, {}], ['precision refused', { precisionRefused: true }, {}],
] as [string, Partial<Snapshot>, Partial<Assembly>][]) test(`NO_MATCHES absent: ${name}`, () => {
  const { g, c } = gateway();
  try { const r = c.coverageV2({ ...state(name === 'D03 unfiltered' ? buildQueryEvidence({ resourceType: 'Observation', pairs: [{ name: 'subject', value: 'Patient/synthetic-a' }], gatewayEnforcedIndices: new Set([0]), sourceRevision: 'cap', policyRevision: 'policy', contextHandle: 'ctx_test' }) : evidence()), ...change }, call(args)); assert.equal(r.warnings.some(w => w.code === 'NO_MATCHES'), false); }
  finally { g.close(); }
});
test('D05 internal: terminal zero after earlier deliveries never implies NO_MATCHES; suppressed counts irrelevant', () => {
  const { g, c } = gateway();
  try {
    const s = state(); s.queryOverlay!.deliveredCount = 1;
    assert.equal(c.coverageV2(s, call({ tool: 'fhir_page' })).warnings.some(w => w.code === 'NO_MATCHES'), false);
    s.suppressed = true;
    assert.equal(c.coverageV2(s, call({ tool: 'fhir_page' })).warnings.some(w => w.code === 'NO_MATCHES'), false);
    s.queryOverlay!.deliveredCount = 0;
    assert.equal(c.coverageV2(s, call()).warnings.some(w => w.code === 'NO_MATCHES'), true);
    assert.equal(c.coverageV2(s, call({ deliveredCount: 1 })).warnings.some(w => w.code === 'NO_MATCHES'), false);
  } finally { g.close(); }
});

test('full ordered repeated constraints/sort/digest on initial, retained and first evidence change; shorthand only unchanged pages', () => {
  const { g, c } = gateway();
  try {
    const s = state(), before = JSON.stringify(s);
    const first = c.coverageV2(s, call());
    for (const tool of ['fhir_search', 'fhir_result'] as const) {
      const r = c.coverageV2(s, call({ tool, previousEvidence: first.evidence }));
      assert.deepEqual(r.coverage.constraints, first.coverage.constraints);
      assert.equal(r.coverage.constraints!.filter(e => e.name === 'date').length, 3);
      assert.deepEqual(r.coverage.sort!.requested, ['-date']); assert.equal(r.coverage.query_digest, s.queryEvidence!.query_digest);
    }
    const empty = { ...evidence(), constraints: [], materialFilterProved: false };
    const zero = c.coverageV2(state(empty), call({ filtered: false }));
    assert.deepEqual(zero.coverage.constraints, []); assert.equal(zero.coverage.constraints_on_first_page, undefined);
    assert.deepEqual(zero.coverage.sort!.requested, ['-date']);
    const page = c.coverageV2(s, call({ tool: 'fhir_page', previousEvidence: first.evidence }));
    assert.equal(page.coverage.constraints, undefined); assert.equal(page.coverage.constraints_on_first_page, true);
    assert.equal(page.coverage.sort!.requested, undefined); assert.equal(page.coverage.query_digest, s.queryEvidence!.query_digest);
    const downgraded = downgradeEvidence({ ...proved(), constraints: proved().constraints.map(x => x.name === 'date' ? { ...x, execution: 'tested_adapter' } : x) }, 'date');
    const changed = c.coverageV2(state(downgraded), call({ tool: 'fhir_page', previousEvidence: proved() }));
    assert.equal(changed.coverage.constraints!.length, 5); assert.deepEqual(changed.coverage.sort!.requested, ['-date']);
    assert.equal(JSON.stringify(s), before, 'disclosure cannot replace canonical backing evidence');
  } finally { g.close(); }
});
test('merge all material reasons without truncation; overflow refuses instead of dropping; caveat independent of suppression', () => {
  const { g, c } = gateway();
  try {
    const s = { ...state(), precisionRefused: true, sourceIncomplete: true, nonContinuable: true, outcomeCodes: ['processing'], unverifiedFilters: ['code'], partialReasons: ['INVALID_RESOURCE_ID'] };
    s.queryOverlay!.refusalReasons = ['ENTRY_ORIGIN_MISMATCH'];
    const r = c.coverageV2(s, call({ reasons: ['OVERSIZED_RESOURCE'] }));
    for (const reason of ['CLINICAL_RECORD_COMPLETENESS_UNKNOWN', 'UNSUPPORTED_PRECISION', 'SOURCE_REPORTED_INCOMPLETE', 'NON_CONTINUABLE_UPSTREAM_LINK', 'SOURCE_OUTCOME', 'FILTER_EXECUTION_UNVERIFIED', 'INVALID_RESOURCE_ID', 'ENTRY_ORIGIN_MISMATCH', 'OVERSIZED_RESOURCE']) assert.ok(r.coverage.reasons.includes(reason), reason);
    assert.equal(r.coverage.query_exhausted, null);
    assert.throws(() => c.coverageV2(s, call({ reasons: Array.from({ length: 33 }, (_, i) => `REASON_${i}`) })), /Coverage evidence/);
    assert.deepEqual(c.coverageV2(state(), call()).coverage, c.coverageV2({ ...state(), suppressed: true }, call()).coverage);
    const retained = c.coverageV2(s, call({ tool: 'fhir_result' }));
    assert.equal(retained.coverage.state, 'partial'); assert.equal(retained.coverage.query_exhausted, null);
    const read = c.coverageV2(state(), call({ tool: 'fhir_read' }));
    assert.equal(read.coverage.scope, 'resource'); assert.equal(read.coverage.query_digest, undefined);
  } finally { g.close(); }
});
test('reviewed names injected from Q, no source-only repairs and NOT_FOUND stays uniform', () => {
  const { g, c } = gateway();
  try {
    const reviewed = c.reviewedNamesV2();
    assert.equal(reviewed.resource('Observation'), true); assert.equal(reviewed.parameter('Observation', 'code'), true);
    assert.equal(reviewed.parameter('Observation', 'unreviewed'), false); assert.equal(reviewed.resource('Invented'), false);
    for (const parameter of ['code', 'unreviewed']) {
      const env = c.refusalV2('fhir_search', 'unsupported_modifier', { upstreamCalls: 2, clinicalCalls: 0 }, undefined, { resource_type: 'Observation', parameter });
      assert.equal(env.error!.repair!.parameter, parameter === 'code' ? 'code' : undefined);
    }
    assert.equal(repairForFault('NOT_FOUND', { resource_type: 'Observation', allowed_max_bytes: 10000, current_max_bytes: 4096 }, reviewed), undefined);
    const repairSource = readFileSync(new URL('../packages/core/src/repairs.ts', import.meta.url), 'utf8');
    assert.equal(/from ['"].*(query|search-parameters|support)\.js/.test(repairSource), false);
  } finally { g.close(); }
});

async function sdk(era: 'modern' | 'legacy', emit: (name: ToolName, args: unknown) => GatewayEnvelope02 | Promise<GatewayEnvelope02>, run: (client: Client) => Promise<void>) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = serveStdio(() => {
    const s = new McpServer({ name: 's53-internal-candidate', version: '0' }, { capabilities: { tools: {} }, supportedProtocolVersions: ['2026-07-28', '2025-11-25'] });
    for (const name of ['fhir_search', 'fhir_read', 'fhir_capabilities', 'fhir_result'] as const) s.registerTool(name, { description: 'Internal candidate harness', inputSchema: permissiveInputSchema({ type: 'object', additionalProperties: true }) as unknown as StandardSchemaWithJSON }, async (args) => {
        const env = await emit(name, args);
        if ((args as { variant?: string }).variant === 'fallback') {
          env.data = {}; // metadata-shaped body triggers the REAL whole-result fallback
          const render = evidenceRender(env as unknown as GatewayEnvelope);
          assert.equal(render.fellBack, true);
          env.transform.delivery_profile = render.deliveredProfile;
          return { ...toMcpToolResult02(env), content: [{ type: 'text', text: evidenceRender(env as unknown as GatewayEnvelope).text }] } as never;
        }
        return toMcpToolResult02(env) as never;
      });
    return s;
  }, { transport: b });
  const client = new Client({ name: 's53-test', version: '0' }, era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : undefined);
  try { await client.connect(a); await run(client); } finally { await client.close(); await server.close(); }
}
for (const era of ['modern', 'legacy'] as const) test(`G-16 internal SDK ${era}: every warning/sole suffix and six matching refusals, success/error/fallback`, async () => {
  const { g, c } = gateway();
  const invalid = { invalid_topic: ['fhir_capabilities', { topic: 'secret' }], invalid_format: ['fhir_search', { resource_type: 'Observation', output: { format: 'secret' } }],
    invalid_action: ['fhir_result', { handle: 'res_test', action: 'secret' }], invalid_interaction: ['fhir_read', { resource_type: 'Observation', id: 'synthetic-o1', interaction: 'secret' }] } as const;
  try {
    await sdk(era, (tool, raw) => {
      const args = raw as { warning?: string; message?: string; refusal?: string; variant?: string };
      if (args.refusal) {
        if (args.refusal in invalid) {
          const [name, input] = invalid[args.refusal as keyof typeof invalid];
          try { c.admitV2(name, input); assert.fail('must refuse'); } catch (fault) { return c.errorV2(name, fault as never); }
        }
        return c.refusalV2(tool, args.refusal, { upstreamCalls: args.variant === 'metadata' ? 2 : 0, clinicalCalls: 0 });
      }
      const assembled = c.coverageV2(state(), call({ filtered: false }));
      const body: Body = { data: { resources: [] }, coverage: assembled.coverage,
        warnings: [{ code: args.warning!, message: args.message ?? `source text ${args.variant ?? ''}` }] };
      const env = c.envelopeV2(tool, body);
      if (args.variant === 'error') { env.data = {}; env.error = { code: 'UPSTREAM_ERROR', safe_message: 'Unable to complete the bounded request.', retryable: false }; }
      return env;
    }, async client => {
      for (const [code, expected] of Object.entries(WARNING_MESSAGES)) for (const variant of code === 'SOURCE_OUTCOME' || code === 'FILTER_EXECUTION_UNVERIFIED' ? ['one', 'two'] : ['success', 'fallback', 'error']) {
        const result = await client.callTool({ name: 'fhir_search', arguments: { warning: code, variant } });
        assert.equal((result.structuredContent as unknown as GatewayEnvelope02).warnings[0]!.message, expected, code);
        assert.ok((result.content[0] as { text: string }).text.includes(expected));
        if (variant === 'fallback') assert.ok((result.content[0] as { text: string }).text.startsWith('delivery_profile: "full-text-v1"\n'));
        if (variant === 'error') assert.equal(result.isError, true);
      }
      const suffix = await client.callTool({ name: 'fhir_search', arguments: { warning: 'NO_MATCHES', message: WARNING_MESSAGES.NO_MATCHES + NO_MATCHES_UNVERIFIED_SUFFIX } });
      assert.equal((suffix.structuredContent as unknown as GatewayEnvelope02).warnings[0]!.message, NO_MATCHES_MESSAGE + NO_MATCHES_UNVERIFIED_SUFFIX);
      for (const [refusal, message] of Object.entries(REFUSAL_MESSAGES)) {
        const tool = refusal in invalid ? invalid[refusal as keyof typeof invalid][0] : refusal === 'expired_result' ? 'fhir_result' : 'fhir_search';
        const result = await client.callTool({ name: tool, arguments: { refusal } });
        const env = result.structuredContent as unknown as GatewayEnvelope02;
        assert.equal(env.error!.safe_message, message, refusal); assert.equal(result.isError, true);
      }
      const result = await client.callTool({ name: 'fhir_search', arguments: { refusal: 'unsupported_modifier', variant: 'metadata' } });
      const env = result.structuredContent as unknown as GatewayEnvelope02;
      assert.equal(env.error!.safe_message, MODIFIER_NO_CLINICAL_MESSAGE); assert.equal(env.budget.upstream_calls, 2);
    });
    assert.equal(TEST_CORRUPTOR_WARNING.message, WARNING_MESSAGES.TEST_ENVELOPE_CORRUPTOR_ACTIVE);
    assert.equal(UNVERIFIED_DELIVERY_WARNING.message, WARNING_MESSAGES.UNVERIFIED_DELIVERY_PROFILE);
  } finally { g.close(); }
});

test('independent recording: zero total work vs zero clinical work after metadata/auth, authorized same-tool controls', async () => {
  const counts = { auth: 0, metadata: 0, clinical: 0 };
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/fhir+json');
    if (req.url === '/token') { counts.auth++; res.end(JSON.stringify({ access_token: 'synthetic-token', token_type: 'Bearer', expires_in: 3600 })); }
    else if (req.url?.endsWith('/metadata')) { counts.metadata++; res.end(JSON.stringify({ resourceType: 'CapabilityStatement', fhirVersion: '4.0.1', rest: [{ mode: 'server', resource: [{ type: 'Observation', interaction: [{ code: 'search-type' }, { code: 'read' }], searchParam: [{ name: 'subject', type: 'reference' }, { name: 'code', type: 'token' }] }] }] })); }
    else { counts.clinical++; const resource = { resourceType: 'Observation', id: 'synthetic-o1', status: 'final', subject: { reference: 'Patient/synthetic-a' } };
      res.end(JSON.stringify(req.url?.includes('/Observation/') ? resource : { resourceType: 'Bundle', type: 'searchset', link: [{ relation: 'self', url: base + req.url }], entry: [{ resource, search: { mode: 'match' } }] })); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const key = 'FHIR_S53_SECRET', old = process.env[key]; process.env[key] = 'synthetic-secret';
  const g = new FhirGateway({ ...config, source: { alias: 'local', baseUrl: base + '/fhir', auth: { type: 'client_credentials', tokenUrl: base + '/token', clientId: 'synthetic', clientSecretEnv: key } } }), c = internal(g);
  try {
    for (const [tool, args] of [['fhir_capabilities', { topic: 'bad' }], ['fhir_read', { resource_type: 'Observation', id: 'synthetic-o1', interaction: 'history' }], ['fhir_result', { handle: 'res_test', action: 'bad' }], ['fhir_search', { resource_type: 'Observation', output: { format: 'bad' } }]] as const) assert.throws(() => c.admitV2(tool, args));
    assert.deepEqual(counts, { auth: 0, metadata: 0, clinical: 0 });
    const blocked = c.refusalV2('fhir_search', 'unsupported_modifier', { upstreamCalls: 0, clinicalCalls: 0 });
    assert.equal(blocked.budget.upstream_calls, 0); assert.equal(blocked.error!.safe_message, REFUSAL_MESSAGES.unsupported_modifier);
    const denial = await g.execute('fhir_search', { resource_type: 'Observation', params: [{ name: 'code:text', value: 'synthetic' }] });
    assert.equal(denial.error!.code, 'UNSUPPORTED_MODIFIER'); assert.deepEqual(counts, { auth: 1, metadata: 1, clinical: 0 });
    const after = c.refusalV2('fhir_search', 'unsupported_modifier', { upstreamCalls: counts.auth + counts.metadata, clinicalCalls: counts.clinical });
    assert.equal(after.error!.safe_message, MODIFIER_NO_CLINICAL_MESSAGE); assert.equal(after.budget.upstream_calls, 2);
    for (const [tool, args] of [['fhir_capabilities', { topic: 'server' }], ['fhir_read', { resource_type: 'Observation', id: 'synthetic-o1' }], ['fhir_search', { resource_type: 'Observation' }]] as const) assert.equal((await g.execute(tool, args)).error, undefined);
    const search = await g.execute('fhir_search', { resource_type: 'Observation' });
    assert.equal((await g.execute('fhir_result', { handle: search.result!.handle, action: 'inspect' })).error, undefined);
    assert.equal(counts.clinical, 3, 'read + two authorized searches; inspect is local');
    assert.throws(() => c.refusalV2('fhir_search', 'unsupported_modifier', { upstreamCalls: 3, clinicalCalls: 1 }), /Unable/);
  } finally { g.close(); if (old === undefined) delete process.env[key]; else process.env[key] = old; server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('S5.7b activates coverage and all 14 public integration drafts are executable', () => {
  const source = readFileSync(new URL('../packages/core/src/index.ts', import.meta.url), 'utf8');
  const execute = source.slice(source.indexOf('  async execute('), source.indexOf('  /** S5.2 inert admission boundary.'));
  assert.equal(/coverageV2|refusalV2|warningsV2|envelopeV2/.test(execute), true);
  const drafts = readFileSync(new URL('./m3b-integration-drafts.test.ts', import.meta.url), 'utf8');
  assert.equal((drafts.match(/test\.todo\(/g) ?? []).length, 0);
  for (let n=1; n<=14; n++) assert.ok(drafts.includes(`D${String(n).padStart(2,'0')}`));
  assert.ok(drafts.includes('withSdk')); assert.ok(drafts.includes('withGateway'));
});

for (const era of ['modern', 'legacy'] as const) test(`G-16 source recording ${era}: distinct outcome/filter variants use exact canonical messages`, async () => {
  let base = '', mode = 'outcome-one', clinical = 0;
  const source = createServer((req, res) => {
    res.setHeader('content-type', 'application/fhir+json');
    if (req.url?.endsWith('/metadata')) {
      res.end(JSON.stringify({ resourceType: 'CapabilityStatement', fhirVersion: '4.0.1', rest: [{ mode: 'server', resource: [{ type: 'Observation', interaction: [{ code: 'search-type' }], searchParam: [{ name: 'subject', type: 'reference' }, { name: 'code', type: 'token' }] }] }] })); return;
    }
    clinical++;
    const issue = mode === 'outcome-one' ? { severity: 'warning', code: 'informational' }
      : mode === 'outcome-two' ? { severity: 'information', code: 'business-rule' }
      : mode === 'filter-one' ? { severity: 'information', code: 'informational', expression: ['Observation.code'] }
      : { severity: 'warning', code: 'not-supported', diagnostics: 'code source prose must not be copied' };
    res.end(JSON.stringify({ resourceType: 'Bundle', type: 'searchset', link: [{ relation: 'self', url: base + req.url }], entry: [
      { search: { mode: 'match' }, resource: { resourceType: 'Observation', id: 'synthetic-o1', subject: { reference: 'Patient/synthetic-a' }, code: { coding: [{ system: 'http://loinc.org', code: '4548-4' }] } } },
      { search: { mode: 'outcome' }, resource: { resourceType: 'OperationOutcome', issue: [issue] } },
    ] }));
  });
  await new Promise<void>(resolve => source.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(source.address() as { port: number }).port}`;
  const g = new FhirGateway({ ...config, source: { alias: 'local', baseUrl: base + '/fhir' } }), c = internal(g);
  try {
    await sdk(era, async (tool, raw) => {
      mode = (raw as { mode: string }).mode;
      const old = await g.execute('fhir_search', { resource_type: 'Observation', params: [{ name: 'code', value: 'http://loinc.org|4548-4' }] }, { era });
      assert.equal(old.error, undefined);
      const s = c.store.get(old.result!.handle).value;
      const assembly = c.coverageV2(s, call({ deliveredCount: 0 }));
      return c.envelopeV2(tool, { data: old.data, coverage: assembly.coverage, warnings: assembly.warnings });
    }, async client => {
      for (const mode of ['outcome-one', 'outcome-two', 'filter-one', 'filter-two']) {
        const result = await client.callTool({ name: 'fhir_search', arguments: { mode } });
        const env = result.structuredContent as unknown as GatewayEnvelope02;
        const code = mode.startsWith('outcome') ? 'SOURCE_OUTCOME' : 'FILTER_EXECUTION_UNVERIFIED';
        assert.equal(env.warnings.find(w => w.code === code)?.message, WARNING_MESSAGES[code]);
        assert.equal(JSON.stringify(result).includes('source prose'), false);
      }
    });
    assert.equal(clinical, 4);
  } finally { g.close(); source.closeAllConnections(); await new Promise<void>(resolve => source.close(() => resolve())); }
});

test('candidate metadata/error coverage uses Q controls without query evidence or NO_MATCHES', () => {
  const { g, c } = gateway();
  try {
    const metadata = c.controlCoverageV2(false);
    assert.equal(metadata.scope, 'metadata'); assert.equal(metadata.query_exhausted, true); assert.equal(metadata.pages_observed, 0);
    assert.equal(metadata.authorization_limited, false); assert.equal(metadata.query_evidence, 'metadata_snapshot');
    for (const tool of ['fhir_capabilities', 'fhir_search', 'fhir_read', 'fhir_page', 'fhir_result'] as const) {
      const env = c.errorV2(tool, { code: 'UPSTREAM_ERROR', retryable: false });
      assert.equal(env.coverage.state, 'unknown'); assert.equal(env.coverage.query_exhausted, null);
      assert.ok(env.coverage.reasons.includes('UPSTREAM_ERROR')); assert.deepEqual(env.warnings, []);
      assert.equal(env.coverage.query_digest, undefined);
      assert.equal(env.coverage.reasons.includes('CLINICAL_RECORD_COMPLETENESS_UNKNOWN'), tool !== 'fhir_capabilities');
    }
  } finally { g.close(); }
});
