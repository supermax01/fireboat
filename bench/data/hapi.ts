// Minimal HTTP helpers for the loader and its checks. They talk to HAPI_BASE directly, never through a slot proxy.
import { parseLossless, type LosslessValue } from '../lib/json.js';
import { isObj, type Obj } from './fhir.js';

export const FHIR_JSON = 'application/fhir+json';

export interface Fetched { status: number; text: string; ms: number }

export async function get(url: string, timeoutMs = 300_000): Promise<Fetched> {
  const t0 = performance.now();
  const res = await fetch(url, { headers: { accept: FHIR_JSON }, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  return { status: res.status, text, ms: performance.now() - t0 };
}

export async function getJson(url: string): Promise<Obj> {
  const r = await get(url);
  if (r.status !== 200) throw new Error(`GET ${url}: HTTP ${r.status}: ${r.text.slice(0, 300)}`);
  const v = parseLossless(r.text);
  if (!isObj(v)) throw new Error(`GET ${url}: not a JSON object`);
  return v;
}

export async function countOf(url: string): Promise<number> {
  const b = await getJson(url);
  const total = b.total;
  if (total === undefined || total === null) throw new Error(`GET ${url}: no Bundle.total`);
  return Number(String(total));
}

export function nextLink(bundle: Obj): string | null {
  if (!Array.isArray(bundle.link)) return null;
  for (const l of bundle.link) if (isObj(l) && l.relation === 'next' && typeof l.url === 'string') return l.url;
  return null;
}

export function entries(bundle: Obj): Obj[] {
  return Array.isArray(bundle.entry) ? bundle.entry.filter(isObj) : [];
}

/** Runs `fn` over items with at most `limit` in flight; results keep input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Canonical text of a JSON value: object keys sorted by UTF-16 code units, number lexemes kept. */
export function canonical(v: LosslessValue): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k]!)}`).join(',')}}`;
  return JSON.stringify(v); // strings, booleans, null, LosslessNumber (toJSON gives its lexeme)
}

/** The resource without server-managed meta (versionId, lastUpdated, source); an emptied meta is dropped. */
export function withoutServerMeta(resource: Obj): Obj {
  if (!isObj(resource.meta)) return resource;
  const meta: Obj = { ...resource.meta };
  delete meta.versionId;
  delete meta.lastUpdated;
  delete meta.source;
  const out: Obj = { ...resource };
  if (Object.keys(meta).length === 0) delete out.meta;
  else out.meta = meta;
  return out;
}
