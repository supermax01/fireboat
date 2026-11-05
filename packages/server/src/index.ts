import { McpServer, type StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import {
  TOOL_NAMES,
  SERVER_IDENTITY,
  SERVER_INSTRUCTIONS_V2,
  TOOL_DESCRIPTIONS_V2,
  TOOL_TITLES,
  listedInputSchemaV2,
  permissiveInputSchema,
  minimalOutputSchema,
  type FhirGateway,
  type ToolName,
} from '../../core/src/index.js';

export { TOOL_NAMES };
export type { ToolName };
export { TOOL_DESCRIPTIONS } from '../../core/src/index.js';

/**
 * Build an MCP server exposing exactly the five implemented milestone
 * tools. All validation, confinement, projection, and envelope shaping
 * are owned by the gateway; this adapter only forwards structured
 * input and maps the envelope via the shared toMcpToolResult helper.
 * `era` is the protocol era this instance serves (from the serveStdio
 * factory context); it is required (G-10) and passed to the gateway per
 * call so byte accounting matches the era-specific wire shape exactly.
 *
 * Catalog (Addendum B): tools register through custom Standard Schema
 * wrappers. The listed input schema stays strict, but SDK-side validation
 * is permissive so admitted argument faults reach the gateway and return
 * fitted application envelopes instead of raw SDK text. The listed output
 * schema is the 97 B minimal schema; strict core validation (published
 * spine ∧ envelope contract) runs in the gateway before delivery.
 */
export function createMcpServer(gateway: FhirGateway, options: { era: 'modern' | 'legacy' }): McpServer {
  const era = options.era;
  const server = new McpServer(
    SERVER_IDENTITY,
    {
      instructions: SERVER_INSTRUCTIONS_V2,
      // Never advertise a notification that is not emitted (gate-F item 1).
      capabilities: { tools: { listChanged: false } },
      // J-38: only the tested eras are declared/negotiated.
      supportedProtocolVersions: ['2026-07-28', '2025-11-25'],
    },
  );

  for (const name of TOOL_NAMES) {
    server.registerTool(
      name,
      {
        title: TOOL_TITLES[name],
        description: TOOL_DESCRIPTIONS_V2[name],
        inputSchema: permissiveInputSchema(listedInputSchemaV2(name)) as unknown as StandardSchemaWithJSON,
        outputSchema: minimalOutputSchema() as unknown as StandardSchemaWithJSON,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async (args: unknown, ctx?: { mcpReq?: { signal?: AbortSignal } }) => {
        const envelope = await gateway.execute(name, args, { signal: ctx?.mcpReq?.signal, era });
        // R2-9: forward the same DeliveryContext profile the call executed under.
        return gateway.toToolResult(envelope, { era, profile: gateway.deliveryProfile });
      },
    );
  }

  return server;
}

export default createMcpServer;
