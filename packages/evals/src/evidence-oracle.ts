/**
 * Packaging slice 7: the pure evidence oracle shared by the eval runner and the packaged quickstart verifier. It binds
 * every check to its step and response, reads facts, citations and versions from gateway envelopes and raw numeric
 * lexemes from server wire text. Runtime imports are `node:crypto` and the check vocabulary only: no HTTP, SDK, gateway
 * or fixture module, so the helper can share it without the eval runner (checked by tests/package-oracle.test.ts).
 */
import { createHash } from 'node:crypto';
import type { GatewayEnvelope } from '../../core/src/index.js';
import { M3B_CHECK_KINDS, type ArmName, type Check } from './check-contracts.js';
import type { IssuedLinkProvenance, ObservedUpstreamRequest } from './upstream-provenance.js';

export type FailureCause =
  | 'expected_fact_missing' | 'expected_fact_mismatch' | 'expected_absence_violated' | 'version_mismatch'
  | 'resource_id_mismatch' | 'data_mismatch' | 'schema_element_mismatch'
  | 'withheld_marker_missing' | 'omitted_marker_missing'
  | 'prohibited_disclosure' | 'budget_bytes_exceeded' | 'budget_upstream_calls_exceeded' | 'budget_tool_calls_exceeded'
  | 'call_byte_limit_exceeded'
  | 'unexpected_error' | 'expected_error_mismatch' | 'sdk_tool_error'
  | 'provenance_missing' | 'coverage_invalid' | 'pagination_invalid' | 'upstream_count_mismatch' | 'envelope_invalid'
  | 'upstream_confinement_missing' | 'upstream_constraint_missing' | 'unsafe_total' | 'signal_inconsistent' | 'constraint_overclaimed'
  | 'known_defect_resolved' | 'harness_error' | 'upstream_work_mismatch' | 'private_profile_label_missing';

export interface Failure { cause: FailureCause; detail: string; check_id?: string; step?: number; known_defect?: string }
export interface CheckResult { check_id: string; kind: Check['kind']; step?: number; status: 'pass' | 'fail' | 'incomparable' | 'pending_profile_proof'; cause?: FailureCause; detail?: string; known_defect?: string }
export type UpstreamWork = { metadata: number; auth: number; clinical: number };

type Rec = Record<string, unknown>;
const asRec = (v: unknown): Rec | undefined => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Rec : undefined);

/** Key-sorted JSON; the same definition as the eval fixture's, kept here so the kernel never loads the fixture server module (whose bytes the search profile pins). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function resolvePath(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const part of path.split('.')) {
    if (Array.isArray(current)) {
      const idx = Number(part);
      if (!Number.isInteger(idx)) return undefined;
      current = current[idx];
    } else {
      const rec = asRec(current);
      if (!rec || !Object.hasOwn(rec, part)) return undefined;
      current = rec[part];
    }
  }
  return current;
}
export const deepEqual = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);
const short = (v: unknown): string => { const s = canonicalJson(v); return s.length > 160 ? `${s.slice(0, 157)}...` : s; };
export const resourcesOf = (envelope: GatewayEnvelope): Rec[] => (Array.isArray(envelope.data.resources) ? envelope.data.resources : []).map(asRec).filter((r): r is Rec => Boolean(r));

export interface Occurrence { resource: Rec; envelope: number; version?: string }
/** Per-call protocol/application outcome recorded by the harness (G-3e). */
export interface CallOutcomeRecord { class: 'json_rpc_error' | 'sdk_text_error' | 'application_error'; code: number | string }
export interface CollectedEvidence {
  envelopes: GatewayEnvelope[];
  /** resource id -> every returned occurrence, with the version its own response's provenance reports */
  resourcesById: Map<string, Occurrence[]>;
  /** Every returned occurrence, including duplicates across pages or calls. */
  resourceOrder: string[];
  /** Upstream request paths observed while producing these envelopes. */
  requests: string[];
  upstreamProvenance?: { ledger: IssuedLinkProvenance; requests: ObservedUpstreamRequest[] };
  /** Per-call upstream work (metadata/auth/clinical request counts) for the bound step, when known. */
  work?: UpstreamWork[];
  serialized: string;
  /** Server-emitted serialized result text per envelope (raw wire text; §9/S-17). */
  rawResults: (string | undefined)[];
  /** Recorded call outcomes for the bound step, in call order. */
  callOutcomes: CallOutcomeRecord[];
  /** The envelopes as delivered, before query-chain resolution fills continuation coverage (parallel to `envelopes`). */
  delivered?: GatewayEnvelope[];
  /** For `retainedSlice`: the response that issued the retained handle. */
  retainedSource?: GatewayEnvelope;
  retainedRaw?: string;
}

const RETRIEVED_AT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;
/** A full timestamp whose calendar date and clock time exist (no Feb 30, no 24:00); an offset of at most ±14:00. */
export function validTimestamp(text: string): boolean {
  const m = RETRIEVED_AT.exec(text);
  if (!m) return false;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const days = new Date(Date.UTC(2000, month, 0)).getUTCDate() - (month === 2 && !(year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) ? 1 : 0);
  return month >= 1 && month <= 12 && day >= 1 && day <= days && hour <= 23 && minute <= 59 && second <= 59
    && (m[7] === undefined || (Number(m[7]) <= 14 && Number(m[8]) <= 59 && (Number(m[7]) < 14 || Number(m[8]) === 0)));
}
/**
 * The response-local resource indexes this envelope cites. Provenance is all or nothing: a missing array, an entry
 * whose index is not a distinct in-range integer, or a retrieval time that is not a valid timestamp cites nothing.
 */
