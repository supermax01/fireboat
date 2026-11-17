// Lexeme-preserving JSON. Uses JSON.parse source-text access and JSON.rawJSON (Node 24).
// Never call plain JSON.parse on FHIR data or on MCP tool results: it turns `12.3400` into 12.34.

type Reviver = (this: unknown, key: string, value: unknown, context: { source?: string }) => unknown;
const parseWith = JSON.parse as unknown as (text: string, reviver: Reviver) => unknown;
const rawJSON = (JSON as unknown as { rawJSON(text: string): unknown }).rawJSON;

/** A JSON number kept as its exact source lexeme. Serialises back to the same lexeme. */
export class LosslessNumber {
  constructor(readonly lexeme: string) {}
  toJSON(): unknown { return rawJSON(this.lexeme); }
  toString(): string { return this.lexeme; }
}

export type LosslessValue = null | boolean | string | LosslessNumber | LosslessValue[] | { [key: string]: LosslessValue };

/** Numbers become LosslessNumber. `stringifyLossless(parseLossless(t))` equals the compact form of t. */
export function parseLossless(text: string): LosslessValue {
  return parseWith(text, (_key, value, context) =>
    typeof value === 'number' ? new LosslessNumber(sourceOf(context)) : value) as LosslessValue;
}

/** Numbers become their lexeme strings, like Python json.loads(parse_float=str, parse_int=str). For gold code. */
export function parseNumbersAsStrings(text: string): unknown {
  return parseWith(text, (_key, value, context) => (typeof value === 'number' ? sourceOf(context) : value));
}

/** Compact serialisation that writes LosslessNumber lexemes unchanged. */
export function stringifyLossless(value: unknown): string {
  const out = JSON.stringify(value);
  if (out === undefined) throw new Error('value is not JSON-serialisable');
  return out;
}

export const utf8Bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

function sourceOf(context: { source?: string }): string {
  if (typeof context?.source !== 'string') throw new Error('JSON.parse source text access unavailable (need Node 24)');
  return context.source;
}
