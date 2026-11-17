import assert from 'node:assert/strict';

/**
 * Independent count-once measures (schema 0.4) for tests. They never import the gateway's own helpers, so a
 * weakened production measure cannot also weaken the oracle.
 * - Model copy bytes: the larger of the UTF-8 bytes of the LF-joined text blocks and of the compact JSON of
 *   structuredContent. The byte cap bounds this.
 * - Wire bytes: the complete serialized tool result. The wire invariant bounds it at 3 x byte_limit + 4096.
 */
export function measuredModelCopy(result: { content?: unknown; structuredContent?: unknown }): number {
  const blocks = Array.isArray(result.content) ? result.content as { type?: unknown; text?: unknown }[] : [];
  const text = blocks.filter(block => block?.type === 'text').map(block => String(block.text)).join('\n');
  const structured = result.structuredContent === undefined ? 0 : Buffer.byteLength(JSON.stringify(result.structuredContent), 'utf8');
  return Math.max(Buffer.byteLength(text, 'utf8'), structured);
}
export const measuredWire = (result: unknown): number => Buffer.byteLength(JSON.stringify(result), 'utf8');
export const wireCeiling = (byteLimit: number): number => 3 * byteLimit + 4096;

/** Both claims equal their own independent measurements, within the cap and the wire invariant. */
export function assertCountOnce(result: { content?: unknown; structuredContent?: unknown }, budget: { bytes_returned: number; byte_limit: number; wire_bytes: number }, label = 'count once'): void {
  assert.equal(budget.bytes_returned, measuredModelCopy(result), `${label}: bytes_returned is the exact model copy`);
  assert.equal(budget.wire_bytes, measuredWire(result), `${label}: wire_bytes is the exact complete SDK result`);
  assert.ok(budget.bytes_returned <= budget.byte_limit, `${label}: model copy within byte_limit`);
  assert.ok(budget.wire_bytes <= wireCeiling(budget.byte_limit), `${label}: wire invariant`);
}
