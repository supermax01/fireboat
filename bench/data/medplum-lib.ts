// Pure helpers for the Medplum loader and its reconciliation (bench:medplum:load). No I/O here; tests/medplum.test.ts.
//
// Id strategy: client ids are preserved. Every Synthea development id is a UUID, Medplum accepts client-assigned UUIDs
// on PUT (update-as-create) from a super-admin context only (repo.ts canSetId), and a super admin may set meta.project.
// The loader therefore PUTs each resource at its file id as the bootstrap super-admin client, with meta.project set to
// the bench project. Questions, probes, gold and references stay valid without an id map. Every accepted entry's
// response location is checked against the id sent (a changed id would be counted, never hidden).
import { join } from 'node:path';
import { RESULTS, type DatasetId } from '../lib/paths.js';
import { parseLossless, stringifyLossless, type LosslessValue } from '../lib/json.js';

/** Medplum loader state and outputs (git-ignored, outside bench/): project.json, progress.jsonl, rejections.jsonl, reconcile.json, clients.json. */
export const medplumDir = (d: DatasetId) => join(RESULTS, 'medplum', d);

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Splits line indices into chunks of at most maxEntries entries and maxBytes of resource text (a single larger line is its own chunk). */
export function chunkIndices(lineBytes: readonly number[], maxEntries: number, maxBytes: number): number[][] {
  const out: number[][] = [];
  let cur: number[] = [];
  let bytes = 0;
  for (const [i, b] of lineBytes.entries()) {
    if (cur.length && (cur.length >= maxEntries || bytes + b > maxBytes)) { out.push(cur); cur = []; bytes = 0; }
    cur.push(i);
    bytes += b;
  }
  if (cur.length) out.push(cur);
  return out;
}

export interface SentEntry { type: string; id: string }

/**
 * A FHIR batch Bundle of PUT Type/id entries, each resource with meta.project set (other meta kept). Numbers keep their
 * lexemes in the request (Medplum itself stores parsed JSON).
 */
export function batchBundle(projectId: string, lines: readonly string[]): { body: string; sent: SentEntry[] } {
  const sent: SentEntry[] = [];
  const entry = lines.map(line => {
    const r = parseLossless(line) as Record<string, LosslessValue>;
    const type = r.resourceType, id = r.id;
    if (typeof type !== 'string' || typeof id !== 'string') throw new Error('resource without resourceType or id');
    if (!UUID_RE.test(id)) throw new Error(`${type}/${id}: Medplum accepts client ids only as UUIDs`);
    sent.push({ type, id });
    const meta = r.meta && typeof r.meta === 'object' && !Array.isArray(r.meta) ? (r.meta as Record<string, LosslessValue>) : {};
    return { request: { method: 'PUT', url: `${type}/${id}` }, resource: { ...r, meta: { ...meta, project: projectId } } };
  });
  return { body: stringifyLossless({ resourceType: 'Bundle', type: 'batch', entry }), sent };
}

export interface Rejection { type: string; id: string; status: number; reason: string; issues: string[] }
export interface BatchTally { accepted: number; rejected: Rejection[]; id_changed: SentEntry[] }

const isObj = (x: unknown): x is Record<string, LosslessValue> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** Issue texts of an OperationOutcome: "<code>: <details.text or diagnostics> @ <expression>". */
export function issueTexts(outcome: unknown): string[] {
  if (!isObj(outcome) || !Array.isArray(outcome.issue)) return [];
  return outcome.issue.filter(isObj).filter(i => i.severity === 'error' || i.severity === 'fatal' || i.severity === undefined).map(i => {
    const text = isObj(i.details) && typeof i.details.text === 'string' ? i.details.text : typeof i.diagnostics === 'string' ? i.diagnostics : '';
    const expr = Array.isArray(i.expression) ? i.expression.filter((e): e is string => typeof e === 'string').join(',') : '';
    return `${String(i.code ?? 'unknown')}: ${text}${expr ? ` @ ${expr}` : ''}`;
  });
}

