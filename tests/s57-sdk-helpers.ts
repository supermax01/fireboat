// Synthetic-only acceptance harness. The production factory and execute path
// are unmodified; reflection only observes their original trusted capture.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { FhirGateway } from '../packages/core/src/index.js';
import { createMcpServer } from '../packages/server/src/index.js';
import { validateDeliverable02, type GatewayConfig, type ToolName, type ValidationContext02, type GatewayEnvelope02 } from '../packages/core/src/contracts.js';
import { declaredSearchProfile } from '../packages/core/src/query.js';

export type Rec = Record<string, any>;
export const patient = 'synthetic-a', context = 'ctx_s57b', sourceAlias = 's57b';
export const output = { format: 'fhir' as const, max_bytes: 24576 };
export const hba1c = [{ name: 'code', value: 'http://loinc.org|4548-4' }, { name: 'date', value: 'ge2020-01-01' }, { name: 'date', value: 'lt2026-01-01' }, { name: '_sort', value: '-date' }];
export const lab = (id = 'synthetic-lab', extra: Rec = {}): Rec => ({ resourceType: 'Observation', id,
  meta: { versionId: '7', profile: ['http://example.test/lab'], security: [{ code: 'N' }], tag: [{ code: 'SUBSETTED' }] },
  status: 'corrected', _status: { id: 'status-companion' }, subject: { reference: `Patient/${patient}` },
  code: { coding: [{ system: 'http://loinc.org', version: '2.78', code: '4548-4', display: 'A1c', userSelected: true }], text: 'A1c' },
  valueQuantity: { value: 7, comparator: '>=', unit: '%', system: 'http://unitsofmeasure.org', code: '%' },
  effectiveDateTime: '2025-02-10T08:00:00+10:30', _effectiveDateTime: { id: 'time-companion' },
  referenceRange: [{ high: { value: 5.6, system: 'http://unitsofmeasure.org', code: '%' }, text: 'Synthetic range' }],
  component: [{ code: { coding: [{ system: 'http://loinc.org', version: '2.78', code: '8480-6' }] }, valueQuantity: { value: 120, comparator: '<', system: 'http://unitsofmeasure.org', code: 'mm[Hg]' } }],
  identifier: [{ value: 'synthetic-accession' }], ...extra });