export function citedIndexes(envelope: GatewayEnvelope): ReadonlySet<number> {
  const provenance = (envelope as unknown as Rec).provenance, count = resourcesOf(envelope).length, cited = new Set<number>();
  if (!Array.isArray(provenance)) return cited;
  for (const item of provenance) {
    const entry = asRec(item), index = entry?.resource_index, time = entry?.retrieved_at;
    if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || index >= count || cited.has(index)
      || typeof time !== 'string' || !validTimestamp(time)) return new Set();
    cited.add(index);
  }
  return cited;
}

/** Version belongs to the resource selected by this response-local index. */
function provenanceVersion(envelope: GatewayEnvelope, resource: Rec, resourceIndex: number): string | undefined {
  if (!citedIndexes(envelope).has(resourceIndex)) return undefined;
  const versionId = asRec(resource.meta)?.versionId;
  return typeof versionId === 'string' ? versionId : undefined;
}

export function collectEvidence(envelopes: GatewayEnvelope[], requests: string[] = [], extras?: { rawResults?: (string | undefined)[]; callOutcomes?: CallOutcomeRecord[]; work?: UpstreamWork[]; upstreamProvenance?: CollectedEvidence['upstreamProvenance']; delivered?: GatewayEnvelope[]; retainedSource?: GatewayEnvelope; retainedRaw?: string }): CollectedEvidence {
  const resourcesById = new Map<string, Occurrence[]>();
  const resourceOrder: string[] = [];
  envelopes.forEach((envelope, index) => {
    resourcesOf(envelope).forEach((resource, resourceIndex) => {
      if (typeof resource.id !== 'string') return;
      const version = provenanceVersion(envelope, resource, resourceIndex);
      if (!resourcesById.has(resource.id)) resourcesById.set(resource.id, []);
      resourceOrder.push(resource.id);
      resourcesById.get(resource.id)!.push({ resource, envelope: index, ...(version !== undefined ? { version } : {}) });
    });
  });
  const callOutcomes = extras?.callOutcomes ?? envelopes.flatMap(e => (e.error ? [{ class: 'application_error' as const, code: e.error.code }] : []));
  return { envelopes, resourcesById, resourceOrder, requests, serialized: envelopes.map(e => JSON.stringify(e)).join('\n'), rawResults: extras?.rawResults ?? envelopes.map(() => undefined), callOutcomes, ...(extras?.work ? { work: extras.work } : {}), ...(extras?.upstreamProvenance ? { upstreamProvenance: extras.upstreamProvenance } : {}),
    ...(extras?.delivered ? { delivered: extras.delivered } : {}), ...(extras?.retainedSource ? { retainedSource: extras.retainedSource, retainedRaw: extras.retainedRaw } : {}) };
}

// --- Raw JSON scan (G-3b): preserves numeric token lexemes from server wire text. ---
type RawNode =
  | { kind: 'object'; props: Map<string, RawNode> }
  | { kind: 'array'; items: RawNode[] }
  | { kind: 'string'; value: string }
  | { kind: 'number'; raw: string }
  | { kind: 'literal'; value: boolean | null };
function parseRawJson(text: string): RawNode | undefined {
  let i = 0;
  const fail = (): never => { throw new Error('raw json'); };
  const ws = (): void => { while (i < text.length && ' \t\n\r'.includes(text[i]!)) i++; };
  const parseString = (): string => {
    if (text[i] !== '"') fail();
    i++;
    let out = '';
    while (i < text.length && text[i] !== '"') {
      if (text[i] === '\\') {
        const esc = text[i + 1];
        if (esc === 'u') { out += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16)); i += 6; }
        else { out += ({ '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' } as Record<string, string>)[esc ?? ''] ?? fail(); i += 2; }
      } else { out += text[i]; i++; }
    }
    if (text[i] !== '"') fail();
    i++;
    return out;
  };
  const parseValue = (): RawNode => {
    ws();
    const ch = text[i];
    if (ch === '{') {
      i++; const props = new Map<string, RawNode>();
      ws(); if (text[i] === '}') { i++; return { kind: 'object', props }; }
      for (;;) { ws(); const key = parseString(); ws(); if (text[i] !== ':') fail(); i++; props.set(key, parseValue()); ws(); if (text[i] === '}') { i++; break; } if (text[i] !== ',') fail(); i++; }
      return { kind: 'object', props };
    }
    if (ch === '[') {
      i++; const items: RawNode[] = [];
      ws(); if (text[i] === ']') { i++; return { kind: 'array', items }; }
      for (;;) { items.push(parseValue()); ws(); if (text[i] === ']') { i++; break; } if (text[i] !== ',') fail(); i++; }
      return { kind: 'array', items };
    }
    if (ch === '"') return { kind: 'string', value: parseString() };
    if (text.startsWith('true', i)) { i += 4; return { kind: 'literal', value: true }; }
    if (text.startsWith('false', i)) { i += 5; return { kind: 'literal', value: false }; }
    if (text.startsWith('null', i)) { i += 4; return { kind: 'literal', value: null }; }
    const num = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i));
    if (num) { i += num[0].length; return { kind: 'number', raw: num[0] }; }
    return fail();
  };
  try { const node = parseValue(); ws(); return i === text.length ? node : undefined; } catch { return undefined; }
}
/** The raw text of one top-level member of a JSON-RPC frame (e.g. `result`), sliced without decoding so numeric lexemes survive. */
export function rawMember(text: string, wanted: string): string | undefined {
  let i = 0;
  const ws = () => { while (/\s/.test(text[i] ?? '') && i < text.length) i++; };
  const stringEnd = () => { i++; while (i < text.length) { if (text[i++] === '"') return; if (text[i - 1] === '\\') i++; } throw new Error('Invalid raw frame.'); };
  const valueEnd = () => {
    const stack: string[] = [];
    if (text[i] === '"') { stringEnd(); return; }
    if (text[i] === '{' || text[i] === '[') {
      stack.push(text[i++]!);
      while (stack.length && i < text.length) {
        if (text[i] === '"') stringEnd();
        else { const ch = text[i++]!; if (ch === '{' || ch === '[') stack.push(ch); else if (ch === '}' || ch === ']') stack.pop(); }
      }
    } else while (i < text.length && !/[\s,}]/.test(text[i]!)) i++;
  };
  ws(); if (text[i++] !== '{') return undefined; ws();
  while (i < text.length && text[i] !== '}') {
    const keyStart = i; stringEnd(); const key = JSON.parse(text.slice(keyStart, i)); ws();
    if (text[i++] !== ':') throw new Error('Invalid raw frame.'); ws();
    const start = i; valueEnd(); const value = text.slice(start, i); if (key === wanted) return value;
    ws(); if (text[i] === ',') { i++; ws(); } else break;
  }
  return undefined;
}
function rawAtPath(node: RawNode | undefined, path: string): RawNode | undefined {
  let current = node;
  for (const part of path.split('.')) {
    if (!current) return undefined;
    if (current.kind === 'array') { const idx = Number(part); current = Number.isInteger(idx) ? current.items[idx] : undefined; }
    else if (current.kind === 'object') current = current.props.get(part);
    else return undefined;
  }
  return current;
}
function rawString(node: RawNode | undefined): string | undefined { return node?.kind === 'string' ? node.value : undefined; }
/** The plain value a raw node decodes to (numbers as JSON.parse reads them), to compare raw and decoded forms. */
function rawValue(node: RawNode): unknown {
  switch (node.kind) {
    case 'object': return Object.fromEntries([...node.props].map(([key, child]) => [key, rawValue(child)]));
    case 'array': return node.items.map(rawValue);
    case 'string': return node.value;
    case 'number': return Number(node.raw);
    case 'literal': return node.value;
  }
}

