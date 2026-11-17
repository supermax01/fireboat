// Read-only SDK observation over the production factory. No alternate registration.
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { OUTPUT_SPINE, type FhirGateway } from '../packages/core/src/index.js';
import { createMcpServer } from '../packages/server/src/index.js';
import { drainToolListing, measureCatalog } from '../packages/evals/src/catalog.js';

export async function captureReleaseCatalog(gateway: FhirGateway, era: 'modern' | 'legacy') {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const frames: string[] = [];
  const send = b.send.bind(b);
  b.send = async (message, options) => { frames.push(JSON.stringify(message)); await send(message, options); };
  const server = serveStdio(({ era: negotiated }) => createMcpServer(gateway, { era: negotiated }), { transport: b });
  const client = new Client({ name: 's58-release-catalog', version: '1' }, era === 'modern'
    ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : undefined);
  try {
    await client.connect(a);
    const discoveryFrames = frames.splice(0);
    const { tools, pages } = await drainToolListing(cursor => client.listTools(cursor === undefined ? {} : { cursor }));
    const serverInfo = client.getServerVersion(), capabilities = client.getServerCapabilities(), instructions = client.getInstructions();
    if (!serverInfo || !capabilities || instructions === undefined) throw new Error('Missing advertised context.');
    const advertised = { serverInfo, capabilities };
    const completeText = JSON.stringify({ ...advertised, instructions, tools });
    const discovery = discoveryFrames.map(frame => JSON.parse(frame) as Record<string, any>);
    const listing = frames.map(frame => JSON.parse(frame) as Record<string, any>);
    return {
      era, tools, pages, serverInfo, capabilities, instructions, completeText,
      // SDK decoding materializes optional own keys with undefined values.
      // Record them independently; JSON serialization omits them on the wire.
      decodedFields: tools.map(tool => ({ name: tool.name, fields: Object.keys(tool).map(key => ({ key, defined: (tool as Record<string, unknown>)[key] !== undefined })) })),
      // Original serialized messages are retained, including every SDK-added field.
      discoveryFrames, listingFrames: frames, discovery, listing,
      framing: [...discoveryFrames, ...frames].map(frame => {
        const message = JSON.parse(frame) as Record<string, unknown>;
        const resultBytes = Buffer.byteLength(JSON.stringify(message.result));
        const messageBytes = Buffer.byteLength(frame);
        return { resultBytes, messageBytes, jsonRpcFramingBytes: messageBytes - resultBytes };
      }),
      measured: measureCatalog(tools, instructions, OUTPUT_SPINE, advertised),
    };
  } finally { await client.close().catch(() => undefined); await server.close().catch(() => undefined); }
}
