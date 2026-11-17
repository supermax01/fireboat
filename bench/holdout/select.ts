// Synthea test holdout selection. Pure functions; the CLI is holdout/cli.ts.
// The holdout is drawn from the Coherent Data Set listing (all-files.txt): every patient bundle not in the development
// subset (awk 'NR % 13 == 1' all-files.txt) is ranked by the canonical hash rule with purpose "synthea-holdout", and the
// first 99 that convert are taken. A bundle that fails its check is replaced by the next in hash order.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { rankHash, sha256Hex } from '../lib/hash.js';
import { isObj, typeAndId, refKind, visitReferences, type Obj } from '../data/fhir.js';
import { readBundle } from '../data/convert-lib.js';
import { newRewriteStats, rewriteSyntheaReferences } from '../data/synthea.js';
import type { InputFile } from '../data/checksums.js';

/** Source of the Synthea Coherent Data Set: the public bucket, unzipped FHIR prefix. */
export const COHERENT_S3 = {
  bucket: 'synthea-open-data',
  prefix: 'coherent/unzipped/fhir/',
  origin: 'https://synthea-open-data.s3.amazonaws.com',
} as const;
/** sha256 of all-files.txt, the bucket listing the development subset and the holdout are drawn from. */
export const ALL_FILES_SHA256 = 'bbcc90e706443298dcbad53f9e5dd62076930c077b0a9f5ac04113997cb526f2';
export const SHARED_FILES = ['organizations.json', 'practitioners.json'] as const;
export const HOLDOUT_SIZE = 99;
export const DEV_STRIDE = 13; // awk 'NR % 13 == 1'
export const DEFAULT_RESERVES = 20;
/**
 * template_id of the canonical hash for the holdout draw. The draw has a purpose ("synthea-holdout") but no template:
 * a file name is not a template candidate, so the template field is empty.
 */
export const HOLDOUT_TEMPLATE_ID = '';
/** Deterministic stand-in for a published seed in dry runs (seed kind "test"); never used for a real draw. */
export const TEST_SEED_HEX = sha256Hex('fbbench/holdout-dry-run-test-seed/1');

export type SeedKind = 'drand' | 'nist' | 'test';
export interface Seed { kind: SeedKind; hex: string; round: string | null; chain_hash: string | null }

export function parseSeed(o: { hex?: string; kind?: string; round?: string; chainHash?: string; test?: boolean }): Seed {
  if (o.test) {
    if (o.hex || (o.kind && o.kind !== 'test')) throw new Error('--test-seed cannot be combined with --seed or a non-test --seed-kind');
    return { kind: 'test', hex: TEST_SEED_HEX, round: null, chain_hash: null };
  }
  const kind = o.kind as SeedKind | undefined;
  if (kind !== 'drand' && kind !== 'nist' && kind !== 'test') throw new Error('--seed-kind must be drand, nist or test');
  const hex = (o.hex ?? '').trim().toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error('--seed must be 64 hex digits (a drand round randomness or a NIST pulse value hashed to 256 bits)');
  if (kind === 'drand' && !(o.round && /^[1-9][0-9]*$/.test(o.round) && o.chainHash && /^[0-9a-f]{64}$/.test(o.chainHash))) {
    throw new Error('a drand seed needs --round <R> and --chain-hash <64 hex>');
  }
  return { kind, hex, round: o.round ?? null, chain_hash: o.chainHash ?? null };
}

export const seedLabel = (s: Seed) => `${s.kind}-${s.hex.slice(0, 12)}`;

export interface Listing { lines: string[]; bundles: string[]; shared: string[] }

/** all-files.txt: one object name per line (NFC); patient bundles, then the two shared reference files. */
export function parseListing(text: string): Listing {
  const lines = text.split('\n').map(l => l.trim().normalize('NFC')).filter(l => l.length > 0);
  const shared = lines.filter(l => (SHARED_FILES as readonly string[]).includes(l));
  const bundles = lines.filter(l => l.endsWith('.json') && !(SHARED_FILES as readonly string[]).includes(l));
  if (new Set(lines).size !== lines.length) throw new Error('listing has duplicate names');
  if (lines.some(l => !l.endsWith('.json') || l.includes('/'))) throw new Error('listing lines must be bare .json names');
  return { lines, bundles, shared };
}

/** The development subset: awk 'NR % 13 == 1' over every listing line. */
export const devSubset = (l: Listing): string[] => l.lines.filter((_, i) => (i + 1) % DEV_STRIDE === 1);

