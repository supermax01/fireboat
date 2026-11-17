// Synthetic-only test source for pages without a self link. It never sends a self link
// unless asked, and pages with opaque `page=` tokens in next links that echo the original query, like the motivating
// source. Hand-written records only; no real or de-identified data.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { TestContext } from 'node:test';
import { FhirGateway, type GatewayConfig, type GatewayEnvelope } from '../packages/core/src/index.js';

export type R = Record<string, any>;
export const A = 'nsl-a', B = 'nsl-b';
export const LOINC = 'http://loinc.org';
export const output = { format: 'fhir' as const, max_bytes: 49152 };

export const obs = (id: string, patient = A, extra: R = {}): R => ({ resourceType: 'Observation', id, meta: { versionId: '1' }, status: 'final',
  code: { coding: [{ system: LOINC, code: '4548-4' }] }, subject: { reference: `Patient/${patient}` },
  effectiveDateTime: '2025-06-15T08:00:00Z', valueQuantity: { value: 7.1, unit: '%', system: 'http://unitsofmeasure.org', code: '%' }, ...extra });
export const encounter = (id: string, patient = A, extra: R = {}): R => ({ resourceType: 'Encounter', id, meta: { versionId: '1' }, status: 'finished',
  class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB' }, subject: { reference: `Patient/${patient}` },
  period: { start: '2025-06-15T08:00:00Z', end: '2025-06-15T09:00:00Z' }, ...extra });
export const patientRecord = (id = A): R => ({ resourceType: 'Patient', id, meta: { versionId: '1' }, gender: 'female', birthDate: '1980-02-03' });

export interface SourceOptions {
  records: R[];
  /** Send a self link echoing the request (default: none); `'first'` sends one on the first page only. */
  self?: boolean | 'first';
  /** Parameter names this source ignores when filtering (it still pages). */
  ignore?: string[];
  /** Records added to every searchset whatever the query (a source that returns non-matching records). */
  inject?: R[];
  /** Records added only to continuation pages. */
  injectOnContinuation?: R[];
  /** An OperationOutcome resource added to every searchset (or only to continuation pages). */
  outcome?: R;
  outcomeOnContinuation?: boolean;
  /** Rewrite the next link; return a string for a raw link. */
  next?: (next: URL, request: URL) => URL | string;
  /** Length of the opaque page token before any padding (default 64). */
  tokenLength?: number;
  /** Text appended to every page token exactly as written in the next link, for example `==` (raw base64 padding) or `%3D%3D`. */
  tokenPadding?: string;
  /** Page with an ordinary echoed `_offset` next link instead of a `page=` token. */
  offsetPaging?: boolean;
}

const CAPABILITY = {
  resourceType: 'CapabilityStatement', fhirVersion: '4.0.1', software: { name: 'no-self-link synthetic source', version: '1' },
  rest: [{ mode: 'server', resource: [
    { type: 'Observation', interaction: [{ code: 'read' }, { code: 'search-type' }], searchParam: [
      ['patient', 'reference'], ['subject', 'reference'], ['code', 'token'], ['date', 'date'], ['category', 'token'], ['status', 'token'],
      ['encounter', 'reference'], ['value-quantity', 'quantity'], ['identifier', 'token'], ['value-string', 'string']].map(([name, type]) => ({ name, type })) },
    { type: 'Encounter', interaction: [{ code: 'read' }, { code: 'search-type' }], searchParam: [['patient', 'reference'], ['subject', 'reference'], ['date', 'date'], ['class', 'token']].map(([name, type]) => ({ name, type })) },
    { type: 'Patient', interaction: [{ code: 'read' }, { code: 'search-type' }], searchParam: [['birthdate', 'date'], ['gender', 'token'], ['name', 'string']].map(([name, type]) => ({ name, type })) },
  ] }],
};

const idOf = (reference: unknown): string | undefined => typeof reference === 'string' ? reference.split('/').pop() : undefined;
const startOf = (text: string): number => Date.parse(/T/.test(text) ? text : `${text}${text.length === 4 ? '-01-01' : text.length === 7 ? '-01' : ''}T00:00:00Z`);
function honest(record: R, name: string, value: string): boolean {
  const alternatives = value.split(',');
  switch (name) {
    case 'patient': case 'subject': return alternatives.some(v => idOf(record.subject?.reference) === idOf(v));
    case '_id': return alternatives.includes(record.id);
    case 'encounter': return alternatives.some(v => record.encounter?.reference === v || idOf(record.encounter?.reference) === v);
    case 'code': case 'category': {
      const field = name === 'code' ? record.code : record.category;
      const codings = (Array.isArray(field) ? field : [field]).flatMap((c: R | undefined) => c?.coding ?? []);
      return alternatives.some(v => { const [system, code] = v.includes('|') ? v.split('|') : [undefined, v]; return codings.some((c: R) => c.code === code && (system === undefined || c.system === system)); });
    }
    case 'status': case 'gender': return alternatives.includes(record[name]);
    case 'date': case 'birthdate': {
      const text = record.effectiveDateTime ?? record.period?.start ?? record.birthDate;
      if (typeof text !== 'string') return false;
      const at = startOf(text);
      return alternatives.some(v => {
        const prefix = /^[a-z]{2}/.test(v) ? v.slice(0, 2) : 'eq', bound = startOf(prefix === 'eq' && !/^[a-z]{2}/.test(v) ? v : v.slice(2));
        return prefix === 'ge' ? at >= bound : prefix === 'gt' ? at > bound : prefix === 'lt' ? at < bound : prefix === 'le' ? at <= bound : text.startsWith(v.replace(/^eq/, ''));
      });
    }
    default: return true;
  }
}

