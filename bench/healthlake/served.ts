// What the HealthLake data store serves, read through the loopback signing proxy (so the proxy's mapping, signing and
// link rewriting are exercised by every check). HealthLake supports neither _summary=count nor _count=0, so a type's
// count is Bundle.total of `<Type>?_total=accurate&_count=1&_elements=id`.
import { parseLossless, type LosslessValue } from '../lib/json.js';
import { bundleTotalOf } from './load-lib.js';

const isObj = (x: unknown): x is Record<string, LosslessValue> => typeof x === 'object' && x !== null && !Array.isArray(x);

export async function proxyGet(url: string): Promise<{ status: number; text: string }> {
  const res = await fetch(url, { redirect: 'manual', headers: { accept: 'application/fhir+json' }, signal: AbortSignal.timeout(180_000) });
  return { status: res.status, text: await res.text() };
}

export async function servedCount(proxyBase: string, type: string): Promise<{ served: number | null; status: number; detail: string }> {
  const r = await proxyGet(`${proxyBase}/${type}?_total=accurate&_count=1&_elements=id`);
  const served = r.status === 200 ? bundleTotalOf(r.text) : null;
  return { served, status: r.status, detail: served === null ? r.text.slice(0, 300) : '' };
}

/** Per-type served counts, a few types at a time (search quota: 100 GET searches per second per data store). */
export async function servedCounts(proxyBase: string, types: readonly string[], concurrency = 4): Promise<Record<string, { served: number | null; status: number; detail: string }>> {
  const out: Record<string, { served: number | null; status: number; detail: string }> = {};
  let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < types.length) {
      const t = types[next++]!;
      out[t] = await servedCount(proxyBase, t);
    }
  }));
  return out;
}

export interface Page { ids: string[]; next: string | null; fullUrls: string[]; links: string[] }

export function pageOf(text: string): Page {
  const b = parseLossless(text);
  const out: Page = { ids: [], next: null, fullUrls: [], links: [] };
  if (!isObj(b)) return out;
  for (const l of Array.isArray(b.link) ? b.link : []) {
    if (!isObj(l) || typeof l.url !== 'string') continue;
    out.links.push(l.url);
    if (l.relation === 'next') out.next = l.url;
  }
  for (const e of Array.isArray(b.entry) ? b.entry : []) {
    if (!isObj(e)) continue;
    if (typeof e.fullUrl === 'string') out.fullUrls.push(e.fullUrl);
    if (isObj(e.resource) && typeof e.resource.id === 'string') out.ids.push(e.resource.id);
  }
  return out;
}

/** Every id of one type, following the (rewritten) next links through the proxy. */
export async function servedIds(proxyBase: string, type: string, maxPages = 5000): Promise<{ ids: string[]; pages: number; foreignLinks: number; error: string | null }> {
  let url: string | null = `${proxyBase}/${type}?_count=100&_elements=id`;
  const ids: string[] = [];
  let pages = 0, foreign = 0;
  while (url && pages < maxPages) {
    if (!url.startsWith(`${proxyBase}/`)) return { ids, pages, foreignLinks: foreign + 1, error: `next link outside the proxy base: ${url.slice(0, 120)}` };
    const r = await proxyGet(url);
    if (r.status !== 200) return { ids, pages, foreignLinks: foreign, error: `HTTP ${r.status}: ${r.text.slice(0, 200)}` };
    const p = pageOf(r.text);
    pages++;
    ids.push(...p.ids);
    foreign += p.links.filter(l => /^https?:/.test(l) && !l.startsWith(`${proxyBase}/`)).length;
    url = p.next;
  }
  return { ids, pages, foreignLinks: foreign, error: url ? `stopped after ${maxPages} pages` : null };
}
