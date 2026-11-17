// Pure helpers for the HealthLake loader (bench:healthlake -- load). No I/O; tests/healthlake.test.ts.
//
// Load method: FHIR batch Bundles of `PUT Type/<file id>`
// sent to the data store base, signed with SigV4. HealthLake documents PUT as update-as-create ("creates an initial
// version if no resource already exists for the given id", 201), so every resource keeps its file id and the questions,
// probes and gold stay valid without an id map. Each entry's response location is checked against the id sent. The
// request header x-amzn-healthlake-fhir-validation-level: structure-only validates against R4 and ignores meta.profile.
// Resource text is embedded byte for byte (no re-serialisation), so decimal lexemes reach HealthLake as recorded.
import { parseLossless, type LosslessValue } from '../lib/json.js';
import type { SentEntry } from '../data/medplum-lib.js';

/** HealthLake's logical id pattern (FHIR R4 id). */
export const HEALTHLAKE_ID_RE = /^[A-Za-z0-9\-.]{1,64}$/;
/** Quota "Number of resources per Bundle": 500. The loader stays well below it. */
export const MAX_BUNDLE_ENTRIES = 500;
export const DEFAULT_CHUNK_ENTRIES = 100;
/** Request body ceiling per batch (no documented payload limit; one holdout Provenance is 450 KB). */
export const MAX_CHUNK_BYTES = 4 * 1024 * 1024;
export const VALIDATION_HEADER = 'x-amzn-healthlake-fhir-validation-level';
export const VALIDATION_LEVEL = 'structure-only';
/** HealthLake's quota: medical-note text in a DocumentReference written by POST/PUT is capped at 10,000 characters. */
export const NOTE_CHAR_LIMIT = 10_000;

const isObj = (x: unknown): x is Record<string, LosslessValue> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** A batch Bundle of PUT Type/id entries with each resource's text embedded unchanged. */
export function putBatchBundle(lines: readonly string[]): { body: string; sent: SentEntry[] } {
  if (lines.length === 0 || lines.length > MAX_BUNDLE_ENTRIES) throw new Error(`a batch holds 1..${MAX_BUNDLE_ENTRIES} entries, got ${lines.length}`);
  const sent: SentEntry[] = [];
  const entries = lines.map(line => {
    const r = parseLossless(line);
    if (!isObj(r) || typeof r.resourceType !== 'string' || typeof r.id !== 'string') throw new Error('resource without resourceType or id');
    if (!/^[A-Z][A-Za-z]{1,63}$/.test(r.resourceType)) throw new Error(`bad resourceType ${r.resourceType}`);
    if (!HEALTHLAKE_ID_RE.test(r.id)) throw new Error(`${r.resourceType}/${r.id}: id outside HealthLake's id pattern`);
    sent.push({ type: r.resourceType, id: r.id });
    return `{"resource":${line.trim()},"request":{"method":"PUT","url":${JSON.stringify(`${r.resourceType}/${r.id}`)}}}`;
  });
  return { body: `{"resourceType":"Bundle","type":"batch","entry":[${entries.join(',')}]}`, sent };
}

/** DocumentReference attachments whose data is longer than HealthLake's note limit (reported before loading). */
export function overNoteLimit(line: string): number {
  const r = parseLossless(line);
  if (!isObj(r) || r.resourceType !== 'DocumentReference' || !Array.isArray(r.content)) return 0;
  let n = 0;
  for (const c of r.content) {
    const a = isObj(c) && isObj(c.attachment) ? c.attachment : null;
    if (a && typeof a.data === 'string' && a.data.length > NOTE_CHAR_LIMIT) n++;
  }
  return n;
}

/** Statuses worth retrying for a whole batch: throttling and server errors. */
export const retryable = (status: number) => status === 429 || status >= 500;

/** Bundle.total of a search response (numbers stay lexemes), or null. */
export function bundleTotalOf(text: string): number | null {
  try {
    const b = parseLossless(text);
    if (!isObj(b) || b.resourceType !== 'Bundle' || b.total === undefined || b.total === null) return null;
    const n = Number(String(b.total));
    return Number.isInteger(n) && n >= 0 ? n : null;
  } catch { return null; }
}