function armApplies(check: Check, arm: ArmName): boolean {
  return !check.arms || check.arms.includes(arm);
}

/** Search/page requests (not reads or metadata) as parsed URLs, from the fixture's request log. */
export function searchRequests(requests: string[]): URL[] {
  return requests.map(path => new URL(path, 'http://fixture.invalid')).filter(url => {
    const segments = url.pathname.split('/').filter(Boolean);
    return segments.length === 1 || (segments.length === 2 && segments[1] !== 'metadata');
  });
}

export function evaluateCheck(check: Check, arm: ArmName, evidence: CollectedEvidence): CheckResult {
  const base = { check_id: check.id, kind: check.kind, ...(check.step !== undefined ? { step: check.step } : {}) };
  if (!armApplies(check, arm)) {
    return { ...base, status: 'incomparable', detail: check.incomparableReason ?? `not comparable for arm ${arm}` };
  }
  const fail = (cause: FailureCause, detail: string): CheckResult => ({ ...base, status: 'fail', cause, detail });
  const pass = (): CheckResult => ({ ...base, status: 'pass' });
  switch (check.kind) {
    case 'fact': case 'factAbsent': {
      const all = evidence.resourcesById.get(check.resource);
      if (!all?.length) return fail('expected_fact_missing', `resource ${check.resource} not returned by the bound response`);
      const versions = check.version === undefined ? all : all.filter(o => o.version === check.version);
      if (!versions.length) return fail('version_mismatch', `${check.resource} returned without provenance version ${check.version} in the same response`);
      if (new Set(versions.map(o => o.resource.resourceType)).size > 1) return fail('resource_id_mismatch', `${check.resource} names resources of more than one type in the bound response`);
      if (check.kind === 'factAbsent') {
        return versions.every(o => resolvePath(o.resource, check.path) === undefined)
          ? pass()
          : fail('expected_absence_violated', `${check.resource}.${check.path} present but must be absent`);
      }
      const values = versions.map(o => resolvePath(o.resource, check.path));
      if (values.some(v => v !== undefined && deepEqual(v, check.equals))) return pass();
      if (values.every(v => v === undefined)) return fail('expected_fact_missing', `${check.resource}.${check.path} absent in arm ${arm}`);
      return fail('expected_fact_mismatch', `${check.resource}.${check.path} expected ${short(check.equals)} got ${short(values.find(v => v !== undefined))}`);
    }
    case 'resourceIds':
      return deepEqual(evidence.resourceOrder, check.equals)
        ? pass()
        : fail('resource_id_mismatch', `expected ids ${short(check.equals)} got ${short(evidence.resourceOrder)}`);
    case 'resourceIdSet':
      return new Set(evidence.resourceOrder).size === evidence.resourceOrder.length
        && new Set(check.equals).size === check.equals.length
        && deepEqual([...evidence.resourceOrder].sort(), [...check.equals].sort())
        ? pass() : fail('resource_id_mismatch', 'exact unordered membership differs or includes duplicate identities');
    case 'resourceAbsent':
      return evidence.resourcesById.has(check.resource) || evidence.serialized.includes(`"${check.resource}"`)
        ? fail('expected_absence_violated', `resource ${check.resource} was delivered`)
        : pass();
    case 'dataPath': {
      const values = evidence.envelopes.map(e => resolvePath(e.data, check.path));
      return values.some(v => v !== undefined && deepEqual(v, check.equals))
        ? pass()
        : fail(values.every(v => v === undefined) ? 'expected_fact_missing' : 'data_mismatch', `data.${check.path} expected ${short(check.equals)} got ${short(values.find(v => v !== undefined))}`);
    }
    case 'dataPathIncludes': {
      const ok = evidence.envelopes.some(e => { const v = resolvePath(e.data, check.path); return Array.isArray(v) && v.some(item => deepEqual(item, check.includes)); });
      return ok ? pass() : fail('data_mismatch', `data.${check.path} does not include ${short(check.includes)}`);
    }
    case 'envelopePath': {
      const values = evidence.envelopes.map(e => resolvePath(e, check.path));
      return values.some(v => v !== undefined && deepEqual(v, check.equals))
        ? pass()
        : fail('data_mismatch', `${check.path} expected ${short(check.equals)} got ${short(values.find(v => v !== undefined))}`);
    }
    case 'schemaElement': {
      for (const envelope of evidence.envelopes) {
        const elements = Array.isArray(envelope.data.elements) ? envelope.data.elements : [];
        const found = elements.map(asRec).find(el => el?.path === check.elementPath);
        if (!found) continue;
        if (check.types && !deepEqual(found.types, check.types)) return fail('schema_element_mismatch', `${check.elementPath}.types expected ${short(check.types)} got ${short(found.types)}`);
        if (check.min !== undefined && found.min !== check.min) return fail('schema_element_mismatch', `${check.elementPath}.min expected ${check.min} got ${String(found.min)}`);
        if (check.max !== undefined && found.max !== check.max) return fail('schema_element_mismatch', `${check.elementPath}.max expected ${check.max} got ${String(found.max)}`);
        if (check.jsonNamesInclude && !(Array.isArray(found.json_names) && found.json_names.includes(check.jsonNamesInclude))) return fail('schema_element_mismatch', `${check.elementPath}.json_names missing ${check.jsonNamesInclude}`);
        return pass();
      }
      return fail('expected_fact_missing', `schema element ${check.elementPath} not returned`);
    }
    case 'withheld': {
      const all = evidence.envelopes.flatMap(e => e.transform.withheld_payloads);
      // S5b: count validated multiplicity (a well-formed collapse count), never the raw array length.
      // Transcribed independently of core/src/withheld.ts so the eval's reading of a count cannot drift with the producer.
      const multiplicity = (m: Record<string, unknown>) => typeof m.count === 'number' && Number.isSafeInteger(m.count) && m.count >= 2 && Object.keys(m).length === 3 ? m.count : 1;
      const total = all.reduce((n, m) => n + multiplicity(m), 0);
      if (total < check.minCount) return fail('withheld_marker_missing', `withheld_payloads multiplicity ${total} < ${check.minCount}`);
      if (check.reasonsInclude && !all.some(m => m.reason === check.reasonsInclude)) return fail('withheld_marker_missing', `no withheld marker with reason ${check.reasonsInclude}`);
      return pass();
    }
    case 'omittedIncludes': {
      const ok = evidence.envelopes.some(e => Array.isArray(e.transform.omitted_fields) && (e.transform.omitted_fields as unknown[]).includes(check.path));
      return ok ? pass() : fail('omitted_marker_missing', `omitted_fields does not include ${check.path}`);
    }
    case 'upstreamConstraint': {
      const requests = searchRequests(evidence.requests);
      const provenance = evidence.upstreamProvenance;
      const missing = provenance ? provenance.requests.filter(request => request.search).findIndex(request => !provenance.ledger.hasConstraint(request, check.name, check.value))
        : requests.findIndex(url => !url.searchParams.getAll(check.name).includes(check.value));
      return missing < 0 ? pass() : fail('upstream_constraint_missing', `upstream search/page request ${missing + 1} of ${requests.length} omitted the original ${check.name} constraint`);
    }
    case 'totalWithheldWhileMore': {
      const unsafe = evidence.envelopes.findIndex(e => (e.pagination?.has_more === true || Boolean(e.pagination?.next_cursor)) && e.pagination?.total?.value !== undefined);
      return unsafe < 0 ? pass() : fail('unsafe_total', `response ${unsafe + 1} published an upstream total while more pages remained`);
    }
    case 'consistentAcross': {
      const values = evidence.envelopes.map(e => canonicalJson(resolvePath(e, check.path) ?? null));
      return new Set(values).size <= 1 ? pass() : fail('signal_inconsistent', `${check.path} differs across the step's responses: ${short([...new Set(values)])}`);
    }
    case 'constraintNotClaimed': {
      // M3b derived view: executed = constraints with execution != 'unknown' (spec §7).
      const claimed = evidence.envelopes.some(e =>
        (Array.isArray(e.coverage.constraints) && (e.coverage.constraints as Rec[]).some(c => asRec(c)?.name === check.name && asRec(c)?.execution !== 'unknown')));
      return claimed ? fail('constraint_overclaimed', `coverage claims ${check.name} was executed`) : pass();
    }
    case 'decimalLexeme': {
      // §9/S-17: the RAW server-emitted wire text of the bound response, scanned with a
      // lexeme-preserving parser, bound to the exact resource and path. Client-decoded
      // numbers can neither pass (wrong resource) nor fail (7.0 decoding to 7) here.
      // A legacy aggregate predicate: any delivered occurrence may supply the token. `citedFact` binds one cited occurrence.
      let sawRaw = false;
      for (const rawText of evidence.rawResults) {
        if (rawText === undefined) continue;
        sawRaw = true;
        const root = parseRawJson(rawText);
        const structured = root?.kind === 'object' ? root.props.get('structuredContent') : root;
        const resources = rawAtPath(structured, 'data.resources');
        if (resources?.kind !== 'array') continue;
        for (const resource of resources.items) {
          if (rawString(rawAtPath(resource, 'id')) !== check.id_value || rawString(rawAtPath(resource, 'resourceType')) !== check.resource_type) continue;
          const token = rawAtPath(resource, check.path);
          if (token?.kind === 'number' && token.raw === check.equals) return pass();
        }
      }
      return fail('expected_fact_missing', sawRaw
        ? `decimal lexeme ${check.equals} at ${check.path} not found for ${check.resource_type}/${check.id_value} in raw wire text`
        : `decimal lexeme ${check.equals} at ${check.path} cannot be checked: no raw wire text captured for the bound response`);
    }
    case 'citationTuple': {
      const hit = evidence.envelopes.some(e => {
        if (e.source.alias !== check.source) return false;
        return resourcesOf(e).some((resource, index) => {
          if (resource.id !== check.id_value || resource.resourceType !== check.resource_type) return false;
          if (!citedIndexes(e).has(index)) return false;
          const versionId = asRec(resource.meta)?.versionId;
          return check.version === null ? versionId === undefined : versionId === check.version;
        });
      });
      return hit ? pass() : fail('version_mismatch', `citation tuple ${check.source}/${check.resource_type}/${check.id_value}@${check.version ?? 'none'} not in the bound response`);
    }
    case 'queryEvidence': {
      const ok = evidence.envelopes.some(e => e.coverage.state === check.state
        && e.coverage.query_exhausted === check.query_exhausted
        && (check.reasons_include ?? []).every(r => e.coverage.reasons.includes(r))
        && (check.constraints ?? []).every(want => Array.isArray(e.coverage.constraints) && (e.coverage.constraints as Rec[]).some(c => { const got = asRec(c); return got?.name === want.name && got.value === want.value && got.source_reported === want.source_reported && got.execution === want.execution; })));
      return ok ? pass() : fail('coverage_invalid', `query evidence state=${check.state} exhausted=${String(check.query_exhausted)} not in the bound response`);
    }
    case 'sortEvidence': {
      const ok = evidence.envelopes.some(e => {
        const sort = asRec(e.coverage.sort);
        if (sort) return deepEqual(sort.requested ?? [], check.requested) && deepEqual(sort.effective ?? null, check.effective) && sort.order === check.order;
        return false;
      });
      return ok ? pass() : fail('coverage_invalid', `sort evidence ${check.order} not in the bound response`);
    }
    case 'upstreamWork': {
      // Independent fixture-side counts: a pre-send refusal must make zero clinical requests, whatever budget.upstream_calls says.
      if (!evidence.work) return fail('harness_error', 'upstream work counts unavailable for this step');
      const clinical = evidence.work.reduce((s, w) => s + w.clinical, 0);
      const metadata = evidence.work.reduce((s, w) => s + w.metadata, 0);
      if (check.clinical !== undefined && clinical !== check.clinical) return fail('upstream_work_mismatch', `clinical upstream requests expected ${check.clinical} got ${clinical}`);
      if (check.metadata !== undefined && metadata !== check.metadata) return fail('upstream_work_mismatch', `metadata upstream requests expected ${check.metadata} got ${metadata}`);
      return pass();
    }
    case 'citedFact': {
      if (evidence.envelopes.length !== 1) return fail('harness_error', 'a cited fact is bound to exactly one response');
      const envelope = evidence.envelopes[0]!, rows = Array.isArray(envelope.data.resources) ? envelope.data.resources : [];
      const label = `${check.source}/${check.resource_type}/${check.id_value}@${check.version ?? 'none'}`;
      const matches = rows.flatMap((row, index) => {
        const r = asRec(row), versionId = asRec(r?.meta)?.versionId;
        return r && r.resourceType === check.resource_type && r.id === check.id_value && (check.version === null ? versionId === undefined : versionId === check.version) ? [index] : [];
      });
      if (matches.length > 1) return fail('resource_id_mismatch', `${label} occurs more than once in the bound response`);
      const index = matches[0];
      if (index === undefined || envelope.source.alias !== check.source || !citedIndexes(envelope).has(index)) return fail('version_mismatch', `${label} is not a cited occurrence in the bound response`);
      const resource = asRec(rows[index])!;
      // The raw result of the same call decodes, as a whole, to the delivered envelope: the citation, request, provenance and
      // token all come from one response. Its occurrence at the same index is the one whose raw token is read.
      const rawText = evidence.rawResults[0];
      if (rawText === undefined) return fail('expected_fact_missing', `${label} cannot be checked: no raw wire text captured for the bound response`);
      const root = parseRawJson(rawText), structured = root?.kind === 'object' ? root.props.get('structuredContent') : undefined;
      if (!structured || canonicalJson(rawValue(structured)) !== canonicalJson(evidence.delivered?.[0] ?? envelope)) return fail('data_mismatch', `${label}: the raw and decoded responses disagree`);
      const rawRows = rawAtPath(structured, 'data.resources');
      const rawResource = rawRows?.kind === 'array' ? rawRows.items[index] : undefined;
      if (!rawResource) return fail('data_mismatch', `${label}: the raw and decoded responses disagree`);
      const value = resolvePath(resource, check.path);
      if (check.absent) return value === undefined ? pass() : fail('expected_absence_violated', `${label} ${check.path} present but must be absent`);
      if (value === undefined) return fail('expected_fact_missing', `${label} ${check.path} absent from the cited occurrence`);
      if ('equals' in check && check.equals !== undefined && !deepEqual(value, check.equals)) return fail('expected_fact_mismatch', `${label} ${check.path} expected ${short(check.equals)} got ${short(value)}`);
      if (check.lexeme !== undefined) {
        const token = rawAtPath(rawResource, check.path);
        if (token?.kind !== 'number' || token.raw !== check.lexeme) return fail('expected_fact_mismatch', `${label} ${check.path} raw token is not ${check.lexeme}`);
      }
      return pass();
    }
    case 'upstreamPaging': {
      const work = evidence.work, rows = evidence.envelopes.map(e => resourcesOf(e).length);
      if (!work?.length || work.length !== rows.length) return fail('harness_error', 'every call of the drained step needs its envelope and an independent work count');
      if (work.some(w => w.clinical !== 0 && w.clinical !== 1) || work[0]!.clinical !== 1) return fail('upstream_work_mismatch', 'each call makes at most one clinical request, and the first makes one');
      // Runs of calls from one clinical request up to the next: each delivers one upstream page.
      const runs: number[] = [];
      work.forEach((w, i) => { if (w.clinical === 1) runs.push(0); runs[runs.length - 1] = runs[runs.length - 1]! + rows[i]!; });
      const uneven = runs.findIndex((n, i) => i < runs.length - 1 ? n !== check.page_size : n < 1 || n > check.page_size);
      return uneven < 0 ? pass() : fail('upstream_work_mismatch', `upstream page ${uneven + 1} delivered ${runs[uneven]} resources before the next upstream request (page size ${check.page_size})`);
    }
    case 'retainedSlice': {
      const source = evidence.retainedSource;
      if (!source) return fail('expected_fact_missing', `no answered call at step ${check.from_step} issued the retained handle`);
      if (evidence.envelopes.length !== 1) return fail('harness_error', 'a retained read is bound to exactly one response');
      const envelope = evidence.envelopes[0]!, all = resourcesOf(source), expected = all.slice(check.offset, check.offset + check.limit);
      const identity = (type: unknown, id: unknown, version: unknown) => canonicalJson([type, id, version]);
      const rows = check.view === 'omissions'
        ? (Array.isArray(envelope.data.omissions) ? envelope.data.omissions : []).map(o => { const r = asRec(o); return identity(r?.resource_type, r?.id, r?.version); })
        : resourcesOf(envelope).map(r => identity(r.resourceType, r.id, asRec(r.meta)?.versionId));
      if (!expected.length || !deepEqual(rows, expected.map(r => identity(r.resourceType, r.id, asRec(r.meta)?.versionId))))
        return fail('resource_id_mismatch', `retained ${check.view} differ from resources ${check.offset}..${check.offset + check.limit} of the issuing response`);
      if (check.whole_count && envelope.data.resource_count !== all.length) return fail('data_mismatch', `retained resource_count differs from the issuing response's ${all.length}`);
      const more = check.offset + expected.length < all.length, next = more ? check.offset + expected.length : undefined;
      if (envelope.data.next_offset !== next || !source.result || !deepEqual(envelope.result, source.result)) return fail('data_mismatch', 'retained offset or handle/expiry/formats differs from the issuing response');
      const format = arm === 'compact' ? 'compact' : 'fhir';
      if (envelope.transform.format !== format || envelope.transform.requested_format !== format) return fail('data_mismatch', 'retained format controls differ from the request');
      if (check.view === 'omissions') {
        const omissions = envelope.data.omissions as Rec[];
        const policy = check.omissions?.find(p => p.format === format);
        if (omissions.some((row, i) => row.resource_index !== i)) return fail('data_mismatch', 'retained omission indexes must name the returned slice positions');
        if (policy && omissions.some(row => !deepEqual(row.omitted_fields, policy.omitted_fields === 'issuing_transform' ? source.transform.omitted_fields : policy.omitted_fields)
          || !deepEqual(row.withheld_reasons, policy.withheld_reasons) || row.recipe_id !== policy.recipe_id || row.interpretation !== 'clinical_projection'))
          return fail('data_mismatch', 'retained omission details differ from the requested view of the issuing snapshot');
        if (envelope.pagination !== undefined || envelope.provenance !== undefined || envelope.transform.projected) return fail('data_mismatch', 'inspection carries resource delivery controls');
      } else {
        if (!envelope.pagination || envelope.pagination.has_more !== more || envelope.pagination.returned_matches !== expected.length || envelope.pagination.returned_includes !== 0
          || envelope.pagination.next_cursor !== undefined || envelope.pagination.requested_page_size !== undefined) return fail('pagination_invalid', 'retained slice pagination differs from the issuing count');
        if (check.action && envelope.transform.projected !== (check.action === 'project' || format === 'compact')) return fail('data_mismatch', 'retained projection controls differ from the action');
        const indexes = citedIndexes(envelope), sourceIndexes = citedIndexes(source);
        if (indexes.size !== expected.length || sourceIndexes.size !== all.length) return fail('provenance_missing', 'every retained and issuing row must be cited');
        for (let i = 0; i < expected.length; i++) {
          const time = envelope.provenance?.find(p => p.resource_index === i)?.retrieved_at;
          if (time !== source.provenance?.find(p => p.resource_index === check.offset + i)?.retrieved_at) return fail('provenance_missing', 'retained retrieval time differs from the issuing occurrence');
        }
        const rawEnvelope = (raw: string | undefined): RawNode | undefined => {
          const root = raw === undefined ? undefined : parseRawJson(raw);
          return root?.kind === 'object' ? root.props.get('structuredContent') : undefined;
        };
        const sourceRaw = rawEnvelope(evidence.retainedRaw), retainedRaw = rawEnvelope(evidence.rawResults[0]);
        if (!sourceRaw || !retainedRaw || !deepEqual(rawValue(sourceRaw), source) || !deepEqual(rawValue(retainedRaw), evidence.delivered?.[0] ?? envelope))
          return fail('data_mismatch', 'retained comparison requires each whole raw response to match its delivered envelope');
        const sourceRows = rawAtPath(sourceRaw, 'data.resources'), retainedRows = rawAtPath(retainedRaw, 'data.resources');
        const numericTokens = (node: RawNode | undefined, path = '', out: [string, string][] = []): [string, string][] => {
          if (node?.kind === 'number') out.push([path, node.raw]);
          else if (node?.kind === 'object') for (const [key, value] of node.props) numericTokens(value, `${path}/${key}`, out);
          else if (node?.kind === 'array') node.items.forEach((value, i) => numericTokens(value, `${path}/${i}`, out));
          return out.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
        };
        for (const [i] of expected.entries()) for (const field of check.fields ?? []) {
          const want = sourceRows?.kind === 'array' ? rawAtPath(sourceRows.items[check.offset + i], field) : undefined;
          const got = retainedRows?.kind === 'array' ? rawAtPath(retainedRows.items[i], field) : undefined;
          if (!deepEqual(numericTokens(want), numericTokens(got))) return fail('expected_fact_mismatch', `retained resource ${i} ${field} numeric tokens differ from the issuing response`);
        }
      }
      if (check.view === 'resources') for (const [i, row] of resourcesOf(envelope).entries()) for (const field of check.fields ?? []) {
        const want = resolvePath(expected[i], field);
        if (want !== undefined && resolvePath(row, field) === undefined) return fail('expected_fact_mismatch', `retained resource ${i} ${field} is absent from the retained slice`);
        if (want === undefined || !deepEqual(resolvePath(row, field), want)) return fail('expected_fact_mismatch', `retained resource ${i} ${field} differs from the issuing response`);
      }
      return pass();
    }
    case 'callOutcome': {
      const ok = evidence.callOutcomes.some(o => o.class === check.outcome && String(o.code) === String(check.code));
      return ok ? pass() : fail('expected_error_mismatch', `call outcome ${check.outcome}/${String(check.code)} not recorded for the bound step`);
    }
  }
}

