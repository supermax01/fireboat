import { createHash } from 'node:crypto';
import { FhirGateway, type GatewayConfig } from '../../core/src/index.js';
import { FhirTransport, controlledFetch, utf8Charset, type HttpFetch } from '../../core/src/transport.js';
import { declaredSearchProfile, type SearchProfile } from '../../core/src/query.js';
import { EVAL_PATIENT_ID, EVAL_SOURCE_ALIAS, RAW_READ_BODIES, canonicalJson, evalDataText, loadEvalCorpus, type GoldenResource } from './fixture.js';
import { parseM3bTaskFile, TASKS, type EvalTask } from './tasks.js';

export const HAPI_IMAGE_DIGEST = 'sha256:0ff86aac4c7bd13a1ee226444a70263bb46ed1c28ef543c30a44f865b80ca04e';
export const HAPI_BASE_URL = 'http://127.0.0.1:18091/fhir';
export const EXTERNAL_SCHEMA = 'external-eval/1';
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_REQUESTS = 1200;
const MAX_PAGES = 100;
const REQUEST_MS = 15_000;
const TOTAL_MS = 300_000;
const rec = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
export const externalHash = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('hex');
function refuse(code: string): never { throw new Error(`External eval refused: ${code}.`); }

export interface ExternalApplicability {
  task_id: string;
  task_sha256: string;
  corpus: 'baseline' | 'query' | 'projection';
  classification: 'real-backend' | 'fixture-simulated' | 'profile-inapplicable';
  reason: string;
  profile_control: boolean;
  retained_synthetic_task?: string;
}

/** External proof controls are additive; the frozen synthetic task corpus and its qualification hash are untouched. */
export function externalTasks(): EvalTask[] {
  return [...TASKS, ...parseM3bTaskFile(evalDataText('data/hapi-profile-tasks.json'))];
}

/** This is reviewed task metadata, never inferred from observed passes or failures. */
export function externalApplicability(tasks: readonly EvalTask[] = externalTasks(), rows: readonly ExternalApplicability[] = JSON.parse(evalDataText('data/external-applicability.json')).tasks): ExternalApplicability[] {
  const byId = new Map(rows.map(row => [row.task_id, row]));
  if (byId.size !== rows.length || tasks.length !== rows.length || new Set(tasks.map(task => task.id)).size !== tasks.length) refuse('applicability-not-total');
  const result = tasks.map(task => {
    const row = byId.get(task.id);
    if (!row || row.task_sha256 !== externalHash(task) || row.corpus !== (task.corpus ?? 'baseline')) refuse('applicability-task-drift');
    if (!['real-backend', 'fixture-simulated', 'profile-inapplicable'].includes(row.classification) || typeof row.reason !== 'string' || row.reason.length < 20 || typeof row.profile_control !== 'boolean') refuse('applicability-invalid');
    if (row.profile_control && row.classification !== 'real-backend') refuse('applicability-control-excluded');
    if (row.classification === 'profile-inapplicable' ? row.retained_synthetic_task !== task.id || !TASKS.some(original => original.id === task.id) : row.retained_synthetic_task !== undefined) refuse('applicability-retained-regression');
    return structuredClone(row);
  });
  if (externalHash([...rows].sort((a, b) => a.task_id.localeCompare(b.task_id))) !== '831d5adb3dc1844b2a2be0ed13f51e4a6a0ee0e19e79e609cf9bb0b759fa8362') refuse('applicability-assignment-drift');
  return result;
}

export function externalTaskHash(): string {
  return externalHash({ schema: EXTERNAL_SCHEMA, tasks: externalTasks(), applicability: externalApplicability() });
}

export function selectExternalTasks(selected: readonly EvalTask[]): EvalTask[] {
  const applicability = externalApplicability();
  if (selected.some(task => !applicability.some(row => row.task_id === task.id && row.task_sha256 === externalHash(task)))) refuse('external-task-selection');
  return selected.filter(task => applicability.some(row => row.task_id === task.id && row.classification === 'real-backend'));
}

