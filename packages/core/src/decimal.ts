/**
 * Lossless JSON numbers (J-6). A source number whose lexeme does not survive
 * a plain JS round-trip (`7.0`, `120.00`, `1e2`, `-0.0`, unsafe integers,
 * `1e400`) is carried internally as a frozen {@link FhirDecimal} holding the
 * exact source text. It stays a distinct scalar through sanitize, projection
 * and the result store, and is converted to a `JSON.rawJSON` value only at
 * final serialization, so the MCP JSON (structured content and text) emits
 * the original lexeme as a JSON number. `JSON.rawJSON` objects never enter
 * internal state: `structuredClone` rejects them.
 */

// ES2025 JSON raw values; present in the supported Node runtime but not in the
// ES2023 type lib this project compiles against.
interface RawJsonHost { rawJSON(text: string): object; isRawJSON(value: unknown): boolean }
const rawJsonHost = JSON as unknown as RawJsonHost;

export class FhirDecimal {
  constructor(readonly lexeme: string) { Object.freeze(this); }
  /** Nearest JS number; may lose precision, so callers must not serialize it as the source value. */
  numberValue(): number { return Number(this.lexeme); }
}
export const isFhirDecimal = (value: unknown): value is FhirDecimal => value instanceof FhirDecimal;

/**
 * Marker for a number whose source lexeme could not be captured (a JSON
 * engine without parse source text) and whose JS value may have changed.
 * Carried through authorization untouched; the gateway refuses the owning
 * resource only after linkage is established, never the whole page.
 */
export class FhirPrecisionFault {
  readonly precisionFault = true as const;
  constructor() { Object.freeze(this); }
}
export const isPrecisionFault = (value: unknown): value is FhirPrecisionFault => value instanceof FhirPrecisionFault;

/**
 * V-34: lossless lexeme capture needs ES2025 JSON source text (reviver
 * `context.source`) and `JSON.rawJSON`. Without source text a lexeme like
 * `7.0` is indistinguishable from `7`, so no number can be trusted. Fail
 * closed at startup rather than silently dropping precision.
 */
export function assertLosslessJsonRuntime(): void {
  if (typeof rawJsonHost.rawJSON !== 'function' || typeof rawJsonHost.isRawJSON !== 'function') {
    throw new Error('This gateway requires a JSON runtime with JSON.rawJSON (ES2025) so source number lexemes can be preserved exactly.');
  }
  let source: string | undefined;
  JSON.parse('[1.0]', (_key: string, value: unknown, context?: { source?: string }) => {
    if (typeof value === 'number') source = context?.source;
    return value;
  });
  if (source !== '1.0') {
    throw new Error('This gateway requires JSON.parse source text access (reviver context.source, ES2025) so source number lexemes can be preserved exactly.');
  }
}

/** Parse JSON text, wrapping every non-round-trippable number lexeme in a {@link FhirDecimal}. */
export function parseFhirJson(text: string): unknown {
  return JSON.parse(text, (_key: string, value: unknown, context?: { source?: string }) => {
    if (typeof value !== 'number') return value;
    const source = context?.source;
    if (source !== undefined) return JSON.stringify(value) === source ? value : new FhirDecimal(source);
    // No source text from this engine: the original lexeme is unknowable (7.0, 120.00 and 1e2 all parse to
    // plain integers), so every number is a precision fault and its owning resource is refused post-linkage.
    return new FhirPrecisionFault();
  });
}

/** True when any nested value is an unpreservable-number marker. Bounded like the authorization walk. */
export function containsPrecisionFault(value: unknown): boolean {
  let nodes = 0;
  const visit = (current: unknown, depth: number): boolean => {
    if (++nodes > 100000 || depth > 64) return true;
    if (isPrecisionFault(current)) return true;
    if (!current || typeof current !== 'object' || isFhirDecimal(current)) return false;
    if (Array.isArray(current)) return current.some(item => visit(item, depth + 1));
    return Object.values(current).some(child => visit(child, depth + 1));
  };
  return visit(value, 0);
}

/** Serialize with FhirDecimal lexemes emitted as raw JSON numbers. Precision markers must never reach output. */
export function stringifyFhir(value: unknown): string {
  return JSON.stringify(value, (_key: string, current: unknown) => {
    if (isFhirDecimal(current)) return rawJsonHost.rawJSON(current.lexeme);
    if (isPrecisionFault(current)) throw new Error('An unpreservable numeric value reached serialization.');
    return current;
  });
}

/**
 * Deep-convert an internal value to its final wire form: FhirDecimal becomes
 * a raw JSON number, everything else is structurally copied. The result is
 * the object handed to the MCP SDK as structured content; serializing it
 * yields the original lexemes.
 */
export function toWireValue(value: unknown): unknown {
  if (isFhirDecimal(value)) return rawJsonHost.rawJSON(value.lexeme);
  if (isPrecisionFault(value)) throw new Error('An unpreservable numeric value reached serialization.');
  if (Array.isArray(value)) return value.map(toWireValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, toWireValue(child)]));
  return value;
}

/** Deep clone that preserves decimal identity (frozen scalars are shared). Replaces structuredClone for FHIR values. */
export function cloneFhirValue<T>(value: T): T {
  if (isFhirDecimal(value) || isPrecisionFault(value)) return value;
  if (Array.isArray(value)) return value.map(item => cloneFhirValue(item)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneFhirValue(child)])) as T;
  return value;
}

/** Exact non-negative integer for a plain number or an integer-lexeme decimal, else undefined. */
export function integerValue(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  if (isFhirDecimal(value) && /^\d+$/.test(value.lexeme)) {
    const parsed = Number(value.lexeme);
    return Number.isSafeInteger(parsed) && String(parsed) === value.lexeme ? parsed : undefined;
  }
  return undefined;
}