/**
 * One recorded tool call of a scripted task as the oracle sees it: the gateway envelope when one was delivered, the
 * server's raw result text, the recorded outcome and the independently counted upstream work. No transport or SDK object.
 */
export interface OracleCall { step: number; envelope?: GatewayEnvelope; rawText?: string; outcome?: CallOutcomeRecord; work?: UpstreamWork; resourceType?: string }

/** The step a check is bound to: its own `step`, or the only step of a single-step task; undefined when that is no step. */
export function boundStep(check: Check, stepCount: number): number | undefined {
  const step = check.step ?? (stepCount === 1 ? 0 : undefined);
  return step !== undefined && Number.isSafeInteger(step) && step >= 0 && step < stepCount ? step : undefined;
}

/** A call's outcome: the recorded one, or the application error its envelope carries. */
const outcomeOf = (call: OracleCall): CallOutcomeRecord | undefined =>
  call.outcome ?? (call.envelope?.error ? { class: 'application_error', code: call.envelope.error.code } : undefined);

/** Evaluates a check against its own step's calls only: a fact, citation, lexeme, outcome or work count in another step never satisfies it. */
export function evaluateStepCheck(check: Check, arm: ArmName, calls: readonly OracleCall[],
  context: { stepCount: number; requests: string[]; resourceType?: string; upstreamProvenance?: CollectedEvidence['upstreamProvenance'] }): CheckResult {
  const step = boundStep(check, context.stepCount);
  if (step === undefined) return { check_id: check.id, kind: check.kind, status: 'fail', cause: 'harness_error', detail: `check ${check.id} is not bound to a valid step` };
  const own = calls.filter(call => call.step === step);
  let retainedSource: GatewayEnvelope | undefined, retainedRaw: string | undefined;
  if (check.kind === 'retainedSlice') {
    if (!Number.isSafeInteger(check.from_step) || check.from_step < 0 || check.from_step >= step)
      return { check_id: check.id, kind: check.kind, status: 'fail', cause: 'harness_error', detail: `check ${check.id} must read an earlier step's handle`, step };
    const issuing = calls.find(call => call.step === check.from_step && call.envelope);
    retainedSource = issuing?.envelope; retainedRaw = issuing?.rawText;
  }
  return { ...judgeCalls(check, arm, own, { requests: context.requests, resourceType: context.resourceType ?? own.find(call => call.envelope)?.resourceType,
    ...(context.upstreamProvenance ? { upstreamProvenance: context.upstreamProvenance } : {}), ...(retainedSource ? { retainedSource, retainedRaw } : {}) }), step };
}

