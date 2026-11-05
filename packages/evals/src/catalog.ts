// SDK catalog capture (gate F, spec §2 / Addendum B.2): measures listed tools
// against the frozen byte caps. Token caps are frozen constants; token
// acceptance stays unmeasured until the pinned tokenizer gate lands (root/R).
// The decision-round measurement (4.04 B/token o200k) is recorded in contracts.
import { createHash } from 'node:crypto';
import { CATALOG_BYTE_CAPS, LISTED_OUTPUT_SCHEMA, SERVER_IDENTITY, TOOL_NAMES, type ToolName } from '../../core/src/index.js';

/** Advertised server identity/capabilities (R2-9): B.2 budgets them inside the 350 B wrapper allowance. */
export const ADVERTISED_SERVER_INFO = SERVER_IDENTITY;
export const ADVERTISED_CAPABILITIES = { tools: { listChanged: false } } as const;

export interface ToolListingPage<T> { tools: T[]; nextCursor?: string; [key: string]: unknown }

/** Retain every SDK field/page; a truncated, duplicated or looping catalog is invalid. */
export async function drainToolListing<T extends { name: string }>(
  listPage: (cursor?: string) => Promise<ToolListingPage<T>>,
): Promise<{ tools: T[]; pages: ToolListingPage<T>[] }> {
  const tools: T[] = [], pages: ToolListingPage<T>[] = [];
  const names = new Set<string>(), cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await listPage(cursor);
    pages.push(page);
    for (const tool of page.tools) {
      if (!(TOOL_NAMES as readonly string[]).includes(tool.name)) throw new Error('Unexpected catalog tool.');
      if (names.has(tool.name)) throw new Error('Duplicate catalog tool.');
      names.add(tool.name); tools.push(tool);
    }
    cursor = page.nextCursor;
    if (cursor !== undefined) {
      if (!cursor || cursors.has(cursor)) throw new Error('Catalog cursor loop or invalid cursor.');
      cursors.add(cursor);
      if (pages.length >= TOOL_NAMES.length) throw new Error('Catalog page bound exceeded.');
    }
  } while (cursor !== undefined);
  if (TOOL_NAMES.some(name => !names.has(name))) throw new Error('Missing catalog tool.');
  return { tools, pages };
}

export interface CatalogMeasurement {
  perTool: Record<ToolName, number>;
  toolsTotal: number;
  instructionsBytes: number;
  spineBytes: number;
  listedSchemaBytes: number;
  /** Bytes of the advertised serverInfo + capabilities (R2-9). */
  advertisedBytes: number;
  /** Complete minus tools: instructions + advertised context + serialization wrapper. */
  instructionsAndWrapperBytes: number;
  completeBytes: number;
  /** SHA-256 of the compact complete-catalog serialization (CA-2.1 capture hash). */
  completeSha256: string;
  withinCaps: boolean;
  tokenAcceptance: 'unmeasured';
}

export function measureCatalog(
  tools: readonly unknown[],
  instructions: string,
  spine: unknown,
  advertised: { serverInfo: unknown; capabilities: unknown } = { serverInfo: ADVERTISED_SERVER_INFO, capabilities: ADVERTISED_CAPABILITIES },
): CatalogMeasurement {
  const perTool = {} as Record<ToolName, number>;
  let toolsTotal = 0;
  for (const tool of tools) {
    const bytes = Buffer.byteLength(JSON.stringify(tool));
    const name = (tool as { name?: string }).name as ToolName;
    if (!name || !(TOOL_NAMES as readonly string[]).includes(name)) throw new Error('Unexpected catalog tool.');
    if (Object.hasOwn(perTool, name)) throw new Error('Duplicate catalog tool.');
    perTool[name] = bytes;
    toolsTotal += bytes;
  }
  const instructionsBytes = Buffer.byteLength(instructions);
  const spineBytes = Buffer.byteLength(JSON.stringify(spine));
  const listedSchemaBytes = Buffer.byteLength(JSON.stringify(LISTED_OUTPUT_SCHEMA));
  // Complete catalog (R2-9/B.2) = compact {serverInfo,capabilities,instructions,tools}:
  // the advertised identity and capabilities live inside the wrapper allowance.
  const advertisedBytes = Buffer.byteLength(JSON.stringify({ serverInfo: advertised.serverInfo, capabilities: advertised.capabilities }));
  const completeText = JSON.stringify({ serverInfo: advertised.serverInfo, capabilities: advertised.capabilities, instructions, tools });
  const completeBytes = Buffer.byteLength(completeText);
  const instructionsAndWrapperBytes = completeBytes - toolsTotal;
  const withinCaps = TOOL_NAMES.every(name => (perTool[name] ?? Infinity) <= CATALOG_BYTE_CAPS[name])
    && toolsTotal <= CATALOG_BYTE_CAPS.toolsTotal
    && instructionsBytes <= CATALOG_BYTE_CAPS.instructions
    && instructionsAndWrapperBytes <= CATALOG_BYTE_CAPS.instructionsAndWrapper
    && spineBytes <= CATALOG_BYTE_CAPS.outputSpine
    && listedSchemaBytes <= CATALOG_BYTE_CAPS.listedOutputSchema
    && completeBytes <= CATALOG_BYTE_CAPS.complete;
  return { perTool, toolsTotal, instructionsBytes, spineBytes, listedSchemaBytes, advertisedBytes, instructionsAndWrapperBytes, completeBytes, completeSha256: createHash('sha256').update(completeText).digest('hex'), withinCaps, tokenAcceptance: 'unmeasured' };
}