/** Groupable form of a reason: UUIDs, array indices and long numbers replaced by placeholders. */
export function normaliseReason(text: string): string {
  return text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>').replace(/\[\d+\]/g, '[*]').replace(/\b\d{4,}\b/g, '<n>');
}

/** Tallies a batch-response Bundle against the entries sent, entry by entry. A missing or malformed entry is a rejection. */
export function tallyBatchResponse(sent: readonly SentEntry[], response: LosslessValue | null): BatchTally {
  const entries = isObj(response) && Array.isArray(response.entry) ? response.entry : [];
  const out: BatchTally = { accepted: 0, rejected: [], id_changed: [] };
  for (const [i, s] of sent.entries()) {
    const e = entries[i];
    const resp = isObj(e) && isObj(e.response) ? e.response : null;
    const status = resp ? Number.parseInt(String(resp.status ?? ''), 10) : NaN;
    if (Number.isFinite(status) && status >= 200 && status < 300) {
      out.accepted++;
      const loc = typeof resp?.location === 'string' ? resp.location : null;
      if (loc && !loc.startsWith(`${s.type}/${s.id}`) && !loc.includes(`/${s.type}/${s.id}`)) out.id_changed.push(s);
      continue;
    }
    const issues = issueTexts(resp?.outcome ?? (isObj(e) ? e.resource : undefined));
    const reason = issues.length ? issues.map(normaliseReason).join(' | ') : resp ? `HTTP ${Number.isFinite(status) ? status : String(resp.status)} without an OperationOutcome` : 'no response entry';
    out.rejected.push({ type: s.type, id: s.id, status: Number.isFinite(status) ? status : 0, reason, issues });
  }
  return out;
}

export interface TypeTally { sent: number; accepted: number; rejected: number }
export interface ReconcileRow { type: string; source: number; sent: number; accepted: number; rejected: number; served: number | null; ok: boolean; problems: string[] }

/**
 * Per-type reconciliation: every source resource was sent, every sent entry was accepted or rejected, and the server
 * serves exactly the accepted count. A type served but absent from the source is reported too.
 */
export function reconcileCounts(source: Readonly<Record<string, number>>, tally: Readonly<Record<string, TypeTally>>, served: Readonly<Record<string, number | null>>): { ok: boolean; rows: ReconcileRow[] } {
  const types = [...new Set([...Object.keys(source), ...Object.keys(tally), ...Object.keys(served)])].sort();
  const rows = types.map(type => {
    const src = source[type] ?? 0;
    const t = tally[type] ?? { sent: 0, accepted: 0, rejected: 0 };
    const sv = type in served ? served[type]! : null;
    const problems: string[] = [];
    if (!(type in source)) problems.push('not in the source');
    if (t.sent !== src) problems.push(`sent ${t.sent} != source ${src}`);
    if (t.accepted + t.rejected !== t.sent) problems.push(`accepted ${t.accepted} + rejected ${t.rejected} != sent ${t.sent}`);
    if (sv === null) problems.push('served count unavailable');
    else if (sv !== t.accepted) problems.push(`served ${sv} != accepted ${t.accepted}`);
    return { type, source: src, sent: t.sent, accepted: t.accepted, rejected: t.rejected, served: sv, ok: problems.length === 0, problems };
  });
  return { ok: rows.every(r => r.ok), rows };
}

/** Rejections grouped by type and normalised reason, largest first. */
export function rejectionSummary(rejections: readonly Rejection[]): { type: string; reason: string; count: number }[] {
  const m = new Map<string, { type: string; reason: string; count: number }>();
  for (const r of rejections) {
    const k = `${r.type}\u0000${r.reason}`;
    const cur = m.get(k);
    if (cur) cur.count++; else m.set(k, { type: r.type, reason: r.reason, count: 1 });
  }
  return [...m.values()].sort((a, b) => b.count - a.count || a.type.localeCompare(b.type) || a.reason.localeCompare(b.reason));
}