interface Selection { requests: string[]; resourceType?: string; upstreamProvenance?: CollectedEvidence['upstreamProvenance']; sharedOutcomes?: readonly CallOutcomeRecord[]; retainedSource?: GatewayEnvelope; retainedRaw?: string }
/**
 * §9 response selection (G-3a) over one step's calls, each keeping its own envelope, raw text, outcome and work: an
 * omitted `response_index` means call 0 for M3b kinds (the whole step for legacy kinds); an explicit index selects exactly
 * that call and fails when there is none; `'all'` requires at least one call and a pass on EACH call separately.
 */
function judgeCalls(check: Check, arm: ArmName, own: readonly OracleCall[], selection: Selection): CheckResult {
  const base = { check_id: check.id, kind: check.kind, ...(check.step !== undefined ? { step: check.step } : {}) };
  // Applicability first: a check excluded from this arm is incomparable, whatever the step's chain holds (run-wide
  // envelope validity is the verifier's own gate, not an inapplicable check's verdict).
  if (check.arms && !check.arms.includes(arm)) return { ...base, status: 'incomparable', detail: check.incomparableReason ?? `not comparable for arm ${arm}` };
  const answered = own.filter(call => call.envelope !== undefined);
  const resolved = resolveQueryChain(answered.map(call => call.envelope!), selection.resourceType);
  if (resolved.error) return { check_id: check.id, kind: check.kind, status: 'fail', cause: 'coverage_invalid', detail: resolved.error };
  const delivered = new Map(answered.map((call, i) => [call, resolved.envelopes[i]!]));
  const judge = (selected: readonly OracleCall[]): CheckResult => {
    const withEnvelope = selected.filter(call => delivered.has(call));
    const work = selected.length > 0 && selected.every(call => call.work) ? selected.map(call => call.work!) : undefined;
    const outcomes = selection.sharedOutcomes ?? selected.flatMap(call => { const outcome = outcomeOf(call); return outcome ? [outcome] : []; });
    return evaluateCheck(check, arm, collectEvidence(withEnvelope.map(call => delivered.get(call)!), selection.requests, { rawResults: withEnvelope.map(call => call.rawText),
      callOutcomes: [...outcomes], ...(work ? { work } : {}), ...(selection.upstreamProvenance ? { upstreamProvenance: selection.upstreamProvenance } : {}),
      delivered: withEnvelope.map(call => call.envelope!), ...(selection.retainedSource ? { retainedSource: selection.retainedSource, retainedRaw: selection.retainedRaw } : {}) }));
  };
  if (check.response_index === 'all') {
    if (!own.length) return { ...base, status: 'fail', cause: 'expected_fact_missing', detail: `response_index 'all' requires at least one response in the bound step` };
    let firstFail: CheckResult | undefined, firstIncomparable: CheckResult | undefined;
    for (const [index, call] of own.entries()) {
      const result = judge([call]);
      if (result.status === 'incomparable' && !firstIncomparable) firstIncomparable = result;
      if (result.status === 'fail' && !firstFail) firstFail = { ...result, detail: `response ${index} of 'all': ${result.detail ?? ''}` };
    }
    return firstFail ?? firstIncomparable ?? { ...base, status: 'pass' };
  }
  if (typeof check.response_index === 'number') {
    const call = own[check.response_index];
    return call ? judge([call]) : { ...base, status: 'fail', cause: 'expected_fact_missing', detail: `response ${check.response_index} is not in the bound step` };
  }
  if (M3B_CHECK_KINDS.has(check.kind)) return judge(own.slice(0, 1));
  return judge(own);
}