export interface FixtureOptions {
  pages?: Rec[][]; records?: Rec[]; shared?: boolean; profile?: boolean; structured?: boolean;
  corruptor?: (envelope: GatewayEnvelope02, phase: 'construction' | 'success' | 'error') => void;
  limits?: GatewayConfig['limits']; outcome?: Rec; raw?: (body: string) => string;
  patientParameters?: { name: string; type: string }[];
}
export async function withGateway<T>(options: FixtureOptions, fn: (gateway: FhirGateway, requests: URL[]) => Promise<T>): Promise<T> {
  const pages = options.pages ?? [[lab()]], records = options.records ?? pages.flat();
  const requests: URL[] = []; let base = '';
  const source = createServer((req, res) => {
    const url = new URL(req.url!, base); requests.push(url); res.setHeader('content-type', 'application/fhir+json');
    if (url.pathname.endsWith('/metadata')) {
      res.end(JSON.stringify({ resourceType: 'CapabilityStatement', fhirVersion: '4.0.1', software: { name: 's57b synthetic fixture', version: '1' }, rest: [{ mode: 'server', resource: [
        { type: 'Observation', interaction: [{ code: 'read' }, { code: 'search-type' }], searchParam: ['patient','subject','code','date','status'].map(name => ({ name, type: name === 'date' ? 'date' : ['code','status'].includes(name) ? 'token' : 'reference' })) },
        { type: 'Organization', interaction: [{ code: 'read' }, { code: 'search-type' }] },
        { type: 'Patient', interaction: [{ code: 'read' }, { code: 'search-type' }], searchParam: [{ name: 'link', type: 'reference' }, ...(options.patientParameters ?? [])] },
      ] }] })); return;
    }
    let body: unknown;
    const read = /\/(Observation|Organization|Patient)\/([A-Za-z0-9.-]+)$/.exec(url.pathname);
    if (read) {
      body = records.find(record => record.resourceType === read[1] && record.id === read[2]);
      if (!body) { res.statusCode = 404; body = { resourceType: 'OperationOutcome' }; }
    } else {
      const index = Number(url.searchParams.get('_offset') ?? 0), next = new URL(url); next.searchParams.set('_offset', String(index + 1));
      const entry: Rec[] = (pages[index] ?? []).map(resource => ({ search: { mode: 'match' }, resource }));
      if (options.outcome) entry.push({ search: { mode: 'outcome' }, resource: options.outcome });
      body = { resourceType: 'Bundle', type: 'searchset', link: [{ relation: 'self', url: url.href }, ...(index + 1 < pages.length ? [{ relation: 'next', url: next.href }] : [])], entry };
    }
    const text = JSON.stringify(body); res.end(options.raw ? options.raw(text) : text);
  });
  await new Promise<void>(resolve => source.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(source.address() as { port: number }).port}/fhir/`;
  const profile = { ...declaredSearchProfile('synthetic-fixture-r4-v1')!, id: 'private-s57b', eligible: false, evidence: null,
    source: { software: 's57b synthetic fixture', software_version: '1', fhir_version: '4.0.1' } };
  const registry = { profileId: 's57b-fixture', entries: ['modern','legacy'].map(era => ({ id: 's57b-fixture', version: '1', host: { name: 'synthetic', version: '1', client_stack: 'synthetic', client_stack_version: '1' },
    era, transport: 'stdio', workflow: 'recent-labs-v1', delivery_profile: 'structured-evidence-v1', verification: 'fixture_only' })) };
  const gateway = new FhirGateway({ mode: 'synthetic', source: { alias: sourceAlias, baseUrl: base }, patientId: patient, contextId: context, limits: options.limits,
    ...(options.structured ? { delivery: { profile: 'structured-evidence-v1', hostProfileId: 's57b-fixture' } } : {}) },
  { ...(options.profile ? { testQueryProfile: profile } : {}), ...(options.structured ? { testDeliveryRegistryOverride: registry as never } : {}),
    ...(options.corruptor ? { testEnvelopeCorruptor: options.corruptor } : {}) });
  try { return await fn(gateway, requests); }
  finally { gateway.close(); source.closeAllConnections(); await new Promise<void>(resolve => source.close(() => resolve())); }
}

export async function withSdk<T>(gateway: FhirGateway, era: 'modern' | 'legacy', fn: (sdk: Awaited<ReturnType<typeof openSdk>>) => Promise<T>): Promise<T> {
  const sdk = await openSdk(gateway, era);
  try { return await fn(sdk); } finally { await sdk.close(); }
}
async function openSdk(gateway: FhirGateway, era: 'modern' | 'legacy') {
  const [a,b] = InMemoryTransport.createLinkedPair(); let wire: Rec | undefined, raw = '';
  const send = b.send.bind(b); b.send = async (message, opts) => { if ('result' in message) { wire = message.result as Rec; raw = JSON.stringify(message); } await send(message, opts); };
  let capture: ValidationContext02 | undefined;
  const toResult = gateway.toToolResult.bind(gateway);
  gateway.toToolResult = (envelope, opts) => { capture = (gateway as unknown as { capturesV2: WeakMap<GatewayEnvelope02, ValidationContext02> }).capturesV2.get(envelope); return toResult(envelope, opts); };
  const server = serveStdio(() => createMcpServer(gateway, { era }), { transport: b });
  const client = new Client({ name: 's57b-synthetic-acceptance', version: '1' }, era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : undefined);
  await client.connect(a);
  return { client, async call(tool: ToolName, args: Rec) {
    const result = await client.callTool({ name: tool, arguments: args });
    assert.ok(capture && wire, 'production capture and actual SDK response exist');
    assert.equal(JSON.stringify(wire), JSON.stringify(capture.result), 'actual SDK response equals the trusted complete capture');
    assert.deepEqual(validateDeliverable02(tool, wire.structuredContent, capture), { ok: true }, 'actual SDK output passes the frozen final gate with its original context');
    const e = result.structuredContent as Rec;
    assert.equal(Buffer.byteLength(JSON.stringify(wire)), e.budget.bytes_returned);
    assert.ok(e.budget.bytes_returned <= e.budget.byte_limit);
    assert.equal(result.isError, e.error ? true : undefined);
    return { e, result, wire, raw, capture };
  }, async close() { gateway.toToolResult = toResult; await client.close(); await server.close(); } };
}