/** Patient bundles not in the development subset. Throws if the subset includes a shared file. */
export function holdoutCandidates(l: Listing): string[] {
  const dev = new Set(devSubset(l));
  for (const s of SHARED_FILES) if (dev.has(s)) throw new Error(`development subset contains ${s}`);
  return l.bundles.filter(n => !dev.has(n));
}

export interface Ranked { rank: number; name: string; hash: string }

/** Candidates ascending by sha256(JCS(["fbbench/1.1","synthea-holdout",seed,"",name])). */
export function rankCandidates(seedHex: string, names: readonly string[]): Ranked[] {
  return names.map(name => ({ name, hash: rankHash('synthea-holdout', seedHex, HOLDOUT_TEMPLATE_ID, name) }))
    .sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : a.name < b.name ? -1 : 1))
    .map((r, i) => ({ rank: i + 1, ...r }));
}

export type CheckResult = { ok: true; patient_id: string; resources: number } | { ok: false; reason: string } | { missing: true };

export interface Selection {
  selected: (Ranked & { patient_id: string; resources: number })[];
  replaced: (Ranked & { reason: string })[];
  /** First ranked bundle that is needed but not on disk (download it, then run again); null when the selection is full. */
  missing: Ranked | null;
}

/** Walks the ranked list, taking bundles whose check passes, until n are taken (a bundle that fails is replaced by the next in hash order). */
export async function selectHoldout(ranked: readonly Ranked[], n: number, check: (name: string) => Promise<CheckResult>): Promise<Selection> {
  const out: Selection = { selected: [], replaced: [], missing: null };
  for (const r of ranked) {
    if (out.selected.length >= n) break;
    const c = await check(r.name);
    if ('missing' in c) { out.missing = r; break; }
    if (c.ok) out.selected.push({ ...r, patient_id: c.patient_id, resources: c.resources });
    else out.replaced.push({ ...r, reason: c.reason });
  }
  if (!out.missing && out.selected.length < n) throw new Error(`only ${out.selected.length} of ${n} bundles passed their check`);
  return out;
}

/** Public object URL (path segments encoded). */
export const objectKey = (name: string) => `${COHERENT_S3.prefix}${name}`;
/** Download URL for an S3 key exactly as listed (S3 keys are byte strings: an NFD key must not be sent as NFC). */
export const keyUrl = (rawKey: string) => `${COHERENT_S3.origin}/${rawKey.split('/').map(encodeURIComponent).join('/')}`;
export const objectUrl = (name: string) => `${COHERENT_S3.origin}/${objectKey(name).split('/').map(encodeURIComponent).join('/')}`;
export const listUrl = (continuationToken: string | null) =>
  `${COHERENT_S3.origin}/?list-type=2&prefix=${encodeURIComponent(COHERENT_S3.prefix)}${continuationToken ? `&continuation-token=${encodeURIComponent(continuationToken)}` : ''}`;

export const EXPECTED_SOURCE = 'The bucket publishes no sha256. At download the S3 listing (ListObjectsV2) is re-taken and each object\'s ETag and size are recorded; size is checked, and the MD5 when the ETag is a plain MD5 (no "-": not a multipart upload). The sha256 of each downloaded file is then recorded in SHA256SUMS.txt and published with the holdout manifest.';

export interface PlanEntry { rank: number; name: string; hash: string; s3_key: string; url: string; expected: { sha256: null; etag: string | null; size: number | null } }

export function fetchPlan(ranked: readonly Ranked[], n: number, reserves: number): { primary: PlanEntry[]; reserve: PlanEntry[] } {
  const entry = (r: Ranked): PlanEntry => ({ rank: r.rank, name: r.name, hash: r.hash, s3_key: objectKey(r.name), url: objectUrl(r.name), expected: { sha256: null, etag: null, size: null } });
  return { primary: ranked.slice(0, n).map(entry), reserve: ranked.slice(n, n + reserves).map(entry) };
}

/** key is NFC (matched against all-files.txt names); raw_key is the key exactly as S3 stores it, used to build download URLs. */
export interface S3Object { key: string; raw_key: string; etag: string; size: number; last_modified: string }

const xmlText = (s: string) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const tag = (block: string, name: string): string | null => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(block);
  return m ? xmlText(m[1]!) : null;
};

