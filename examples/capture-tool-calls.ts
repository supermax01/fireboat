/** Literal synthetic SDK examples: fixed clock and fixed randomness, production factory only. */
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
let sequence = 0;
crypto.randomUUID = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;
crypto.randomBytes = ((size: number) => Buffer.alloc(size, ++sequence % 256)) as typeof crypto.randomBytes;
syncBuiltinESMExports();
const NativeDate = Date, instant = NativeDate.parse('2026-10-19T12:00:00Z');
globalThis.Date = class extends NativeDate {
  constructor(...args: any[]) { super(...(args.length ? args : [instant]) as [any]); }
  static now() { return instant; }
} as DateConstructor;
const { Client, InMemoryTransport } = await import('@modelcontextprotocol/client');
const { serveStdio } = await import('@modelcontextprotocol/server/stdio');
const { FhirGateway } = await import('../packages/core/src/index.js');
const { createMcpServer } = await import('../packages/server/src/index.js');
const { startSyntheticFhirServer } = await import('./synthetic-server.js');
const eras: Record<string, Record<string, unknown>[]> = {};
for (const era of ['modern','legacy'] as const) {
const source = await startSyntheticFhirServer();
const gateway = new FhirGateway({ mode: 'synthetic', source: { alias: 'local-synthetic', baseUrl: source.baseUrl }, patientId: 'synthetic-patient-a', contextId: 'ctx_example' });
const [a,b] = InMemoryTransport.createLinkedPair();
const server = serveStdio(() => createMcpServer(gateway, { era }), { transport: b });
const client = new Client({ name: 'literal-synthetic-examples', version: '1' }, era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : undefined);
const calls: Record<string, unknown>[] = [];
try {
  await client.connect(a);
  const call = async (name: string, input: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: input });
    calls.push({ name, arguments: input, result });
    return result.structuredContent as Record<string, any>;
  };
  await call('fhir_capabilities', { topic: 'server' });
  const serverPage = await call('fhir_capabilities', { topic: 'server', limit: 1 });
  await call('fhir_capabilities', { topic: 'server', cursor: serverPage.data.next_cursor, limit: 1 });
  await call('fhir_capabilities', { topic: 'support', limit: 25, output: { max_bytes: 6000 } });
  await call('fhir_capabilities', { topic: 'resource', resource_type: 'Observation' });
  await call('fhir_capabilities', { topic: 'schema', resource_type: 'Observation', limit: 2 });
  const search = await call('fhir_search', { resource_type: 'Observation', page_size: 1 });
  await call('fhir_page', { cursor: search.pagination.next_cursor });
  await call('fhir_read', { resource_type: 'Observation', id: 'synthetic-obs-a1' });
  await call('fhir_result', { handle: search.result.handle, action: 'inspect' });
  await call('fhir_result', { handle: search.result.handle, action: 'project', fields: ['code','status','valueQuantity'] });
  await call('fhir_search', { resource_type: 'Observation', params: [{ name: 'code:text', value: 'HbA1c' }] });
} finally { await client.close(); await server.close(); gateway.close(); await source.close(); }
eras[era] = calls;
}
const text = JSON.stringify({ schema_version: '0.3', synthetic_only: true, captured_at: '2026-10-19T12:00:00.000Z', era: 'modern', calls: eras.modern, legacy_calls: eras.legacy }, null, 2) + '\n';
const path = resolve('examples/tool-calls.json');
if (process.argv.includes('--check')) {
  if (await readFile(path, 'utf8') !== text) throw new Error('Literal SDK examples are stale; rerun examples/capture-tool-calls.ts.');
  process.stdout.write(`literal SDK examples in sync (${eras.modern!.length} calls per era)\n`);
} else { await writeFile(path, text); process.stdout.write(`captured ${eras.modern!.length} literal synthetic SDK calls per era\n`); }