/** Pre-discovery error refusals have no source proof. Every successful or discovered-source result is bound. */
export function externalCapabilityRevisionMatches(revision: string, expected: string, error: boolean): boolean {
  return (error && revision === 'unknown') || revision === expected;
}

export interface ExternalCorpus {
  resources: readonly GoldenResource[];
  /** Exact resource JSON strings embedded in PUT transaction entries, including decimal source lexemes. */
  bodies: readonly string[];
  sha256: string;
  types: readonly string[];
  omitted: { fragment: string; resources: number; sha256: string; reason: string }[];
  transformations: { resource_type: string; path: string; count: number; operation: string; reason: string }[];
}

/** One immutable baseline+query corpus: there is no per-task filtering, reset or backend behavior simulation. */
export function externalCorpus(): ExternalCorpus {
  const all = loadEvalCorpus();
  const resources = structuredClone(all.byCorpus.query!);
  // The two synthetic payload sentinels are not valid base64Binary. Encode their exact UTF-8 bytes for transport;
  // the fixture and task expectations stay untouched, and the strict read-back compares this explicit input.
  const document = resources.find(resource => resource.resourceType === 'DocumentReference' && resource.id === 'doc-1')!;
  const attachment = rec((document.content as Record<string, unknown>[])[0]!.attachment)!;
  attachment.data = Buffer.from(attachment.data as string, 'utf8').toString('base64');
  const report = resources.find(resource => resource.resourceType === 'DiagnosticReport' && resource.id === 'report-1')!;
  const form = (report.presentedForm as Record<string, unknown>[])[0]!;
  form.data = Buffer.from(form.data as string, 'utf8').toString('base64');
  const bodies = resources.map(resource => RAW_READ_BODIES[resource.id] ?? JSON.stringify(resource));
  return {
    resources, bodies,
    sha256: externalHash({ schema: EXTERNAL_SCHEMA, bodies }),
    types: [...new Set(resources.map(resource => resource.resourceType))].sort(),
    transformations: [
      { resource_type: 'DocumentReference', path: 'content[0].attachment.data', count: 1, operation: 'UTF-8 bytes to canonical base64', reason: 'The fixture sentinel is a literal test marker, not a valid base64Binary value.' },
      { resource_type: 'DiagnosticReport', path: 'presentedForm[0].data', count: 1, operation: 'UTF-8 bytes to canonical base64', reason: 'The fixture sentinel is a literal test marker, not a valid base64Binary value.' },
    ],
    omitted: [{ fragment: 'fixtures/m3b-projection/lab-fidelity.json', resources: all.byCorpus.projection!.length - all.byCorpus.baseline!.length,
      sha256: all.hashes['fixtures/m3b-projection/lab-fidelity.json']!, reason: 'Raw-only projection fragment is a separate fixture view; no current task retrieves its resources. Its version and raw-wire fidelity inputs are not silently loaded into query result pools.' }],
  };
}

/** Only server-managed top-level metadata may differ; clinical fields, narratives, references and tags stay exact. */
export const EXTERNAL_SERVER_ADDITIONS = ['meta.versionId', 'meta.lastUpdated', 'meta.source (only when absent from input)'] as const;
export function compareExternalResource(expected: Record<string, unknown>, actual: Record<string, unknown>): boolean {
  const normalize = (resource: Record<string, unknown>, server: boolean) => {
    const copy = structuredClone(resource);
    const meta = rec(copy.meta);
    if (meta) {
      delete meta.versionId;
      delete meta.lastUpdated;
      if (server && rec(expected.meta)?.source === undefined) delete meta.source;
      if (Object.keys(meta).length === 0) delete copy.meta;
    }
    return copy;
  };
  return canonicalJson(normalize(expected, false)) === canonicalJson(normalize(actual, true));
}

