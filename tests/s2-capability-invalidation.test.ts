import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { test, type TestContext } from 'node:test';
import { FhirGateway, type GatewayEnvelope } from '../packages/core/src/index.js';
import { declaredFromCapability } from '../packages/core/src/search-parameters.js';
import { normalizedCapabilityRevision } from '../packages/core/src/discovery.js';
import { ProfileState, declaredSearchProfile, filterVariantProved, isProvingSearchProfile, profileForSource, searchProfile, sourceIdentityDigest, type SearchProfile } from '../packages/core/src/query.js';

// Reflection is deliberately confined to the test harness; the production constructor has no candidate argument.
const candidateState = (profile: import('../packages/core/src/query.js').SearchProfile) => {
  const state = new ProfileState();
  (state as unknown as { setCandidateForTest(profile: import('../packages/core/src/query.js').SearchProfile): void }).setCandidateForTest(profile);
  return state;
};
const brandSearchProfileForTest = (profile: import('../packages/core/src/query.js').SearchProfile) => candidateState(profile).profile(profile.id)!;
import { guardAgainstUncaught } from './no-uncaught.js';

guardAgainstUncaught();

// S2 (M3b integration, W1): capability identity is the NORMALIZED revision over
// declaredFromCapability output, metadata refreshes after discovery.metadataTtlMs,
// and retained clinical state clears on close, credential-epoch,
// policy-revision and normalized-revision (or source software identity) change —
// never on cosmetic CapabilityStatement edits. Discovery storage and new MCP topics remain deferred to S5.

const a = 'synthetic-patient-a';
const SP = 'http://hl7.org/fhir/SearchParameter';
const DOC_CANARY = 'S2-CANARY-DOCUMENTATION-7d1e';
const METADATA_TTL = 60_000;

type SearchParamDecl = Record<string, unknown>;
const BASE_PARAMS: SearchParamDecl[] = [
  { name: 'patient', type: 'reference', definition: `${SP}/clinical-patient`, documentation: `patient docs ${DOC_CANARY}` },
  { name: 'subject', type: 'reference', definition: `${SP}/clinical-subject`, documentation: 'subject docs' },
  { name: 'code', type: 'token', definition: `${SP}/clinical-code`, documentation: 'code docs' },
  { name: 'date', type: 'date', definition: `${SP}/clinical-date` },
];

function baseMetadata(): Record<string, unknown> {
  return {
    resourceType: 'CapabilityStatement', id: 's2-cap-v1', fhirVersion: '4.0.1',
    date: '2026-01-01T00:00:00Z', status: 'active', kind: 'instance',
    software: { name: 's2 fixture software', version: '1.0' },
    meta: { versionId: '1', lastUpdated: '2026-01-01T00:00:00Z' },
    text: { status: 'generated', div: '<div>capability narrative v1</div>' },
    rest: [{
      mode: 'server', documentation: `rest docs ${DOC_CANARY}`,
      resource: ['Patient', 'Observation'].map(type => ({
        type, interaction: [{ code: 'read' }, { code: 'search-type' }],
        searchParam: structuredClone(BASE_PARAMS),
      })),
    }],
  };
}
const clone = <T,>(value: T): T => structuredClone(value);
const resourcesOf = (metadata: Record<string, unknown>) => (metadata.rest as { resource: Record<string, unknown>[] }[])[0]!.resource;
const observationResource = (metadata: Record<string, unknown>) => resourcesOf(metadata).find(r => r.type === 'Observation')!;
const obsParams = (metadata: Record<string, unknown>) => observationResource(metadata).searchParam as SearchParamDecl[];

const observation = (id: string) => ({
  resourceType: 'Observation', id, meta: { versionId: '1' }, status: 'final',
  code: { coding: [{ system: 'http://loinc.org', code: '4548-4' }] },
  subject: { reference: `Patient/${a}` }, effectiveDateTime: '2026-01-02T10:00:00Z',
  valueQuantity: { value: 7.1, unit: '%', system: 'http://unitsofmeasure.org', code: '%' },
});

interface Internals {
  store: { size: number; usedBytes(): number; get(handle: string): { value: { records: unknown[]; offset: number; loaded?: boolean }; expires_at: string } };
  capabilities?: Map<string, { declared?: unknown; searchParameters?: string[]; searchParamTypes?: Record<string, string> }>;
  capabilityRevision: string;
  policyRevision: string;
  stateGeneration: number;
  sourceIdentity: { software?: string; softwareVersion?: string; fhirVersion?: string };
  metadataExpiresAt: number;
  retentionLedger: { usedBytes(): number };

}
const internals = (gateway: FhirGateway): Internals => gateway as unknown as Internals;

const clinicalSize = (gateway: FhirGateway): number => internals(gateway).store.size;

async function waitUntil(cond: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 600 && !cond(); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(cond(), label);
}

async function fixture(t: TestContext) {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const state = {
    metadata: baseMetadata(),
    metadataStatus: 0,
    metadataCalls: 0,
    clinicalCalls: 0,
    holdNextClinical: false,
    holdNextMetadata: false,
    heldMetadata: [] as { res: ServerResponse; body: string }[],
    held: [] as { res: ServerResponse; url: URL }[],
  };
  let baseUrl = '';
  const bundleFor = (url: URL) => {
    const next = new URL(url.href); next.searchParams.set('_getpagesoffset', '1');
    return {
      resourceType: 'Bundle', type: 'searchset',
      link: [{ relation: 'self', url: url.href }, { relation: 'next', url: next.href }],
      entry: ['obs-c', 'obs-a', 'obs-b', 'obs-f', 'obs-d', 'obs-e', 'obs-i', 'obs-g', 'obs-h'].map(observation).map(resource => ({ resource, search: { mode: 'match' } })),
    };
  };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url!, baseUrl);
    res.setHeader('content-type', 'application/fhir+json');
    if (url.pathname.endsWith('/metadata')) {
      state.metadataCalls++;
      if (state.metadataStatus) { res.statusCode = state.metadataStatus; res.end('{}'); return; }
      const body = JSON.stringify(state.metadata);
      if (state.holdNextMetadata) { state.holdNextMetadata = false; state.heldMetadata.push({ res, body }); return; }
      res.end(body); return;
    }
    state.clinicalCalls++;
    if (state.holdNextClinical) { state.holdNextClinical = false; state.held.push({ res, url }); return; }
    res.end(JSON.stringify(bundleFor(url)));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind');
  baseUrl = `http://127.0.0.1:${address.port}/fhir/`;
  const gateway = new FhirGateway({
    mode: 'synthetic', source: { alias: 's2-fixture', baseUrl }, patientId: a,
    discovery: { metadataTtlMs: METADATA_TTL },
  });
  const warm = async (): Promise<GatewayEnvelope> => {
    const result = await gateway.execute('fhir_capabilities', { topic: 'server' });
    assert.equal(result.error, undefined, JSON.stringify(result.error));
    return result;
  };
  const search = async (): Promise<GatewayEnvelope> => {
    const result = await gateway.execute('fhir_search', { resource_type: 'Observation', params: [{ name: 'code', value: 'http://loinc.org|4548-4' }], page_size: 1, output: { max_bytes: 8192 } });
    assert.equal(result.error, undefined, JSON.stringify(result.error));
    assert.ok(result.result?.handle.startsWith('res_'));
    assert.ok(result.pagination?.next_cursor?.startsWith('cur_'));
    return result;
  };
  return {
    gateway, state, warm, search,
    advance: (ms: number) => { now += ms; },
    releaseMetadata: () => { for (const held of state.heldMetadata.splice(0)) held.res.end(held.body); },
    releaseHeld: () => { for (const held of state.held.splice(0)) held.res.end(JSON.stringify(bundleFor(held.url))); },
    close: () => new Promise<void>((resolve, reject) => { gateway.close(); server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }),
  };
}