/** Independent response-chain evidence resolver; its cache never escapes one bound step. */
export function resolveQueryChain(envelopes: GatewayEnvelope[], resourceType?: string): { envelopes: GatewayEnvelope[]; error?: string } {
  let previous: GatewayEnvelope['coverage'] | undefined, identity: string | undefined, chainType = resourceType;
  const output: GatewayEnvelope[] = [];
  for (const envelope of envelopes) {
    const c = envelope.coverage;
    if (envelope.error || c.scope === 'metadata' || c.query_digest === undefined) { output.push(envelope); continue; }
    // The bound type, else the chain's first returned type (an empty later page keeps it); every returned resource must have it.
    const type = chainType ?? (resourcesOf(envelope)[0]?.resourceType as string | undefined);
    if (type !== undefined && resourcesOf(envelope).some(r => r.resourceType !== type)) return { envelopes: [], error: 'A returned resource type differs from the bound query type.' };
    chainType = type;
    const binding = canonicalJson([envelope.source.alias, envelope.source.capability_revision, envelope.context.policy_revision, envelope.context.handle, type, c.query_digest]);
    if (identity !== undefined && identity !== binding) return { envelopes: [], error: 'Foreign query identity in bound step.' };
    identity = binding;
    let constraints = c.constraints;
    let sort = c.sort;
    if (constraints === undefined) {
      if (!previous?.constraints || c.constraints_on_first_page !== true || c.query_digest !== previous.query_digest) return { envelopes: [], error: 'Missing bound query identity for shorthand.' };
      constraints = previous.constraints;
      if (previous.sort) {
        if (!sort) return { envelopes: [], error: 'Missing continuation sort controls.' };
        sort = { ...sort, requested: previous.sort.requested };
      }
    } else if (c.constraints_on_first_page !== undefined) return { envelopes: [], error: 'Full evidence also claims shorthand.' };
    const expected = createHash('sha256').update(JSON.stringify({ v: 1, source_revision: envelope.source.capability_revision,
      policy_revision: envelope.context.policy_revision, context_handle: envelope.context.handle, resource_type: type,
      constraints: constraints.map(({ name, value }) => ({ name, value })), sort: [...(sort?.requested ?? [])] })).digest('hex');
    if (expected !== c.query_digest) return { envelopes: [], error: 'Query digest does not bind the ordered material pairs and sort.' };
    if (previous?.constraints && constraints.some((item, i) => previous!.constraints![i]?.execution === 'unknown' && item.execution !== 'unknown')) return { envelopes: [], error: 'Continuation illegally upgrades execution proof.' };
    const resolved = { ...c, constraints, ...(sort ? { sort } : {}) };
    previous = resolved; output.push({ ...envelope, coverage: resolved });
  }
  return { envelopes: output };
}