export interface ExternalIdentity {
  software: string;
  software_version: string;
  fhir_version: string;
  image_digest: string;
  capability_revision: string;
  corpus_sha256: string;
  tasks_sha256: string;
}

/** Reuse the gateway's literal-loopback and same-base validation, including for every census next link. */
export function externalTransport(baseUrl: string): FhirTransport {
  return new FhirTransport(baseUrl, MAX_BYTES, REQUEST_MS);
}

export class ExternalClient {
  readonly transport: FhirTransport;
  private readonly deadline = Date.now() + TOTAL_MS;
  private count = 0;
  constructor(baseUrl: string, private readonly fetcher: HttpFetch = controlledFetch) {
    this.transport = externalTransport(baseUrl);
  }
  async request(value: string | URL, body?: string): Promise<Record<string, unknown>> {
    const url = this.transport.validate(value);
    if (++this.count > MAX_REQUESTS || Date.now() >= this.deadline) refuse('network-budget');
    if (body !== undefined && Buffer.byteLength(body) > MAX_BYTES) refuse('transaction-size');
    const signal = AbortSignal.timeout(Math.max(1, Math.min(REQUEST_MS, this.deadline - Date.now())));
    let response: Response;
    try {
      response = await this.fetcher(url, { method: body === undefined ? 'GET' : 'POST', redirect: 'manual', signal, maxCompressedBytes: MAX_BYTES,
        headers: { accept: 'application/fhir+json', ...(body === undefined ? {} : { 'content-type': 'application/fhir+json' }) }, ...(body === undefined ? {} : { body }) });
    } catch { return refuse('network-unavailable'); }
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); refuse('redirect'); }
    if (!response.ok) { await response.body?.cancel(); refuse(`http-${response.status}`); }
    const contentType = response.headers.get('content-type') ?? '';
    if (!/^application\/(?:fhir\+)?json(?:\s*;|$)/i.test(contentType) || !utf8Charset(contentType)) { await response.body?.cancel(); refuse('content-type'); }
    const reader = response.body?.getReader();
    if (!reader) refuse('response-body');
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const { value: chunk, done } = await reader.read();
        if (done) break;
        bytes += chunk.byteLength;
        if (bytes > MAX_BYTES) { await reader.cancel(); refuse('response-size'); }
        chunks.push(chunk);
      }
    } catch { return refuse('bounded-response'); }
    finally { reader.releaseLock(); }
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes))); }
    catch { return refuse('invalid-json'); }
    if (!rec(parsed) || typeof rec(parsed)!.resourceType !== 'string') refuse('resource-shape');
    return parsed as Record<string, unknown>;
  }
}

/** An out-of-corpus record is refused before the first write and again after loading; no cleanup DELETE exists. */
export async function censusExternalCorpus(client: ExternalClient, corpus: ExternalCorpus, requireComplete: boolean): Promise<void> {
  const expected = new Map(corpus.resources.map(resource => [`${resource.resourceType}/${resource.id}`, resource]));
  const seen = new Set<string>();
  for (const type of corpus.types) {
    let declaredTotal: number | undefined;
    let typeCount = 0;
    let next: string | URL | undefined = client.transport.url(`${type}?_count=100`);
    const pages = new Set<string>();
    while (next !== undefined) {
      const url = client.transport.validate(next);
      if (pages.has(url.href) || pages.size >= MAX_PAGES) refuse('census-pagination');
      pages.add(url.href);
      const bundle = await client.request(url);
      if (bundle.resourceType !== 'Bundle' || bundle.type !== 'searchset' || (bundle.entry !== undefined && !Array.isArray(bundle.entry))) refuse('census-bundle');
      if (bundle.total !== undefined) {
        if (!Number.isSafeInteger(bundle.total) || Number(bundle.total) < 0 || (declaredTotal !== undefined && declaredTotal !== bundle.total)) refuse('census-total');
        declaredTotal = bundle.total as number;
      }
      for (const entry of (bundle.entry ?? []) as unknown[]) {
        const resource = rec(rec(entry)?.resource);
        if (!resource || resource.resourceType !== type || typeof resource.id !== 'string') refuse('census-resource');
        const key = `${type}/${resource.id}`;
        if (!expected.has(key)) refuse('census-extra-resource');
        if (seen.has(key)) refuse('census-duplicate-resource');
        if (!compareExternalResource(expected.get(key)!, resource)) refuse('census-resource-mismatch');
        seen.add(key);
        typeCount++;
      }
      if (bundle.link !== undefined && !Array.isArray(bundle.link)) refuse('census-links');
      const links = ((bundle.link ?? []) as unknown[]).filter(link => rec(link)?.relation === 'next');
      if (links.length > 1 || (links.length === 1 && typeof rec(links[0])?.url !== 'string')) refuse('census-next-link');
      next = links.length ? client.transport.validate(rec(links[0])!.url as string) : undefined;
    }
    if (declaredTotal !== undefined && declaredTotal !== typeCount) refuse('census-total-count');
  }
  if (requireComplete && (seen.size !== expected.size || [...expected.keys()].some(key => !seen.has(key)))) refuse('census-missing-resource');
}

