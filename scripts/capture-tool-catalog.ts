/**
 * S5 catalog gate. Run after `npm run build` with Node 24.22.0:
 *   node --import tsx scripts/capture-tool-catalog.ts <empty-output-directory>
 *
 * The cap boundary is guidance §5: compact {serverInfo,capabilities,instructions,tools}.
 * Discovery results, SDK response/cache metadata and JSON-RPC/LF framing are ALSO
 * captured without projection, but measured separately from that catalog boundary.
 * No tool is called; no upstream server or host verification is involved.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import type { JSONRPCMessage, Transport } from '@modelcontextprotocol/server';

type Rec = Record<string, unknown>;
type File = { path: string; sha256: string; bytes: number };
type Frame = { direction: 'client' | 'server'; message: Rec };
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(process.argv[2] ?? '');
assert.equal(process.argv.length, 3, 'Usage: capture-tool-catalog.ts <empty-output-directory>');
assert.equal(process.version, 'v24.22.0', 'Use reference Node 24.22.0');
await mkdir(out, { recursive: true });
assert.equal((await readdir(out)).length, 0, 'Output directory must be empty (no stale captures)');
const hash = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const write = async (path: string, value: unknown, text = false): Promise<File> => {
  const bytes = text ? String(value) : JSON.stringify(value);
  await mkdir(dirname(resolve(out, path)), { recursive: true });
  await writeFile(resolve(out, path), bytes, 'utf8');
  return { path, sha256: hash(bytes), bytes: Buffer.byteLength(bytes) };
};
// Import compiled production code, not a scratch registration or a copied schema.
const { FhirGateway, OUTPUT_SPINE } = await import(pathToFileURL(resolve(root, 'dist/packages/core/src/index.js')).href) as typeof import('../packages/core/src/index.js');
const { HOST_PROFILE_REGISTRY } = await import(pathToFileURL(resolve(root, 'dist/packages/core/src/delivery.js')).href) as typeof import('../packages/core/src/delivery.js');
const { createMcpServer } = await import(pathToFileURL(resolve(root, 'dist/packages/server/src/index.js')).href) as typeof import('../packages/server/src/index.js');
const sdk: Record<string, string> = {};
for (const name of ['client', 'server']) {
  const pkg = JSON.parse(await readFile(resolve(root, `node_modules/@modelcontextprotocol/${name}/package.json`), 'utf8')) as { version: string };
  assert.equal(pkg.version, '2.3.1', `Unexpected SDK ${name}`);
  sdk[name] = pkg.version;
}
const sourcePaths = new Set([
  ...git('ls-files', 'packages', 'package.json', 'package-lock.json', 'tsconfig.build.json').split('\n'),
  'scripts/capture-tool-catalog.ts', 'scripts/measure-tool-catalog.py',
  'scripts/requirements-tokenizers.txt', 'packages/evals/data/tokenizers.lock.json', '.github/workflows/ci.yml',
]);
const inputHashes: File[] = [];
for (const path of [...sourcePaths].sort()) {
  if (!path) continue;
  const bytes = await readFile(resolve(root, path));
  inputHashes.push({ path, bytes: bytes.length, sha256: hash(bytes) });
}
async function builtInputs(dir: string): Promise<File[]> {
  const result: File[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) result.push(...await builtInputs(path));
    else if (entry.isFile()) {
      const bytes = await readFile(path);
      result.push({ path: relative(root, path), bytes: bytes.length, sha256: hash(bytes) });
    }
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}
const captures: Rec[] = [];
// The gateway transport uses node:http(s) and never global fetch, so a fetch stub proves nothing.
// The configured source is a loopback sink that counts TCP connections: FhirTransport accepts only
// this literal loopback origin, so any upstream request made during the capture must reach it.
let upstreamAttempts = 0;
const sink = createServer((_request, response) => { response.statusCode = 503; response.end(); });
sink.on('connection', () => { upstreamAttempts++; });
await new Promise<void>(listening => sink.listen(0, '127.0.0.1', listening));
const sinkBaseUrl = `http://127.0.0.1:${(sink.address() as AddressInfo).port}/fhir`;
try {
  for (const era of ['modern', 'legacy'] as const) {
    // All *selectable* advertised profiles: never enable a fixture-only or
    // unverified structured host to obtain a passing catalog. Currently only
    // full-text-v1 is selectable. Registry provenance is part of the manifest.
    const profiles = [
      { profile: 'full-text-v1' as const, hostProfileId: undefined as string | undefined },
      ...HOST_PROFILE_REGISTRY.filter(p => p.verification === 'verified' && p.era === era && p.delivery_profile === 'structured-evidence-v1')
        .map(p => ({ profile: 'structured-evidence-v1' as const, hostProfileId: p.id })),
    ];
    for (const [index, profile] of profiles.entries()) {
      const id = `${era}-${index}-${profile.profile}`;
      const gateway = new FhirGateway({ mode: 'synthetic', source: { alias: 'catalog-only', baseUrl: sinkBaseUrl }, patientId: 'synthetic-catalog-only', delivery: profile });
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      const frames: Frame[] = [];
      const tap = (transport: Transport, direction: Frame['direction']): void => {
        const send = transport.send.bind(transport);
        transport.send = async (message: JSONRPCMessage, options?: Parameters<Transport['send']>[1]) => {
          frames.push({ direction, message: JSON.parse(JSON.stringify(message)) as Rec });
          return send(message, options);
        };
      };
      tap(clientSide, 'client'); tap(serverSide, 'server');
      const handle = serveStdio(({ era: actual }) => {
        assert.equal(actual, era);
        return createMcpServer(gateway, { era: actual });
      }, { transport: serverSide });
      const client = new Client({ name: 'fireboat-catalog-capture', version: '1' },
        { versionNegotiation: { mode: era === 'modern' ? { pin: '2026-07-28' } : 'legacy' } });
      try {
        await client.connect(clientSide);
        assert.equal(client.getProtocolEra(), era);
        assert.equal(client.getNegotiatedProtocolVersion(), era === 'modern' ? '2026-07-28' : '2025-11-25');
        const tools: Rec[] = [], pages: File[] = [], sdkMetadata: unknown[] = [];
        let cursor: string | undefined;
        const seen = new Set<string>();
        do {
          assert.ok(pages.length < 1000, 'tools/list page budget exhausted');
          const start = frames.length;
          const page = await client.listTools(cursor === undefined ? undefined : { cursor });
          const request = frames.slice(start).find(f => f.direction === 'client' && f.message.method === 'tools/list');
          assert.ok(request, 'SDK did not issue a real tools/list request');
          const response = frames.slice(start).find(f => f.direction === 'server' && f.message.id === request.message.id && 'result' in f.message);
          assert.ok(response, 'Missing tools/list wire response');
          const result = response.message.result as Rec;
          // The SDK may add own keys with value undefined; they have no UTF-8
          // JSON representation. Keep the SDK client's original property order
          // (including legacy annotation ordering); retain the independent wire
          // representation in list pages and the complete RPC transcript too.
          const clientTools = JSON.parse(JSON.stringify(page.tools)) as Rec[];
          assert.deepEqual(result.tools, clientTools, 'Client projection differs from complete wire tools');
          tools.push(...clientTools);
          pages.push(await write(`${id}/list-${pages.length}.json`, result));
          sdkMetadata.push(Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'tools')));
          assert.equal(result.nextCursor, page.nextCursor, 'SDK cursor projection differs');
          cursor = page.nextCursor;
          if (cursor !== undefined) {
            assert.ok(cursor.length > 0 && !seen.has(cursor), 'Empty or repeated listing cursor');
            seen.add(cursor);
          }
        } while (cursor !== undefined);
        const names = tools.map(t => t.name);
        assert.ok(names.length > 0 && names.every(n => typeof n === 'string') && new Set(names).size === names.length, 'Invalid/duplicate tool names');
        const serverInfo = client.getServerVersion(), capabilities = client.getServerCapabilities(), instructions = client.getInstructions();
        assert.ok(serverInfo && capabilities && typeof instructions === 'string', 'Unmeasured advertised context');
        const advertised = { serverInfo, capabilities, instructions, tools };
        const context = JSON.stringify({ ...advertised, tools: [] });
        // Preserve actual ordered JSON strings. Separators are separate segments;
        // no concatenation credit is allowed in the conservative token sum.
        const prefix = context.slice(0, -2), suffix = ']}';
        const ordered: { kind: string; file: File }[] = [{ kind: 'context-prefix', file: await write(`${id}/prefix.txt`, prefix, true) }];
        const serializedTools = [];
        for (const [i, tool] of tools.entries()) {
          if (i > 0) ordered.push({ kind: 'separator', file: await write(`${id}/separator-${i}.txt`, ',', true) });
          const file = await write(`${id}/tool-${i}.json`, tool);
          ordered.push({ kind: 'tool', file });
          assert.ok(tool.outputSchema, 'Missing listed output schema');
          serializedTools.push({ name: tool.name, file, output_schema: await write(`${id}/output-schema-${i}.json`, tool.outputSchema) });
        }
        ordered.push({ kind: 'context-suffix', file: await write(`${id}/suffix.txt`, suffix, true) });
        const rawFrames = [];
        for (const [i, frame] of frames.entries()) rawFrames.push({ direction: frame.direction, file: await write(`${id}/rpc-${i}.json`, frame.message) });
        const toolBytes = serializedTools.reduce((sum, t) => sum + t.file.bytes, 0);
        const complete = await write(`${id}/complete.json`, advertised);
        captures.push({ id, era, protocol_version: client.getNegotiatedProtocolVersion(), profile: profile.profile,
          ...(profile.hostProfileId ? { host_profile_id: profile.hostProfileId } : {}), complete,
          context: await write(`${id}/context.json`, context, true), instructions: await write(`${id}/instructions.txt`, instructions, true),
          tools: serializedTools, ordered_segments: ordered, list_pages: pages,
          sdk_response_metadata: await write(`${id}/sdk-response-metadata.json`, sdkMetadata),
          rpc_frames: rawFrames, transcript: await write(`${id}/transcript.json`, frames),
          byte_summary: { per_tool: Object.fromEntries(serializedTools.map(t => [t.name, t.file.bytes])), tools_total: toolBytes,
            instructions: Buffer.byteLength(instructions), context_and_separators: complete.bytes - toolBytes, complete: complete.bytes },
        });
      } finally {
        await client.close(); await handle.close(); gateway.close();
      }
    }
  }
} finally { await new Promise<void>(closed => sink.close(() => closed())); }
assert.equal(upstreamAttempts, 0, 'Catalog performed upstream work');
const manifest = {
  format: 'fireboat-tool-catalog/1', candidate: { commit: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}'),
    dirty: git('status', '--porcelain'), workflow_run_id: process.env['GITHUB_RUN_ID'] ?? null, workflow_run_attempt: process.env['GITHUB_RUN_ATTEMPT'] ?? null },
  runtime: { node: process.version, platform: process.platform, arch: process.arch, sdk },
  boundary: 'guidance-5: JSON.stringify({serverInfo,capabilities,instructions,tools}); original SDK-client property order, UTF-8, compact, no newline',
  protocol_boundary: 'Complete discovery/initialize and tools/list results, SDK cache/response metadata, bidirectional JSON-RPC frames and one LF per frame are reported separately; not host model-input measurements.',
  profiles: { basis: 'full-text default plus every shipped verified structured host/era; no test overrides', registry: HOST_PROFILE_REGISTRY },
  source_inputs: inputHashes, compiled_inputs: await builtInputs(resolve(root, 'dist/packages')),
  spine: await write('output-spine.json', OUTPUT_SPINE), upstream_attempts: upstreamAttempts,
  upstream_control: 'TCP connections to the configured loopback sink during the capture (FhirTransport accepts only this literal loopback origin; the transport never uses global fetch)', captures,
};
await write('manifest.json', manifest);
await writeFile(resolve(out, 'SHA256SUMS'), (await files(out)).map(f => `${f.sha256}  ${f.path}`).join('\n') + '\n');
async function files(dir: string): Promise<File[]> {
  const result: File[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) result.push(...await files(path));
    else { const bytes = await readFile(path); result.push({ path: relative(out, path), bytes: bytes.length, sha256: hash(bytes) }); }
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}
console.log(JSON.stringify({ captures: captures.map(c => ({ id: c.id, bytes: c.byte_summary })), spine_bytes: manifest.spine.bytes }));