export interface Source { base: string; requests: URL[]; clinical(): URL[]; options: SourceOptions; close(): Promise<void> }

export async function startSource(t: TestContext | undefined, options: SourceOptions): Promise<Source> {
  const requests: URL[] = [];
  let base = '';
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url!, base);
    requests.push(url);
    res.setHeader('content-type', 'application/fhir+json');
    const send = (status: number, body: unknown) => { res.statusCode = status; res.end(JSON.stringify(body)); };
    if (url.pathname.endsWith('/metadata')) return send(200, CAPABILITY);
    const read = /\/fhir\/([A-Za-z]+)\/([A-Za-z0-9.-]+)$/.exec(url.pathname);
    if (read) {
      const found = options.records.find(r => r.resourceType === read[1] && r.id === read[2]);
      return found ? send(200, found) : send(404, { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'not-found' }] });
    }
    const type = /\/fhir\/([A-Za-z]+)$/.exec(url.pathname)?.[1];
    if (!type) return send(404, { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'not-found' }] });
    const continuation = url.searchParams.has('page') || url.searchParams.has('_offset');
    const offset = url.searchParams.has('_offset') ? Number(url.searchParams.get('_offset')) : continuation ? Number(/^t(\d+)x/.exec(url.searchParams.get('page') ?? '')?.[1] ?? 0) : 0;
    const count = Number(url.searchParams.get('_count') ?? 20);
    let matched = options.records.filter(r => r.resourceType === type);
    for (const [name, value] of url.searchParams) {
      if (['_count', '_sort', 'page', '_offset'].includes(name) || options.ignore?.includes(name)) continue;
      matched = matched.filter(r => honest(r, name, value));
    }
    const page = [...matched.slice(offset, offset + count), ...(options.inject ?? []).filter(r => r.resourceType === type),
      ...(continuation ? options.injectOnContinuation ?? [] : [])];
    const links: R[] = options.self === true || (options.self === 'first' && !continuation) ? [{ relation: 'self', url: url.href }] : [];
    if (offset + count < matched.length) {
      const next = new URL(url);
      next.searchParams.delete('page');
      next.searchParams.delete('_offset');
      const marker = `t${offset + count}x`;
      if (options.offsetPaging) next.searchParams.set('_offset', String(offset + count));
      else next.searchParams.append('page', marker + 'y'.repeat(Math.max(0, (options.tokenLength ?? 64) - marker.length)));
      // The token is the last pair, so the padding is appended to the raw query; setting `search` does not encode `=`.
      if (options.tokenPadding && !options.offsetPaging) next.search += options.tokenPadding;
      const rewritten = options.next ? options.next(next, url) : next;
      links.push({ relation: 'next', url: typeof rewritten === 'string' ? rewritten : rewritten.href });
    }
    const entry: R[] = page.map(resource => ({ fullUrl: `${base}${resource.resourceType}/${resource.id}`, resource, search: { mode: 'match' } }));
    if (options.outcome && (!options.outcomeOnContinuation || continuation)) entry.push({ resource: options.outcome, search: { mode: 'outcome' } });
    send(200, { resourceType: 'Bundle', type: 'searchset', link: links, entry });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/fhir/`;
  const source: Source = {
    base, requests, options,
    clinical: () => requests.filter(url => !url.pathname.endsWith('/metadata')),
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
  t?.after(() => source.close());
  return source;
}

export function configFor(source: Source, extra: Partial<GatewayConfig['source']> = { selfLinkOptional: true, continuationTokenParameter: 'page' }): GatewayConfig {
  return { mode: 'synthetic', source: { alias: 'no-self', baseUrl: source.base, ...extra }, patientId: A, contextId: 'ctx_no_self' };
}

export function gatewayFor(t: TestContext, source: Source, extra?: Partial<GatewayConfig['source']>, testOptions?: ConstructorParameters<typeof FhirGateway>[1]): FhirGateway {
  const gateway = new FhirGateway(configFor(source, extra), testOptions);
  t.after(() => gateway.close());
  return gateway;
}

export const ids = (env: GatewayEnvelope): string[] => ((env.data as { resources?: R[] }).resources ?? []).map(r => r.id);
export const executions = (env: GatewayEnvelope): [string, string][] => (env.coverage.constraints ?? []).map(c => [c.name, c.execution]);
export const warnings = (env: GatewayEnvelope): string[] => env.warnings.map(w => w.code);

/** Strip per-call identity (request id, timing, handles, expiry, retrieval times, byte counts) for twin comparison. */
export function comparable(env: GatewayEnvelope): R {
  const copy = JSON.parse(JSON.stringify(env)) as R;
  delete copy.request_id;
  delete copy.budget.elapsed_ms; delete copy.budget.bytes_returned; delete copy.budget.wire_bytes;
  if (copy.result) { delete copy.result.handle; delete copy.result.expires_at; }
  if (copy.pagination?.next_cursor) copy.pagination.next_cursor = 'cur';
  for (const entry of copy.provenance ?? []) delete entry.retrieved_at;
  return copy;
}