export async function loadExternalCorpus(client: ExternalClient, corpus: ExternalCorpus): Promise<Map<string, string>> {
  if (corpus.resources.length !== corpus.bodies.length || corpus.resources.length === 0 || corpus.resources.length > 500) refuse('corpus-shape');
  const entries = corpus.resources.map((resource, index) => {
    if (!/^[A-Z][A-Za-z]+$/.test(resource.resourceType) || !/^[A-Za-z0-9.-]{1,64}$/.test(resource.id)) refuse('corpus-identity');
    if (canonicalJson(JSON.parse(corpus.bodies[index]!)) !== canonicalJson(resource)) refuse('corpus-body-identity');
    return `{"resource":${corpus.bodies[index]},"request":{"method":"PUT","url":${JSON.stringify(`${resource.resourceType}/${resource.id}`)}}}`;
  });
  if (new Set(corpus.resources.map(resource => `${resource.resourceType}/${resource.id}`)).size !== entries.length) refuse('corpus-duplicate');
  await censusExternalCorpus(client, corpus, false);
  const response = await client.request(client.transport.base, `{"resourceType":"Bundle","type":"transaction","entry":[${entries.join(',')}]}`);
  if (response.resourceType !== 'Bundle' || response.type !== 'transaction-response' || !Array.isArray(response.entry) || response.entry.length !== entries.length || response.entry.some(entry => !/^20[01](?: |$)/.test(String(rec(rec(entry)?.response)?.status)))) refuse('transaction-result');
  const versions = new Map<string, string>();
  for (const resource of corpus.resources) {
    const actual = await client.request(client.transport.url(`${resource.resourceType}/${resource.id}`));
    if (!compareExternalResource(resource, actual)) refuse('round-trip-mismatch');
    const version = rec(actual.meta)?.versionId;
    if (typeof version !== 'string' || !version) refuse('round-trip-version');
    versions.set(resource.id, version);
  }
  await censusExternalCorpus(client, corpus, true);
  return versions;
}

async function discoverExternalIdentity(baseUrl: string, imageDigest: string, corpus: ExternalCorpus): Promise<ExternalIdentity> {
  const client = new ExternalClient(baseUrl);
  const metadata = await client.request(client.transport.url('metadata'));
  const software = rec(metadata.software);
  if (metadata.resourceType !== 'CapabilityStatement' || software?.name !== 'HAPI FHIR Server' || software.version !== '8.12.0' || metadata.fhirVersion !== '4.0.1') refuse('backend-identity');
  const gateway = new FhirGateway({ mode: 'synthetic', source: { alias: EVAL_SOURCE_ALIAS, baseUrl }, patientId: EVAL_PATIENT_ID, contextId: 'eval-context-v0' } as GatewayConfig);
  try {
    const result = await gateway.execute('fhir_capabilities', { topic: 'server' });
    if (result.error || result.source.capability_revision === 'unknown') refuse('capability-revision');
    return { software: software.name as string, software_version: software.version as string, fhir_version: metadata.fhirVersion as string,
      image_digest: imageDigest, corpus_sha256: corpus.sha256, tasks_sha256: externalTaskHash(), capability_revision: result.source.capability_revision };
  } finally { gateway.close(); }
}