/** One ListObjectsV2 result page. */
export function parseS3List(xml: string): { objects: S3Object[]; truncated: boolean; next: string | null } {
  if (!/<ListBucketResult[\s>]/.test(xml)) throw new Error('not a ListBucketResult');
  const objects: S3Object[] = [];
  for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const b = m[1]!;
    const key = tag(b, 'Key');
    const etag = tag(b, 'ETag');
    const size = tag(b, 'Size');
    if (key === null || etag === null || size === null || !/^[0-9]+$/.test(size)) throw new Error('malformed Contents entry');
    objects.push({ key: key.normalize('NFC'), raw_key: key, etag, size: Number(size), last_modified: tag(b, 'LastModified') ?? '' });
  }
  return { objects, truncated: tag(xml, 'IsTruncated') === 'true', next: tag(xml, 'NextContinuationToken') };
}

/** Plain MD5 of a single-part upload, or null for a multipart ETag ("<md5>-<parts>"). */
export function md5FromEtag(etag: string): string | null {
  const e = etag.replace(/^"|"$/g, '').toLowerCase();
  return /^[0-9a-f]{32}$/.test(e) ? e : null;
}

/** Size, then MD5 when the ETag allows it. Returns the sha256 of the bytes. */
export function verifyDownload(bytes: Buffer, obj: S3Object): { sha256: string; md5_checked: boolean } {
  if (bytes.length !== obj.size) throw new Error(`${obj.key}: ${bytes.length} bytes, listing says ${obj.size}`);
  const md5 = md5FromEtag(obj.etag);
  if (md5 !== null) {
    const got = createHash('md5').update(bytes).digest('hex');
    if (got !== md5) throw new Error(`${obj.key}: md5 ${got}, ETag ${obj.etag}`);
  }
  return { sha256: createHash('sha256').update(bytes).digest('hex'), md5_checked: md5 !== null };
}

/**
 * The per-bundle part of the frozen converter's checks (data/convert-lib.ts), run before selection so a failing bundle
 * can be replaced: a Bundle of entries with resources and fullUrls, fullUrl = urn:uuid:<id>, unique Type/id, exactly
 * one Patient, every urn:uuid reference resolving inside the bundle, every conditional reference in a supported form,
 * and every literal reference resolving inside the bundle. Cross-bundle checks (duplicates, dangling references) run in
 * the conversion itself.
 */
export async function checkBundle(file: InputFile): Promise<CheckResult> {
  try {
    const entries = await readBundle(file);
    const fullUrlType = new Map<string, string>();
    const keys = new Set<string>();
    const byIdentifier = new Map<string, string>();
    for (const e of entries) {
      const r = e.resource as Obj;
      const { type, id } = typeAndId(r, file.name);
      if (e.fullUrl !== `urn:uuid:${id}`) return { ok: false, reason: `fullUrl ${String(e.fullUrl)} does not match ${type}/${id}` };
      if (keys.has(`${type}/${id}`)) return { ok: false, reason: `duplicate ${type}/${id}` };
      keys.add(`${type}/${id}`);
      fullUrlType.set(e.fullUrl, type);
      if (Array.isArray(r.identifier)) {
        for (const ident of r.identifier) {
          if (isObj(ident) && typeof ident.system === 'string' && typeof ident.value === 'string') byIdentifier.set(`${type}|${ident.system}|${ident.value}`, id);
        }
      }
    }
    const patients = entries.filter(e => (e.resource as Obj).resourceType === 'Patient');
    if (patients.length !== 1) return { ok: false, reason: `${patients.length} Patient resources` };
    const stats = newRewriteStats();
    for (const [i, e] of entries.entries()) {
      const copy = structuredClone(e.resource) as Obj;
      rewriteSyntheaReferences(copy, { fullUrlType, byIdentifier, where: `${file.name}#${i}`, stats });
      let dangling: string | null = null;
      visitReferences(copy, ref => {
        const v = ref.reference as string;
        if (refKind(v) === 'literal' && !keys.has(v) && dangling === null) dangling = v;
      });
      if (dangling !== null) return { ok: false, reason: `reference ${dangling} does not resolve inside the bundle` };
    }
    return { ok: true, patient_id: (patients[0]!.resource as Obj).id as string, resources: entries.length };
  } catch (e) {
    return { ok: false, reason: (e as Error).message.slice(0, 300) };
  }
}

export async function readListing(path: string): Promise<{ listing: Listing; sha256: string }> {
  const text = await readFile(path);
  return { listing: parseListing(text.toString('utf8')), sha256: sha256Hex(text) };
}