/** Warm, retain clinical handles, then cross only the metadata TTL. */
async function established(t: TestContext) {
  const f = await fixture(t); t.after(f.close);
  const warmEnv = await f.warm();
  const first = await f.search();
  f.advance(METADATA_TTL + 1); // metadata is stale; clinical handles retain their original 15-minute expiry
  return { f, warmEnv, first, revision: first.source.capability_revision, res: first.result!, cursor: first.pagination!.next_cursor! };
}

async function assertHandlesAlive(gateway: FhirGateway, res: { handle: string; expires_at: string }, cursor: string) {
  const retained = await gateway.execute('fhir_result', { handle: res.handle });
  assert.equal(retained.error, undefined, `retained handle survives: ${JSON.stringify(retained.error)}`);
  assert.equal(retained.result?.expires_at, res.expires_at, 'absolute expiry is unchanged');
  const frozen = internals(gateway).store.get(cursor);
  assert.equal(frozen.value.loaded, true, 'positive control: this cursor is a frozen local remainder');
  const expected = frozen.value.records.slice(frozen.value.offset).map(record => (record as { resource: { id: string } }).resource.id);
  const delivered: string[] = [];
  let next: string | undefined = cursor;
  while (next && delivered.length < expected.length) {
    const page = await gateway.execute('fhir_page', { cursor: next });
    assert.equal(page.error, undefined, `cursor survives: ${JSON.stringify(page.error)}`);
    assert.equal(page.pagination?.requested_page_size, 1);
    delivered.push(...(page.data.resources as { id: string }[]).map(r => r.id));
    next = page.pagination?.next_cursor;
  }
  assert.deepEqual(delivered, expected, 'frozen cursor contents are unchanged across inherited-size deliveries');
}

async function assertHandlesCleared(gateway: FhirGateway, res: { handle: string }, cursor: string) {
  assert.equal((await gateway.execute('fhir_result', { handle: res.handle })).error?.code, 'RESULT_EXPIRED', 'old res_ handle is gone');
  assert.equal((await gateway.execute('fhir_page', { cursor })).error?.code, 'RESULT_EXPIRED', 'old cur_ handle is gone');
}

test('S2: capability state carries declaredFromCapability output and the normalized revision', async t => {
  const f = await fixture(t); t.after(f.close);
  const warmEnv = await f.warm();
  const capability = internals(f.gateway).capabilities?.get('Observation');
  assert.ok(capability, 'Observation capability is cached');
  assert.deepEqual(capability!.declared, declaredFromCapability(BASE_PARAMS),
    'declared state is exactly declaredFromCapability output (definition and description-presence flag kept)');
  assert.deepEqual(capability!.searchParameters, ['patient', 'subject', 'code', 'date'], 'legacy name list retained for 0.1 callers');
  assert.deepEqual(capability!.searchParamTypes, { patient: 'reference', subject: 'reference', code: 'token', date: 'date' }, 'legacy type map retained');
  const expectedRevision = normalizedCapabilityRevision('4.0.1', ['Patient', 'Observation'].map(type => ({
    type, interactions: ['read', 'search-type'], declared: declaredFromCapability(BASE_PARAMS),
  })));
  assert.equal(warmEnv.source.capability_revision, expectedRevision, 'envelope revision is the normalized capability revision');
  assert.ok(!JSON.stringify([...internals(f.gateway).capabilities!.values()]).includes(DOC_CANARY),
    'source documentation canary never reaches cached capability state');
  assert.ok(!JSON.stringify(warmEnv).includes(DOC_CANARY), 'documentation canary never reaches envelope output');
  assert.equal((capability as unknown as { resolvedParameters: Map<string, unknown> }).resolvedParameters.size, 0, 'resolved cache reserved for W2');
  assert.equal(internals(f.gateway).retentionLedger.usedBytes(), internals(f.gateway).store.usedBytes(), 'the shared ledger accounts for the clinical store');
  assert.equal((f.gateway as unknown as { discoveryStore: { size: number } }).discoveryStore.size, 0, 'S5 discovery store remains inert on the ordinary serving path');
  assert.equal((await f.gateway.execute('fhir_capabilities', { topic: 'search_parameter' })).error?.code, 'INVALID_ARGUMENTS');
  assert.equal((await f.gateway.execute('fhir_capabilities', { topic: 'support' })).error, undefined);
  assert.equal(warmEnv.schema_version, '0.3');
});

test('S2: cosmetic CapabilityStatement edits and array shuffles preserve revision, frozen handles', async t => {
  const { f, revision, res, cursor } = await established(t);
  const cosmetic = clone(f.state.metadata);
  cosmetic.id = 's2-cap-v2-renamed';
  cosmetic.date = '2026-06-01T00:00:00Z';
  cosmetic.name = 'A Shiny New Title';
  cosmetic.description = 'rewritten prose';
  cosmetic.meta = { versionId: '99', lastUpdated: '2026-06-01T00:00:00Z', tag: [{ system: 'http://example.test/tags', code: 'cosmetic' }] };
  cosmetic.text = { status: 'generated', div: '<div>completely different narrative</div>' };
  (cosmetic.rest as Record<string, unknown>[])[0]!.documentation = 'different rest documentation';
  for (const param of obsParams(cosmetic)) param.documentation = `rewritten docs for ${String(param.name)}`;
  // Array shuffles: resources, interactions and search params reorder.
  resourcesOf(cosmetic).reverse();
  for (const resource of resourcesOf(cosmetic)) {
    (resource.interaction as unknown[]).reverse();
    (resource.searchParam as unknown[]).reverse();
  }
  f.state.metadata = cosmetic;
  const refreshed = await f.warm();
  assert.equal(f.state.metadataCalls, 2, 'metadata actually refreshed after the TTL');
  assert.equal(refreshed.source.capability_revision, revision, 'normalized revision is unchanged by cosmetic edits');
  await assertHandlesAlive(f.gateway, res, cursor);
});