const PREPARED = new WeakSet<ExternalBackend>();
export interface ExternalBackend {
  baseUrl: string;
  identity: Readonly<ExternalIdentity>;
  corpus: ExternalCorpus;
  versions: ReadonlyMap<string, string>;
}

/** Own every nested object and expose versions through a frozen entry list, never a caller-mutable Map. */
export function immutableExternalBackend(backend: ExternalBackend): ExternalBackend {
  const copy = structuredClone({ baseUrl: backend.baseUrl, identity: backend.identity, corpus: backend.corpus });
  const freeze = (value: object): void => { for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child); Object.freeze(value); };
  freeze(copy);
  const entries = [...backend.versions.entries()].map(entry => Object.freeze(entry));
  Object.freeze(entries);
  const versions: ReadonlyMap<string, string> = Object.freeze({
    size: entries.length, has: (key: string) => entries.some(entry => entry[0] === key), get: (key: string) => entries.find(entry => entry[0] === key)?.[1],
    entries: () => new Map(entries).entries(), keys: () => new Map(entries).keys(), values: () => new Map(entries).values(),
    [Symbol.iterator]: () => new Map(entries).entries(), forEach: (callback: (value: string, key: string, map: ReadonlyMap<string, string>) => void) => { for (const [key, value] of entries) callback(value, key, versions); },
  });
  return Object.freeze({ ...copy, versions });
}

export async function prepareExternalBackend(baseUrl: string, imageDigest: string): Promise<ExternalBackend> {
  baseUrl = externalTransport(baseUrl).base.href.replace(/\/$/, '');
  if (imageDigest !== HAPI_IMAGE_DIGEST) refuse('image-pin');
  const corpus = externalCorpus();
  const identity = await discoverExternalIdentity(baseUrl, imageDigest, corpus);
  const versions = await loadExternalCorpus(new ExternalClient(baseUrl), corpus);
  const backend = immutableExternalBackend({ baseUrl, identity, corpus, versions });
  PREPARED.add(backend);
  await verifyExternalBackend(backend);
  return backend;
}

/** Fresh metadata and complete census on every run boundary; proof cannot survive backend or corpus drift. */
export async function verifyExternalBackend(backend: ExternalBackend): Promise<void> {
  if (!PREPARED.has(backend)) refuse('unprepared-backend');
  const observed = await discoverExternalIdentity(backend.baseUrl, backend.identity.image_digest, externalCorpus());
  if (canonicalJson(observed) !== canonicalJson(backend.identity)) refuse('backend-drift');
  await censusExternalCorpus(new ExternalClient(backend.baseUrl), backend.corpus, true);
}

/** Re-derive an unevidenced private candidate even after the declaration has been publicly qualified. */
export function externalCandidate(backend: ExternalBackend): SearchProfile {
  const declared = declaredSearchProfile('hapi-r4-labs-v1');
  if (!declared) refuse('missing-profile-declaration');
  const identity = backend.identity;
  for (const key of ['software', 'software_version', 'fhir_version', 'image_digest', 'corpus_sha256'] as const) {
    if (declared.source[key] !== identity[key]) refuse(`candidate-declaration-${key}`);
  }
  if (declared.source.kind !== 'external'
    || externalHash([...declared.testIds].sort()) !== externalHash(externalApplicability().filter(row => row.profile_control).map(row => row.task_id).sort())) refuse('candidate-declaration');
  return { ...structuredClone(declared), eligible: false, evidence: null };
}