/**
 * The legacy envelope-level entry point: the same selection as `evaluateStepCheck`, but over delivered envelopes only,
 * with the given outcomes visible to every selected response (aggregate evidence, not call-exact binding) and each
 * envelope's own work count. Exact-call verification (the helper's) uses `evaluateStepCheck` with per-call records.
 */
export function evaluateBoundCheck(
  check: Check, arm: ArmName,
  stepEnvelopes: GatewayEnvelope[], requests: string[],
  extras?: { rawResults?: (string | undefined)[]; callOutcomes?: CallOutcomeRecord[]; resourceType?: string; work?: UpstreamWork[]; upstreamProvenance?: CollectedEvidence['upstreamProvenance'] },
): CheckResult {
  const calls: OracleCall[] = stepEnvelopes.map((envelope, i) => ({ step: 0, envelope, ...(extras?.rawResults?.[i] !== undefined ? { rawText: extras.rawResults[i] } : {}),
    ...(extras?.work?.[i] ? { work: extras.work[i] } : {}) }));
  return judgeCalls(check, arm, calls, { requests, ...(extras?.resourceType !== undefined ? { resourceType: extras.resourceType } : {}),
    ...(extras?.callOutcomes ? { sharedOutcomes: extras.callOutcomes } : {}), ...(extras?.upstreamProvenance ? { upstreamProvenance: extras.upstreamProvenance } : {}) });
}