const MATERIAL_CASES: [string, (metadata: Record<string, unknown>) => void][] = [
  ['resource type added', m => { resourcesOf(m).push({ type: 'Condition', interaction: [{ code: 'read' }, { code: 'search-type' }], searchParam: clone(BASE_PARAMS) }); }],
  ['resource type removed', m => { m.rest = [{ ...(m.rest as Record<string, unknown>[])[0], resource: resourcesOf(m).filter(r => r.type !== 'Patient') }]; }],
  ['interaction removed', m => { observationResource(m).interaction = [{ code: 'read' }]; }],
  ['search parameter name changed', m => { obsParams(m).find(p => p.name === 'code')!.name = 'status'; }],
  ['interaction added', m => { (observationResource(m).interaction as { code: string }[]).push({ code: 'vread' }); }],
  ['search parameter added', m => { obsParams(m).push({ name: 'status', type: 'token', definition: `${SP}/clinical-status` }); }],
  ['search parameter removed', m => { observationResource(m).searchParam = obsParams(m).filter(p => p.name !== 'date'); }],
  ['search parameter type changed', m => { obsParams(m).find(p => p.name === 'code')!.type = 'string'; }],
  ['search parameter definition changed', m => { obsParams(m).find(p => p.name === 'code')!.definition = `${SP}/Observation-code`; }],
  ['definition withheld flip (overlong canonical)', m => { obsParams(m).find(p => p.name === 'code')!.definition = `${SP}/clinical-code${'x'.repeat(600)}`; }],
  ['type invalid flip (non-string type)', m => { obsParams(m).find(p => p.name === 'code')!.type = 42; }],
  ['duplicate conflict flip', m => { obsParams(m).push({ name: 'code', type: 'string', definition: `${SP}/clinical-code` }); }],
  ['fhirVersion changed', m => { m.fhirVersion = '4.0.2'; }],
];

test('S2: every material capability change invalidates retained state', async t => {
  for (const [name, mutate] of MATERIAL_CASES) {
    await t.test(name, async st => {
      const { f, revision, res, cursor } = await established(st);
      mutate(f.state.metadata);
      const refreshed = await f.warm();
      assert.equal(f.state.metadataCalls, 2, 'metadata actually refreshed after the TTL');
      assert.notEqual(refreshed.source.capability_revision, revision, 'normalized revision changed');
      await assertHandlesCleared(f.gateway, res, cursor);
      // Positive control: the refresh adopted new capability state and work resumes,
      // except when the Patient type itself was removed (search is unaffected either way).
      const again = await f.warm();
      assert.equal(again.source.capability_revision, refreshed.source.capability_revision);
    });
  }
});

test('S2: a search that itself refreshes past a material change succeeds on new state while old handles die', async t => {
  const { f, revision, res, cursor } = await established(t);
  obsParams(f.state.metadata).push({ name: 'status', type: 'token', definition: `${SP}/clinical-status` });
  const fresh = await f.search(); // discover() refresh happens inside this very call
  assert.notEqual(fresh.source.capability_revision, revision);
  assert.notEqual(fresh.result!.handle, res.handle);
  await assertHandlesCleared(f.gateway, res, cursor);
  const retained = await f.gateway.execute('fhir_result', { handle: fresh.result!.handle });
  assert.equal(retained.error, undefined, 'handles minted under the new revision are live');
});

test('S2: source software and version identity changes independently invalidate state', async t => {
  for (const field of ['name', 'version']) await t.test(field, async st => {
    const { f, revision, res, cursor } = await established(st);
    (f.state.metadata.software as Record<string, string>)[field] = 'changed';
    const refreshed = await f.warm();
    assert.equal(refreshed.source.capability_revision, revision, 'software binding is separate from capability revision');
    await assertHandlesCleared(f.gateway, res, cursor);
  });
});

test('S2: a failed metadata refresh installs nothing, evicts nothing, and refuses new upstream work', async t => {
  const { f, revision, res, cursor } = await established(t);
  f.state.metadataStatus = 500;
  const clinicalBefore = f.state.clinicalCalls;
  const blocked = await f.gateway.execute('fhir_search', { resource_type: 'Observation' });
  assert.ok(blocked.error, 'new clinical work fails closed on the transport fault');
  assert.equal(f.state.clinicalCalls, clinicalBefore, 'no clinical fetch happened on stale capability');
  assert.equal((await f.gateway.execute('fhir_capabilities', { topic: 'server' })).error?.code, blocked.error!.code,
    'metadata discovery also fails closed rather than serving stale capability');
  // Retained local evidence needs no upstream work and is untouched.
  const retained = await f.gateway.execute('fhir_result', { handle: res.handle });
  assert.equal(retained.error, undefined, 'retained local remainder survives a failed refresh');
  // Next successful refresh applies the normal rules: same metadata, so nothing clears.
  f.state.metadataStatus = 0;
  const refreshed = await f.warm();
  assert.equal(refreshed.source.capability_revision, revision);
  await assertHandlesAlive(f.gateway, res, cursor);
});

test('S2: an old clinical flight across a revision change cannot retain or publish stale evidence', async t => {
  const f = await fixture(t); t.after(f.close);
  await f.warm();
  f.state.holdNextClinical = true;
  const staleSearch = f.gateway.execute('fhir_search', { resource_type: 'Observation', params: [{ name: 'code', value: 'http://loinc.org|4548-4' }] });
  await waitUntil(() => f.state.held.length === 1, 'clinical response held upstream');
  // Concurrent refresh installs a materially different capability and clears state.
  f.advance(METADATA_TTL + 1);
  obsParams(f.state.metadata).push({ name: 'status', type: 'token', definition: `${SP}/clinical-status` });
  await f.warm();
  assert.equal(clinicalSize(f.gateway), 0);
  const fresh = await f.search();
  const freshSize = clinicalSize(f.gateway);
  const freshBytes = internals(f.gateway).retentionLedger.usedBytes();
  f.releaseHeld();
  const stale = await staleSearch;
  assert.equal(stale.error?.code, 'CONNECTION_REQUIRED', `stale flight is refused, got ${JSON.stringify(stale.error)}`);
  assert.equal(stale.error?.retryable, true);
  assert.deepEqual(stale.data, {});
  assert.equal(stale.result, undefined);
  assert.equal(clinicalSize(f.gateway), freshSize, 'stale flight retained and evicted nothing after invalidation');
  assert.equal(internals(f.gateway).retentionLedger.usedBytes(), freshBytes);
  assert.equal((await f.gateway.execute('fhir_result', { handle: fresh.result!.handle })).error, undefined);
  assert.equal((await f.search()).source.capability_revision, internals(f.gateway).capabilityRevision, 'fresh work runs on the new revision');
});

test('S2: close clears clinical state and advances its generation', async t => {
  const f = await fixture(t); t.after(f.close);
  await f.warm();
  await f.search();
  assert.ok(clinicalSize(f.gateway) > 0);
  const before = internals(f.gateway).stateGeneration;
  f.gateway.close();
  assert.equal(clinicalSize(f.gateway), 0, 'clinical store cleared on close');
  assert.equal(internals(f.gateway).stateGeneration, before + 1);
  assert.equal((await f.gateway.execute('fhir_capabilities', { topic: 'server' })).error?.code, 'GATEWAY_CLOSED');
});

test('S2: a policy-revision change clears state on the next refresh', async t => {
  // The policy revision is a build-time constant in the gateway; assigning the
  // private field simulates the next build's revision inside one process.
  const { f, res, cursor } = await established(t);
  assert.equal((await f.warm()).context.policy_revision, 'synthetic-v2', 'masked policy revision is caller-visible');
  (internals(f.gateway) as { policyRevision: string }).policyRevision = 'synthetic-v2-next';
  const refreshed = await f.warm();
  assert.equal(refreshed.context.policy_revision, 'synthetic-v2-next');
  await assertHandlesCleared(f.gateway, res, cursor);
});

// --- Credential-epoch invalidation over the real auth path (401 clears, plain 403 does not) ---

