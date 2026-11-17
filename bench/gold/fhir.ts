// Small FHIR helpers for gold code. Resources are parsed with numbers as lexeme strings (lib/json.ts).

export type Json = null | boolean | string | Json[] | { [k: string]: Json };
export type Res = { resourceType: string; id: string; [k: string]: Json };

export const isObj = (v: unknown): v is Record<string, Json> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const asArray = <T>(v: T | T[] | undefined | null): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
export const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
export const refOf = (r: Res): string => `${r.resourceType}/${r.id}`;

/** Walks a dotted path through objects and arrays, flattening arrays. */
export function get(v: unknown, path: string): Json[] {
  let cur: unknown[] = [v];
  for (const key of path.split('.')) {
    const next: unknown[] = [];
    for (const c of cur) for (const x of asArray(c)) if (isObj(x) && x[key] !== undefined) next.push(...asArray(x[key] as Json));
    cur = next;
  }
  return cur as Json[];
}
export const get1 = (v: unknown, path: string): Json | undefined => get(v, path)[0];
export const getStr = (v: unknown, path: string): string | null => str(get1(v, path));

export interface Coding { system: string | null; code: string | null; display: string | null }
export function codings(cc: unknown): Coding[] {
  return get(cc, 'coding').filter(isObj).map(c => ({ system: str(c.system), code: str(c.code), display: str(c.display) }));
}
/** A record matches on any coding with the stated system and code (shared gold rule). */
export const hasCoding = (cc: unknown, system: string, code: string): boolean =>
  codings(cc).some(c => c.system === system && c.code === code);

// ---- Instants ------------------------------------------------------------------------------------------------

const DATETIME = /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:\d{2})?)?)?)?$/;

export interface Instant { ms: number; frac: string; precision: 'year' | 'month' | 'day' | 'minute' | 'second' | 'fraction' }

/** Parses a FHIR date/dateTime/instant. Date-only values start at 00:00 UTC (calendar days are UTC days). */
export function parseInstant(text: string): Instant {
  const m = DATETIME.exec(text);
  if (!m) throw new Error(`not a FHIR dateTime: ${text}`);
  const [, y, mo, d, h, mi, s, f, tz] = m;
  if (h !== undefined && tz === undefined) throw new Error(`dateTime with time but no offset: ${text}`);
  let ms = Date.UTC(Number(y), Number(mo ?? '1') - 1, Number(d ?? '1'), Number(h ?? '0'), Number(mi ?? '0'), Number(s ?? '0'),
    Number((f ?? '').padEnd(3, '0').slice(0, 3)));
  if (Number(y) < 100) throw new Error(`year below 100 not supported: ${text}`);
  if (tz && tz !== 'Z') {
    const sign = tz[0] === '-' ? -1 : 1;
    ms -= sign * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(4, 6))) * 60_000;
  }
  const precision = f !== undefined ? 'fraction' : s !== undefined ? 'second' : h !== undefined ? 'minute' : d !== undefined ? 'day' : mo !== undefined ? 'month' : 'year';
  return { ms, frac: f ?? '', precision };
}
export const instantMs = (text: string): number => parseInstant(text).ms;

/** Orders by parsed instant, then by fractional digits beyond ms, then by the tiebreak string. */
export function compareInstant(a: string, b: string): number {
  const x = parseInstant(a), y = parseInstant(b);
  if (x.ms !== y.ms) return x.ms < y.ms ? -1 : 1;
  const xf = x.frac.padEnd(12, '0'), yf = y.frac.padEnd(12, '0');
  return xf < yf ? -1 : xf > yf ? 1 : 0;
}

/** Byte-order string comparison (UTF-8 order equals code point order). */
export function byteCompare(a: string, b: string): number {
  const x = Buffer.from(a, 'utf8'), y = Buffer.from(b, 'utf8');
  return Buffer.compare(x, y);
}
export const sortBytes = (xs: Iterable<string>): string[] => [...xs].sort(byteCompare);
export const uniqSorted = (xs: Iterable<string>): string[] => sortBytes(new Set(xs));

/** UTC calendar date of an instant. */
export const utcDate = (text: string): string => new Date(instantMs(text)).toISOString().slice(0, 10);