const AUTH_ENV = 'FHIR_MCP_TEST_S2_SECRET';
const AUTH_SECRET = 'synthetic-s2-client-secret';

async function authFixture(t: TestContext) {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  let baseUrl = '';
  let tokenCalls = 0;
  let rejection: number | undefined;
  let metadataCalls = 0;
  let holdMetadata = false;
  let holdClinical = false;
  let metadataRejection: number | undefined;
  const heldMetadata: ServerResponse[] = [];
  const heldClinical: ServerResponse[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url!, baseUrl);
    if (url.pathname === '/oauth2/token') {
      tokenCalls++;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ access_token: `s2-access-${tokenCalls}`, token_type: 'Bearer', expires_in: 3600 })); return;
    }
    res.setHeader('content-type', 'application/fhir+json');
    if (req.headers.authorization !== `Bearer s2-access-${tokenCalls}`) { res.statusCode = 401; res.end('{}'); return; }
    if (holdClinical && !url.pathname.endsWith('/metadata')) { holdClinical = false; heldClinical.push(res); return; }
    if (rejection && !url.pathname.endsWith('/metadata')) { res.statusCode = rejection; res.end(JSON.stringify({ resourceType: 'OperationOutcome' })); return; }
    if (url.pathname.endsWith('/metadata')) {
      metadataCalls++;
      if (metadataRejection) { res.statusCode = metadataRejection; res.end('{}'); return; }
      if (holdMetadata) { holdMetadata = false; heldMetadata.push(res); return; }
      res.end(JSON.stringify(baseMetadata())); return;
    }
    res.end(JSON.stringify({
      resourceType: 'Bundle', type: 'searchset',
      link: [{ relation: 'self', url: url.href }],
      entry: [{ resource: observation('obs-a'), search: { mode: 'match' } }],
    }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind');
  baseUrl = `http://127.0.0.1:${address.port}/fhir/`;
  const previous = process.env[AUTH_ENV];
  process.env[AUTH_ENV] = AUTH_SECRET;
  const gateway = new FhirGateway({
    mode: 'synthetic',
    source: { alias: 's2-auth-fixture', baseUrl, auth: { type: 'client_credentials', clientId: 's2-client', tokenUrl: new URL('/oauth2/token', baseUrl).href, clientSecretEnv: AUTH_ENV } },
    patientId: a, discovery: { metadataTtlMs: METADATA_TTL },
  });
  t.after(async () => {
    gateway.close();
    if (previous === undefined) delete process.env[AUTH_ENV]; else process.env[AUTH_ENV] = previous;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  return {
    gateway,
    tokenCalls: () => tokenCalls,
    metadataCalls: () => metadataCalls,
    advance: (ms: number) => { now += ms; },
    rejectMetadata: (status?: number) => { metadataRejection = status; },
    holdMetadata: () => { holdMetadata = true; },
    holdClinical: () => { holdClinical = true; },
    heldMetadata, heldClinical,
    releaseMetadata: () => { for (const res of heldMetadata.splice(0)) res.end(JSON.stringify(baseMetadata())); },
    release401: () => { for (const res of heldClinical.splice(0)) { res.statusCode = 401; res.end('{}'); } },
    reject: (status?: number) => { rejection = status; },
    search: async () => gateway.execute('fhir_search', { resource_type: 'Observation' }),
  };
}

test('S2: a credential-invalidating 401 clears retained state; a plain 403 changes no state', async t => {
  const f = await authFixture(t);
  const first = await f.search();
  assert.equal(first.error, undefined, JSON.stringify(first.error));
  const generation = internals(f.gateway).stateGeneration;
  // Plain 403 on a clinical request: generation-scoped M3a rule — nothing is invalidated.
  f.reject(403);
  assert.ok((await f.search()).error, '403 surfaces as an error');
  f.reject();
  assert.equal(internals(f.gateway).stateGeneration, generation, 'plain 403 changes no state');
  assert.equal((await f.gateway.execute('fhir_result', { handle: first.result!.handle })).error, undefined, 'retained handle survives a plain 403');
  assert.equal(f.tokenCalls(), 1, 'no new token after a plain 403');
  // Genuine 401 against the current generation: epoch bump clears both stores.
  f.reject(401);
  assert.equal((await f.search()).error?.code, 'CONNECTION_REQUIRED');
  f.reject();
  assert.equal(internals(f.gateway).stateGeneration, generation + 1, '401 advances state generation');
  assert.equal((await f.gateway.execute('fhir_result', { handle: first.result!.handle })).error?.code, 'RESULT_EXPIRED', 'retained handle cleared on epoch change');
  const fresh = await f.search();
  assert.equal(fresh.error, undefined, 'work resumes on the fresh generation');
  assert.equal(f.tokenCalls(), 2);
});

// --- Q round-3 low: branded proof-capable profiles are deep-frozen clones ---

test('S2: branded proof-capable profiles are deep-frozen and cannot be mutated into wider proof', () => {
  const generic = searchProfile('generic-r4')!;
  assert.ok(Object.isFrozen(generic), 'selected profile is frozen');
  assert.ok(Object.isFrozen(generic.source), 'profile source is frozen');
  assert.ok(Object.isFrozen(generic.testIds), 'testIds are frozen');
  assert.ok(Object.isFrozen(generic.testedFilters), 'testedFilters are frozen');
  assert.ok(Object.isFrozen(generic.testedSorts), 'testedSorts are frozen');
  assert.ok(Object.isFrozen(generic.testedContinuations), 'testedContinuations are frozen');
  assert.throws(() => { (generic as unknown as { eligible: boolean }).eligible = false; }, TypeError);
  assert.throws(() => { (generic.testedFilters as unknown as unknown[]).push({ resource_type: 'Observation', parameter: 'code', variant: 'token-system-code' }); }, TypeError);
  assert.equal(isProvingSearchProfile(generic), true, 'frozen selected profile still proves (positive control)');
  assert.equal(searchProfile('generic-r4')!.eligible, true, 'registry state is unaffected by attempted mutation');

  const declared = declaredSearchProfile('synthetic-fixture-r4-v1')!;
  assert.ok(Object.isFrozen(declared) && declared.testedFilters.every(entry => Object.isFrozen(entry)), 'declared copy is deep-frozen too');
  const raw: SearchProfile = {
    ...declared,
    // Fresh mutable entries, so the post-branding mutations below can actually be attempted.
    testedFilters: declared.testedFilters.map(entry => ({ ...entry })),
    eligible: true,
    evidence: { report_sha256: 'd'.repeat(64), recorded_at: '2026-01-01T00:00:00.000Z' },
  };
  const branded = brandSearchProfileForTest(raw);
  assert.ok(Object.isFrozen(branded) && branded.testedFilters.every(entry => Object.isFrozen(entry)), 'branded clone and its entries are deep-frozen');
  assert.equal(isProvingSearchProfile(branded), true);
  assert.equal(isProvingSearchProfile(raw), false, 'the caller-held original is not branded by the seam');
  // Mutating the caller's original after branding must not widen the branded clone's proof.
  for (const entry of raw.testedFilters as unknown as { variant: string }[]) entry.variant = 'token-system-code';
  (raw as unknown as { testedFilters: unknown[] }).testedFilters = [{ resource_type: 'Observation', parameter: 'status', variant: 'token-system-code' }];
  assert.equal(filterVariantProved(branded, 'Observation', 'status', 'http://example.test|final'), false,
    'post-branding mutation of the source object does not widen branded proof');
});

test('S2: test-profile registration clones, so later mutation of the registered object cannot widen proof', () => {
  const profile: SearchProfile = {
    id: 'test-s2-frozen-r4-v1', version: '1', eligible: true,
    source: { software: 's2 fixture software', software_version: '1.0', fhir_version: '4.0.1' },
    evidence: { report_sha256: 'e'.repeat(64), recorded_at: '2026-01-01T00:00:00.000Z' },
    testIds: [],
    testedFilters: [{ resource_type: 'Observation', parameter: 'code', variant: 'token-system-code' }],
    testedSorts: [], testedContinuations: [],
  };
  const state = candidateState(profile);
  (profile.testedFilters as unknown as { parameter: string }[])[0]!.parameter = 'status';
  profile.source.software = 'mutated software';
  const selected = state.profile('test-s2-frozen-r4-v1', { software: 's2 fixture software', softwareVersion: '1.0', fhirVersion: '4.0.1' });
  assert.ok(selected, 'selection uses the registration-time source identity');
  assert.ok(Object.isFrozen(selected));
  assert.equal(filterVariantProved(selected, 'Observation', 'code', 'http://loinc.org|4548-4'), true, 'registered variant still proves');
  assert.equal(filterVariantProved(selected, 'Observation', 'status', 'http://loinc.org|4548-4'), false, 'post-registration mutation does not widen proof');
});



// Compare backing snapshots directly, not only the delivered count. Source bodies can change
// independently; retained local content/order/query/absolute expiry must remain frozen.
test('S2: a cosmetic refresh preserves the complete frozen cursor, replay and absolute expiry', async t => {
  const { f, first, cursor, res } = await established(t);
  const frozen = clone(internals(f.gateway).store.get(cursor));
  assert.equal(frozen.value.loaded, true);
  f.state.metadata.id = 'cosmetic';
  await f.warm();
  assert.equal(f.state.metadataCalls, 2);
  assert.deepEqual(internals(f.gateway).store.get(cursor), frozen);
  const clinicalBefore = f.state.clinicalCalls;
  const page1 = await f.gateway.execute('fhir_page', { cursor });
  const page2 = await f.gateway.execute('fhir_page', { cursor });
  assert.equal(page1.error, undefined);
  assert.deepEqual(page1.data, page2.data);
  assert.deepEqual((page1.coverage.constraints ?? first.coverage.constraints)?.map(({ name, value }) => ({ name, value })), first.coverage.constraints?.map(({ name, value }) => ({ name, value })));
  assert.equal(page1.result!.expires_at, res.expires_at);
  assert.equal(page2.result!.expires_at, res.expires_at);
  assert.equal(f.state.clinicalCalls, clinicalBefore, 'no upstream work for local remainder/replay');
  f.advance(Date.parse(res.expires_at) - Date.now());
  assert.equal((await f.gateway.execute('fhir_page', { cursor })).error?.code, 'RESULT_EXPIRED', 'refresh/replay never extended expiry');
});

// Get an unloaded upstream cursor by draining the local remainder with the default budget.
async function upstreamCursor(f: Awaited<ReturnType<typeof fixture>>): Promise<string> {
  const first = await f.search();
  let cursor = first.pagination!.next_cursor!;
  for (let i = 0; i < 100 && internals(f.gateway).store.get(cursor).value.loaded; i++) {
    const drained = await f.gateway.execute('fhir_page', { cursor });
    assert.equal(drained.error, undefined); assert.equal(drained.pagination?.requested_page_size, 1);
    cursor = drained.pagination!.next_cursor!;
  }
  assert.equal(internals(f.gateway).store.get(cursor).value.loaded, false);
  return cursor;
}

test('S2: an unloaded page requires fresh metadata; a failed refresh preserves its handle', async t => {
  const f = await fixture(t); t.after(f.close);
  const cursor = await upstreamCursor(f);
  f.advance(METADATA_TTL + 1);
  f.state.metadataStatus = 500;
  const before = f.state.clinicalCalls;
  const failed = await f.gateway.execute('fhir_page', { cursor });
  assert.equal(failed.error?.code, 'UPSTREAM_ERROR');
  assert.equal(f.state.clinicalCalls, before);
  assert.doesNotThrow(() => internals(f.gateway).store.get(cursor));
  f.state.metadataStatus = 0;
  const good = await f.gateway.execute('fhir_page', { cursor });
  assert.equal(good.error, undefined);
  assert.equal(f.state.clinicalCalls, before + 1);
  assert.equal(f.state.metadataCalls, 3);
});

test('S2: an unloaded page never sends its old query after a material refresh', async t => {
  const f = await fixture(t); t.after(f.close);
  const cursor = await upstreamCursor(f);
  f.advance(METADATA_TTL + 1);
  obsParams(f.state.metadata).push({ name: 'status', type: 'token' });
  const before = f.state.clinicalCalls;
  const page = await f.gateway.execute('fhir_page', { cursor });
  assert.equal(page.error?.code, 'RESULT_EXPIRED');
  assert.equal(f.state.metadataCalls, 2);
  assert.equal(f.state.clinicalCalls, before);
});

test('S2: an old shared page flight cannot update, retain, evict or return evidence after refresh', async t => {
  const f = await fixture(t); t.after(f.close);
  const cursor = await upstreamCursor(f);
  f.state.holdNextClinical = true;
  const stale = f.gateway.execute('fhir_page', { cursor });
  await waitUntil(() => f.state.held.length === 1, 'held page response');
  const joined = f.gateway.execute('fhir_page', { cursor });
  // Wait for the second caller to join the same flight, not a timer heuristic.
  await waitUntil(() => (f.gateway as unknown as { pageLoads: Map<string, { waiters: number }> }).pageLoads.get(cursor)?.waiters === 2, 'two page waiters');
  f.advance(METADATA_TTL + 1);
  obsParams(f.state.metadata).push({ name: 'status', type: 'token' });
  await f.warm();
  const fresh = await f.search();
  const size = clinicalSize(f.gateway);
  const bytes = internals(f.gateway).retentionLedger.usedBytes();
  f.releaseHeld();
  for (const result of await Promise.all([stale, joined])) {
    assert.equal(result.error?.code, 'CONNECTION_REQUIRED');
    assert.deepEqual(result.data, {});
    assert.equal(result.result, undefined);
  }
  assert.equal(clinicalSize(f.gateway), size);
  assert.equal(internals(f.gateway).retentionLedger.usedBytes(), bytes);
  assert.equal((await f.gateway.execute('fhir_result', { handle: fresh.result!.handle })).error, undefined);
});

test('S2: close prevents a held metadata flight from installing its cache', async t => {
  const f = await fixture(t); t.after(f.close);
  f.state.holdNextMetadata = true;
  const stale = f.gateway.execute('fhir_capabilities', { topic: 'server' });
  await waitUntil(() => f.state.heldMetadata.length === 1, 'held metadata');
  f.gateway.close();
  f.releaseMetadata();
  assert.equal((await stale).error?.code, 'CONNECTION_REQUIRED');
  assert.equal(internals(f.gateway).capabilities, undefined);
  assert.equal(internals(f.gateway).metadataExpiresAt, 0);
  assert.equal(clinicalSize(f.gateway), 0);
});

test('S2: a policy change during metadata flight cannot install or evict fresh state', async t => {
  const f = await fixture(t); t.after(f.close);
  await f.warm();
  f.advance(METADATA_TTL + 1);
  f.state.holdNextMetadata = true;
  const stale = f.gateway.execute('fhir_capabilities', { topic: 'server' });
  await waitUntil(() => f.state.heldMetadata.length === 1, 'held policy-old metadata');
  internals(f.gateway).policyRevision = 'synthetic-next';
  const fresh = await f.search();
  assert.equal(f.state.metadataCalls, 3, 'new generation did not join old flight');
  const freshCache = internals(f.gateway).capabilities;
  const size = clinicalSize(f.gateway);
  const expiry = internals(f.gateway).metadataExpiresAt;
  f.releaseMetadata();
  assert.equal((await stale).error?.code, 'CONNECTION_REQUIRED');
  assert.equal(internals(f.gateway).capabilities, freshCache);
  assert.equal(internals(f.gateway).metadataExpiresAt, expiry);
  assert.equal(clinicalSize(f.gateway), size);
  assert.equal((await f.gateway.execute('fhir_result', { handle: fresh.result!.handle })).error, undefined);
});

test('S2: concurrent refresh callers adopt only their refresh generation and resume on new state', async t => {
  const { f } = await established(t);
  f.state.holdNextMetadata = true;
  obsParams(f.state.metadata).push({ name: 'status', type: 'token' });
  const refresh = f.gateway.execute('fhir_capabilities', { topic: 'server' });
  await waitUntil(() => f.state.heldMetadata.length === 1, 'held refresh');
  const searching = f.gateway.execute('fhir_search', { resource_type: 'Observation' });
  const describing = f.gateway.execute('fhir_capabilities', { topic: 'resource', resource_type: 'Observation' });
  f.releaseMetadata();
  const results = await Promise.all([refresh, searching, describing]);
  for (const result of results) {
    assert.equal(result.error, undefined);
    assert.equal(result.source.capability_revision, results[0]!.source.capability_revision);
  }
  assert.equal(f.state.metadataCalls, 2, 'refresh was single-flight');
  assert.equal(internals(f.gateway).stateGeneration, 1);
});

test('S2: malformed metadata refresh installs nothing, extends no TTL and preserves retained evidence', async t => {
  const { f, res, cursor, revision } = await established(t);
  const expiry = internals(f.gateway).metadataExpiresAt;
  f.state.metadata.fhirVersion = 'invalid';
  const failed = await f.gateway.execute('fhir_capabilities', { topic: 'server' });
  assert.equal(failed.error?.code, 'UNSUPPORTED_FHIR_VERSION');
  assert.equal(internals(f.gateway).metadataExpiresAt, expiry);
  assert.equal(internals(f.gateway).capabilityRevision, revision);
  assert.doesNotThrow(() => internals(f.gateway).store.get(cursor));
  assert.equal((await f.gateway.execute('fhir_result', { handle: res.handle })).error, undefined);
  f.state.metadata.fhirVersion = '4.0.1';
  await f.warm();
  assert.equal(f.state.metadataCalls, 3);
  await assertHandlesAlive(f.gateway, res, cursor);
});

test('S2: documentation bytes never reach cache, snapshots, tool output or audit/log records', async t => {
  const f = await fixture(t); t.after(f.close);
  const logs: unknown[] = [];
  for (const method of ['log', 'warn', 'error', 'info', 'debug'] as const) t.mock.method(console, method, (...args: unknown[]) => { logs.push(args); });
  const warm = await f.warm();
  const first = await f.search();
  const snapshot = internals(f.gateway).store.get(first.pagination!.next_cursor!);
  const revision = warm.source.capability_revision;
  f.advance(METADATA_TTL + 1);
  const params = obsParams(f.state.metadata);
  for (const param of params) param.documentation = `changed ${DOC_CANARY}`;
  f.state.metadata.documentation = DOC_CANARY;
  const refreshed = await f.warm();
  assert.equal(f.state.metadataCalls, 2);
  assert.equal(refreshed.source.capability_revision, revision);
  const cache = [...internals(f.gateway).capabilities!.values()];
  const outputs = [warm, first, refreshed].map(e => f.gateway.toToolResult(e));
  for (const value of [cache, snapshot, outputs, f.gateway.auditEvents, logs, internals(f.gateway).sourceIdentity]) assert.equal(JSON.stringify(value).includes(DOC_CANARY), false);
});

test('S2: bounded source binding keeps exact safe identities and never truncates oversized values', async t => {
  const f = await fixture(t); t.after(f.close);
  await f.warm();
  // F-06 (B2 harness review): source software identity is retained only as keyed process-local digests.
  // S6: the identity also carries the normalized capability revision, which binds a qualified profile's proof.
  const revisionOf = () => (internals(f.gateway) as unknown as { capabilityRevision: string }).capabilityRevision;
  assert.deepEqual(internals(f.gateway).sourceIdentity, { digested: true, software: sourceIdentityDigest('s2 fixture software'), softwareVersion: sourceIdentityDigest('1.0'), fhirVersion: '4.0.1', revision: revisionOf() });
  assert.equal(JSON.stringify(internals(f.gateway).sourceIdentity).includes('s2 fixture software'), false);
  f.advance(METADATA_TTL + 1);
  f.state.metadata.software = { name: 'x'.repeat(257), version: '1.0\n' };
  await f.warm();
  assert.deepEqual(internals(f.gateway).sourceIdentity, { digested: true, software: undefined, softwareVersion: undefined, fhirVersion: '4.0.1', revision: revisionOf() });
});

test('S2: shuffled conflicting declarations preserve the normalized revision and conflict flag', async t => {
  const f = await fixture(t); t.after(f.close);
  obsParams(f.state.metadata).push({ name: 'code', type: 'string', definition: `${SP}/clinical-code`, documentation: DOC_CANARY });
  const first = await f.warm();
  const declared = clone(internals(f.gateway).capabilities!.get('Observation')!.declared);
  f.advance(METADATA_TTL + 1);
  obsParams(f.state.metadata).reverse();
  const second = await f.warm();
  assert.equal(f.state.metadataCalls, 2);
  assert.equal(first.source.capability_revision, second.source.capability_revision);
  const after = internals(f.gateway).capabilities!.get('Observation')!.declared as { name: string; duplicate_conflict?: boolean }[];
  assert.deepEqual([...after].sort((a, b) => a.name.localeCompare(b.name)), [...declared as typeof after].sort((a, b) => a.name.localeCompare(b.name)));
  assert.equal(after.find(p => p.name === 'code')!.duplicate_conflict, true);
});

test('S2: conflicting reference declarations veto bare foreign patient ids in every order', async t => {
  for (const type of ['composite', 'date', 'number', 'quantity']) {
    for (const referenceFirst of [false, true]) await t.test(`${type}, reference ${referenceFirst ? 'first' : 'last'}`, async st => {
      const f = await fixture(st); st.after(f.close);
      const declarations = [{ name: 'performer', type }, { name: 'performer', type: 'reference' }];
      obsParams(f.state.metadata).push(...(referenceFirst ? declarations.reverse() : declarations));
      const search = (value: string) => f.gateway.execute('fhir_search', { resource_type: 'Observation', params: [{ name: 'performer', value }] });
      const denied = await search('synthetic-patient-b');
      assert.equal(denied.error?.code, 'SEARCH_PARAMETER_UNRESOLVED');
      assert.equal(f.state.clinicalCalls, 0, 'conflicting metadata has no search authority');
      const bound = await search(a);
      assert.equal(bound.error?.code, 'SEARCH_PARAMETER_UNRESOLVED', 'S3 rejects both values under conflicting typing');
      assert.equal(f.state.clinicalCalls, 0);
    });
  }
});

test('S2: repeated resource types refuse only the ambiguous type in every declaration order', async t => {
  const f = await fixture(t); t.after(f.close);
  const declarations = ['read', 'search-type', undefined].map(code => ({
    type: 'Observation', interaction: code ? [{ code }] : [], searchParam: clone(BASE_PARAMS),
  }));
  const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  let revision: string | undefined;
  for (const order of orders) {
    resourcesOf(f.state.metadata).splice(1, Infinity, ...order.map(i => declarations[i]!));
    f.advance(METADATA_TTL + 1);
    const server = await f.warm();
    if (revision) assert.equal(server.source.capability_revision, revision, 'ambiguous authority is independent of all declaration orders');
    revision = server.source.capability_revision;
    const before = f.state.clinicalCalls;
    for (const topic of ['resource', 'schema']) {
      assert.equal((await f.gateway.execute('fhir_capabilities', { topic, resource_type: 'Observation' })).error?.code, 'INVALID_RESPONSE');
    }
    assert.equal((await f.gateway.execute('fhir_search', { resource_type: 'Observation' })).error?.code, 'INVALID_RESPONSE');
    assert.equal((await f.gateway.execute('fhir_read', { resource_type: 'Observation', id: 'obs-a' })).error?.code, 'INVALID_RESPONSE');
    assert.equal(f.state.clinicalCalls, before, 'no ambiguous resource request reaches upstream');
    const unaffected = await f.gateway.execute('fhir_search', { resource_type: 'Patient' });
    assert.equal(unaffected.error, undefined, 'unambiguous types remain usable');
    assert.equal(f.state.clinicalCalls, before + 1);
  }
});

test('S2: entering and leaving repeated-type ambiguity changes revision even for empty declarations', async t => {
  const f = await fixture(t); t.after(f.close);
  const empty = { type: 'Condition', interaction: [], searchParam: [] };
  resourcesOf(f.state.metadata).push(empty);
  const initial = await f.search();
  f.advance(METADATA_TTL + 1);
  resourcesOf(f.state.metadata).push(clone(empty));
  const ambiguous = await f.warm();
  assert.notEqual(ambiguous.source.capability_revision, initial.source.capability_revision);
  assert.equal((await f.gateway.execute('fhir_result', { handle: initial.result!.handle })).error?.code, 'RESULT_EXPIRED');
  const during = await f.search();
  f.advance(METADATA_TTL + 1);
  resourcesOf(f.state.metadata).pop();
  const restored = await f.warm();
  assert.equal(restored.source.capability_revision, initial.source.capability_revision);
  assert.equal((await f.gateway.execute('fhir_result', { handle: during.result!.handle })).error?.code, 'RESULT_EXPIRED');
});

test('S2: non-array resource declarations refuse discovery without replacing retained state', async t => {
  for (const malformed of [{ type: 'Observation', interaction: [{ code: 'search-type' }], searchParam: clone(BASE_PARAMS) }, null, 'Observation']) {
    await t.test(malformed === null ? 'null' : typeof malformed, async st => {
      const { f, first, revision, res, cursor } = await established(st);
      const original = clone(f.state.metadata);
      const cache = internals(f.gateway).capabilities;
      const expiry = internals(f.gateway).metadataExpiresAt;
      (f.state.metadata.rest as Record<string, unknown>[])[0]!.resource = malformed;
      const before = f.state.clinicalCalls;
      const refused = await f.gateway.execute('fhir_search', { resource_type: 'Observation' });
      assert.equal(refused.error?.code, 'INVALID_RESPONSE');
      assert.equal(f.state.clinicalCalls, before);
      assert.equal(internals(f.gateway).capabilities, cache);
      assert.equal(internals(f.gateway).metadataExpiresAt, expiry);
      assert.equal(internals(f.gateway).capabilityRevision, revision);
      await assertHandlesAlive(f.gateway, res, cursor);
      f.state.metadata = original;
      assert.equal((await f.warm()).source.capability_revision, first.source.capability_revision);
    });
  }
});

test('S2: a superseded metadata search waiter sends no clinical request', async t => {
  const { f } = await established(t);
  const gateway = f.gateway as unknown as { raceBudget(promise: Promise<unknown>, budget: unknown): Promise<unknown> };
  const originalRace = gateway.raceBudget.bind(gateway);
  let held = false; let holdNext = true; let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  gateway.raceBudget = async (promise, budget) => {
    const value = await originalRace(promise, budget);
    if (holdNext) { holdNext = false; held = true; await hold; }
    return value;
  };
  obsParams(f.state.metadata).push({ name: 'status', type: 'token' });
  const old = f.gateway.execute('fhir_search', { resource_type: 'Observation', params: [{ name: 'code', value: 'http://loinc.org|4548-4' }] }, { deadlineMs: 200000 });
  await waitUntil(() => held, 'waiter held after its shared flight installed generation one');
  f.advance(METADATA_TTL + 1);
  obsParams(f.state.metadata).push({ name: 'category', type: 'token' });
  await f.warm();
  const before = f.state.clinicalCalls;
  release();
  const stale = await old;
  assert.equal(stale.error?.code, 'CONNECTION_REQUIRED');
  assert.equal(f.state.clinicalCalls, before, 'superseded waiter performed no clinical fetch');
});

test('S2: an old metadata flight cannot reinstall capability state after a credential epoch change', async t => {
  const f = await authFixture(t);
  assert.equal((await f.search()).error, undefined);
  f.holdClinical();
  const rejected = f.search();
  await waitUntil(() => f.heldClinical.length === 1, 'held clinical rejection');
  f.advance(METADATA_TTL + 1);
  f.holdMetadata();
  const staleMetadata = f.gateway.execute('fhir_capabilities', { topic: 'server' });
  await waitUntil(() => f.heldMetadata.length === 1, 'held metadata in old auth epoch');
  f.release401();
  assert.equal((await rejected).error?.code, 'CONNECTION_REQUIRED');
  const fresh = await f.search();
  assert.equal(fresh.error, undefined);
  assert.equal(f.tokenCalls(), 2);
  assert.equal(f.metadataCalls(), 3);
  const cache = internals(f.gateway).capabilities;
  const size = clinicalSize(f.gateway);
  f.releaseMetadata();
  assert.equal((await staleMetadata).error?.code, 'CONNECTION_REQUIRED');
  assert.equal(internals(f.gateway).capabilities, cache);
  assert.equal(clinicalSize(f.gateway), size);
  assert.equal((await f.gateway.execute('fhir_result', { handle: fresh.result!.handle })).error, undefined);
});

test('S2: a plain metadata 403 does not become a refresh event or invalidate retained state', async t => {
  const f = await authFixture(t);
  const first = await f.search();
  f.advance(METADATA_TTL + 1);
  const generation = internals(f.gateway).stateGeneration;
  const expiry = internals(f.gateway).metadataExpiresAt;
  f.rejectMetadata(403);
  const failed = await f.gateway.execute('fhir_capabilities', { topic: 'server' });
  assert.ok(failed.error);
  assert.equal(f.metadataCalls(), 2);
  assert.equal(f.tokenCalls(), 1);
  assert.equal(internals(f.gateway).metadataExpiresAt, expiry);
  assert.equal(internals(f.gateway).stateGeneration, generation);
  assert.equal((await f.gateway.execute('fhir_result', { handle: first.result!.handle })).error, undefined);
  f.rejectMetadata();
  assert.equal((await f.search()).error, undefined);
  assert.equal(f.metadataCalls(), 3);
  assert.equal(f.tokenCalls(), 1);
});

test('S2: permission flags alone change identity in both directions', async t => {
  for (const flag of ['definition_withheld', 'type_invalid', 'duplicate_conflict']) await t.test(flag, async st => {
    const f = await fixture(st); st.after(f.close);
    const param = obsParams(f.state.metadata).find(p => p.name === 'code')!;
    if (flag === 'definition_withheld') delete param.definition;
    if (flag === 'type_invalid') delete param.type;
    const original = clone(f.state.metadata);
    const first = await f.search();
    const before = clone(internals(f.gateway).capabilities!.get('Observation')!.declared) as Record<string, unknown>[];
    f.advance(METADATA_TTL + 1);
    if (flag === 'definition_withheld') param.definition = 'https://example.test/SearchParameter?protected=1';
    if (flag === 'type_invalid') param.type = 42;
    // Lexically later canonical leaves the existing representative unchanged; only the flag differs.
    if (flag === 'duplicate_conflict') obsParams(f.state.metadata).push({ ...param, definition: `${SP}/zz-conflict` });
    const changed = await f.warm();
    const after = clone(internals(f.gateway).capabilities!.get('Observation')!.declared) as Record<string, unknown>[];
    assert.equal(after.find(p => p.name === 'code')![flag], true);
    delete after.find(p => p.name === 'code')![flag];
    assert.deepEqual(after, before, 'the permission flag is the only normalized difference');
    assert.notEqual(changed.source.capability_revision, first.source.capability_revision);
    assert.equal((await f.gateway.execute('fhir_result', { handle: first.result!.handle })).error?.code, 'RESULT_EXPIRED');
    const refused = await f.gateway.execute('fhir_search', { resource_type: 'Observation', params: [{ name: 'code', value: 'http://loinc.org|4548-4' }] });
    assert.equal(refused.error?.code, 'SEARCH_PARAMETER_UNRESOLVED', 'S3 fails closed on permission flags');
    // Use an unaffected parameter to retain a handle under the intermediate revision.
    const intermediate = await f.gateway.execute('fhir_search', { resource_type: 'Observation' });
    assert.equal(intermediate.error, undefined);
    assert.ok(intermediate.result?.handle);
    f.state.metadata = original;
    f.advance(METADATA_TTL + 1);
    const restored = await f.warm();
    assert.equal(restored.source.capability_revision, first.source.capability_revision);
    assert.equal((await f.gateway.execute('fhir_result', { handle: intermediate.result!.handle })).error?.code, 'RESULT_EXPIRED');
  });
});

test('S2: metadata TTL is absolute, expires at the boundary and starts at successful installation', async t => {
  const f = await fixture(t); t.after(f.close);
  await f.warm();
  const initialExpiry = internals(f.gateway).metadataExpiresAt;
  assert.equal(initialExpiry, Date.now() + METADATA_TTL);
  f.advance(METADATA_TTL - 1);
  await f.warm();
  assert.equal(f.state.metadataCalls, 1);
  assert.equal(internals(f.gateway).metadataExpiresAt, initialExpiry, 'cache hits do not slide TTL');
  f.advance(1);
  f.state.holdNextMetadata = true;
  const refresh = f.warm();
  await waitUntil(() => f.state.heldMetadata.length === 1, 'refresh at exact TTL boundary');
  f.advance(500);
  f.releaseMetadata();
  await refresh;
  assert.equal(f.state.metadataCalls, 2);
  assert.equal(internals(f.gateway).metadataExpiresAt, Date.now() + METADATA_TTL, 'TTL starts after successful metadata installation');
});

test('S2: a settled metadata waiter cannot adopt an unrelated newer generation', async t => {
  const { f } = await established(t);
  const gateway = f.gateway as unknown as { raceBudget(promise: Promise<unknown>, budget: unknown): Promise<unknown> };
  const originalRace = gateway.raceBudget.bind(gateway);
  let held = false;
  let holdNext = true;
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  gateway.raceBudget = async (promise, budget) => {
    const value = await originalRace(promise, budget);
    if (holdNext) { holdNext = false; held = true; await hold; }
    return value;
  };
  obsParams(f.state.metadata).push({ name: 'status', type: 'token' });
  const old = f.gateway.execute('fhir_capabilities', { topic: 'server' });
  await waitUntil(() => held, 'waiter held after its shared flight installed generation one');
  f.advance(METADATA_TTL + 1);
  obsParams(f.state.metadata).push({ name: 'category', type: 'token' });
  const current = await f.search();
  const cache = internals(f.gateway).capabilities;
  const size = clinicalSize(f.gateway);
  release();
  const stale = await old;
  assert.equal(stale.error?.code, 'CONNECTION_REQUIRED');
  assert.deepEqual(stale.data, {});
  assert.equal(internals(f.gateway).capabilities, cache);
  assert.equal(clinicalSize(f.gateway), size);
  assert.equal((await f.gateway.execute('fhir_result', { handle: current.result!.handle })).error, undefined);
});

test('S2: multiple server blocks are refused in every order, including a type only in the second block', async t => {
  const f = await fixture(t); t.after(f.close);
  const original = clone(f.state.metadata);
  const extra = { mode: 'server', resource: [{ type: 'Condition', interaction: [{ code: 'search-type' }], searchParam: clone(BASE_PARAMS) }] };
  const server = (original.rest as unknown[])[0]!;
  for (const rest of [[server, extra], [extra, server]]) {
    f.state.metadata.rest = rest;
    const denied = await f.gateway.execute('fhir_capabilities', { topic: 'resource', resource_type: 'Condition' });
    assert.equal(denied.error?.code, 'INVALID_RESPONSE');
    assert.equal((await f.gateway.execute('fhir_search', { resource_type: 'Condition' })).error?.code, 'INVALID_RESPONSE');
    assert.equal(f.state.clinicalCalls, 0);
  }
  f.state.metadata = original;
  (f.state.metadata.rest as unknown[]).unshift({ mode: 'client', resource: extra.resource });
  assert.equal((await f.warm()).data.resource_count, 2, 'one well-formed server block plus a client block is valid');
  assert.equal((await f.gateway.execute('fhir_capabilities', { topic: 'resource', resource_type: 'Condition' })).error?.code, 'UNSUPPORTED_RESOURCE');
});
