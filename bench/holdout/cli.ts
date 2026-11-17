// bench:holdout -- <command> [flags]  
//   plan     --seed <hex> --seed-kind drand|nist|test [--round R --chain-hash H] | --test-seed   [--reserves 20]
//            Ranks the Coherent listing's non-development bundles and writes holdout/<label>/selection.json and
//            fetch-plan.json (the exact objects to fetch, primary 99 then reserves, with their source paths).
//   fetch    --label L [--download] [--reserves k]
//            Prints the URL list. Refuses to fetch anything without --download, and refuses a test seed. With --download:
//            re-takes the S3 listing (ETag, size), downloads the primary bundles (and the first k reserves), checks size
//            and MD5 where the ETag allows, writes SHA256SUMS.txt and fetch-manifest.json under HOLDOUT_DATA_ROOT/<label>.
//   convert  --label L
//            Checks the downloaded files against fetch-manifest.json, walks the ranked list (a bundle that fails its check
//            is replaced by the next in hash order), converts the 99 with the frozen converter to converted/synthea-holdout/,
//            writes manifests/convert-synthea-holdout.json and holdout/<label>/holdout-manifest.json, and records the
//            known Patient in .local/bench-config.json.
//   load     --label L --switch-stack
//            bench:infra:up -- --dataset synthea-holdout --force (stops whatever the shared stack serves), then bench:load
//            until it finishes, then checks the per-type counts in manifests/load-synthea-holdout.json.
//   dry-run  [--seed ... | --test-seed (default)] [--count 99] [--keep]
//            plan with the seed, then selection and conversion of bundles already on disk (the 99 development bundles,
//            ranked with the same rule) to a scratch directory, with counts. Downloads nothing, loads nothing.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { sha256Hex } from '../lib/hash.js';
import { CODE_BENCH, HOLDOUT_DATA_ROOT, LOCAL_CONFIG, SYNTHEA_ALL_FILES, SYNTHEA_FHIR_DIR, SYNTHEA_SELECTED_FILES, results } from '../lib/paths.js';
import { gitInfo, log, readManifest, sha256File, writeJsonAtomic, writeManifest } from '../infra/manifest.js';
import { verifyInputs, type InputFile } from '../data/checksums.js';
import { convertDataset } from '../data/convert-lib.js';
import {
  ALL_FILES_SHA256, checkBundle, DEFAULT_RESERVES, devSubset, EXPECTED_SOURCE, fetchPlan, holdoutCandidates, HOLDOUT_SIZE,
  HOLDOUT_TEMPLATE_ID, keyUrl, listUrl, parseS3List, parseSeed, rankCandidates, readListing, seedLabel, selectHoldout, verifyDownload,
  type PlanEntry, type Ranked, type S3Object, type Seed, type Selection,
} from './select.js';

export const LISTING_PATH = SYNTHEA_ALL_FILES;
const OPTIONS = {
  seed: { type: 'string' }, 'seed-kind': { type: 'string' }, round: { type: 'string' }, 'chain-hash': { type: 'string' },
  'test-seed': { type: 'boolean' }, label: { type: 'string' }, reserves: { type: 'string' }, download: { type: 'boolean' },
  count: { type: 'string' }, keep: { type: 'boolean' }, 'switch-stack': { type: 'boolean' }, listing: { type: 'string' },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true; strict: true }>>['values'];

const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const say = (s: string) => process.stdout.write(s + '\n');
const dataDir = (label: string) => join(HOLDOUT_DATA_ROOT, label);

interface SelectionFile {
  schema: 'fbbench.holdout-selection/1';
  seed: Seed;
  purpose: 'synthea-holdout';
  template_id: string;
  listing: { path: string; sha256: string; lines: number; bundles: number };
  development_subset: { rule: string; count: number; sha256_of_names: string };
  candidates: number;
  size: number;
  ranked: Ranked[]; // every candidate, in hash order
}

/** plan: rank and write selection.json and fetch-plan.json. Returns the label. */
export async function plan(v: Values): Promise<{ label: string; selection: SelectionFile; plan: ReturnType<typeof fetchPlan> }> {
  const seed = parseSeed({ hex: v.seed, kind: v['seed-kind'], round: v.round, chainHash: v['chain-hash'], test: v['test-seed'] });
  const listingPath = v.listing ?? LISTING_PATH;
  const { listing, sha256 } = await readListing(listingPath);
  if (!v.listing && sha256 !== ALL_FILES_SHA256) throw new Error(`${listingPath}: sha256 ${sha256}, expected ${ALL_FILES_SHA256}`);
  const dev = devSubset(listing);
  const candidates = holdoutCandidates(listing);
  if (!v.listing && (listing.bundles.length !== 1278 || dev.length !== 99 || candidates.length !== 1179)) {
    throw new Error(`listing: ${listing.bundles.length} bundles, ${dev.length} development, ${candidates.length} candidates; expected 1278, 99, 1179`);
  }
  if (!v.listing) {
    const selected = readFileSync(SYNTHEA_SELECTED_FILES, 'utf8').split('\n').map(l => l.trim().normalize('NFC')).filter(Boolean);
    if (selected.join('\n') !== dev.join('\n')) throw new Error('the development subset rule does not reproduce selected-files.txt');
  }
  const ranked = rankCandidates(seed.hex, candidates);
  const reserves = Number(v.reserves ?? DEFAULT_RESERVES);
  if (!Number.isInteger(reserves) || reserves < 0 || reserves > 500) throw new Error('--reserves must be 0..500');
  const label = seedLabel(seed);
  const selection: SelectionFile = {
    schema: 'fbbench.holdout-selection/1', seed, purpose: 'synthea-holdout', template_id: HOLDOUT_TEMPLATE_ID,
    listing: { path: listingPath, sha256, lines: listing.lines.length, bundles: listing.bundles.length },
    development_subset: { rule: "awk 'NR % 13 == 1' all-files.txt", count: dev.length, sha256_of_names: sha256Hex(dev.join('\n') + '\n') },
    candidates: candidates.length, size: HOLDOUT_SIZE, ranked,
  };
  const p = fetchPlan(ranked, HOLDOUT_SIZE, reserves);
  const dir = results.holdout(label);
  await writeJsonAtomic(join(dir, 'selection.json'), { ...selection, ...(await gitInfo()), written_at: new Date().toISOString() });
  await writeJsonAtomic(join(dir, 'fetch-plan.json'), {
    schema: 'fbbench.holdout-fetch-plan/1', seed, label, expected_source: EXPECTED_SOURCE,
    bucket: 's3://synthea-open-data/coherent/unzipped/fhir/', primary: p.primary, reserve: p.reserve,
  });
  say(`holdout ${label}: ${candidates.length} candidates (${listing.bundles.length} bundles minus ${dev.length} development), first ${HOLDOUT_SIZE} plus ${p.reserve.length} reserves planned`);
  say(`  ${join(dir, 'selection.json')}`);
  say(`  ${join(dir, 'fetch-plan.json')}`);
  return { label, selection, plan: p };
}

async function readPlan(label: string): Promise<{ seed: Seed; primary: PlanEntry[]; reserve: PlanEntry[] }> {
  const p = join(results.holdout(label), 'fetch-plan.json');
  if (!existsSync(p)) throw new Error(`no fetch plan for ${label}: run bench:holdout -- plan first`);
  return JSON.parse(await readFile(p, 'utf8')) as { seed: Seed; primary: PlanEntry[]; reserve: PlanEntry[] }; // our own file
}

/** fetch: prints the URL list; downloads only with --download, never for a test seed. Returns the exit code. */
export async function fetchCommand(v: Values): Promise<number> {
  if (!v.label) throw new Error('--label is required (printed by plan)');
  const p = await readPlan(v.label);
  const k = Number(v.reserves ?? '0');
  if (!Number.isInteger(k) || k < 0 || k > p.reserve.length) throw new Error(`--reserves must be 0..${p.reserve.length}`);
  const want = [...p.primary, ...p.reserve.slice(0, k)];
  say(`objects to fetch (${want.length}; ${p.primary.length} primary, ${k} reserves):`);
  for (const e of want) say(`  ${e.url}`);
  if (!v.download) {
    process.stderr.write('refusing to download: pass --download to fetch the objects listed above (only after the seed is published)\n');
    return 2;
  }
  if (p.seed.kind === 'test') {
    process.stderr.write('refusing to download for a test seed: the holdout is drawn only from the published seed\n');
    return 2;
  }
  const dir = dataDir(v.label);
  await mkdir(join(dir, 'fhir'), { recursive: true });
  const listing = await takeListing();
  const byKey = new Map(listing.map(o => [o.key, o]));
  const sums: string[] = [];
  const files: { name: string; s3_key: string; etag: string; size: number; md5_checked: boolean; sha256: string }[] = [];
  for (const e of want) {
    const obj = byKey.get(e.s3_key);
    if (!obj) throw new Error(`${e.s3_key} is not in the S3 listing`);
    const target = join(dir, 'fhir', e.name);
    let bytes: Buffer;
    if (existsSync(target)) bytes = await readFile(target);
    else {
      // The plan's URL is built from the NFC name; S3 may store the key in another normal form, so fetch by the listed key.
      const url = keyUrl(obj.raw_key);
      const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(300_000) });
      if (res.status !== 200) throw new Error(`GET ${url}: HTTP ${res.status}`);
      bytes = Buffer.from(await res.arrayBuffer());
    }
    const check = verifyDownload(bytes, obj);
    if (!existsSync(target)) { await writeFile(`${target}.part`, bytes); await rename(`${target}.part`, target); }
    sums.push(`${check.sha256}  ${e.name}`);
    files.push({ name: e.name, s3_key: e.s3_key, etag: obj.etag, size: obj.size, md5_checked: check.md5_checked, sha256: check.sha256 });
    log(`  ${e.name}: ${obj.size} bytes, md5 ${check.md5_checked ? 'checked' : 'not available (multipart ETag)'}`);
  }
  const sumsText = sums.sort((a, b) => byName(a.slice(66), b.slice(66))).join('\n') + '\n';
  await writeFile(join(dir, 'SHA256SUMS.txt'), sumsText);
  await writeJsonAtomic(join(dir, 'fetch-manifest.json'), {
    schema: 'fbbench.holdout-fetch/1', label: v.label, seed: p.seed, listing_taken_at: new Date().toISOString(),
    listing_objects: listing.length, listing, files, sha256sums_sha256: sha256Hex(sumsText), ...(await gitInfo()),
  });
  say(`downloaded and checked ${files.length} bundles into ${join(dir, 'fhir')}`);
  return 0;
}

async function takeListing(): Promise<S3Object[]> {
  const out: S3Object[] = [];
  let token: string | null = null;
  for (let page = 0; page < 100; page++) {
    const res = await fetch(listUrl(token), { redirect: 'error', signal: AbortSignal.timeout(120_000) });
    if (res.status !== 200) throw new Error(`S3 listing: HTTP ${res.status}`);
    const r = parseS3List(await res.text());
    out.push(...r.objects);
    if (!r.truncated) return out;
    token = r.next;
    if (!token) throw new Error('S3 listing truncated without a continuation token');
  }
  throw new Error('S3 listing: too many pages');
}

/** Ranked bundles checked one by one; files come from `pool` (name -> InputFile). */
async function selectFrom(ranked: Ranked[], n: number, pool: Map<string, InputFile>): Promise<Selection> {
  return selectHoldout(ranked, n, async name => {
    const f = pool.get(name);
    return f ? checkBundle(f) : { missing: true };
  });
}

/** Converts the selection (inputs in name order, as bench:convert does) and returns the manifest body. */
async function convertSelection(sel: Selection, pool: Map<string, InputFile>, outDir: string) {
  const files = sel.selected.map(s => pool.get(s.name)!).sort((a, b) => byName(a.name, b.name));
  const body = await convertDataset({ dataset: 'synthea-holdout', files, outDir, verbose: false });
  return { files, body };
}

/** convert: the real holdout, from the downloaded files. */
export async function convertCommand(v: Values): Promise<number> {
  if (!v.label) throw new Error('--label is required');
  const sel = JSON.parse(await readFile(join(results.holdout(v.label), 'selection.json'), 'utf8')) as SelectionFile; // our own file
  if (sel.seed.kind === 'test') throw new Error('a test seed is for dry runs only; use bench:holdout -- dry-run');
  const dir = dataDir(v.label);
  const fm = JSON.parse(await readFile(join(dir, 'fetch-manifest.json'), 'utf8')) as { files: { name: string; sha256: string }[]; sha256sums_sha256: string };
  const sumsSha = await sha256File(join(dir, 'SHA256SUMS.txt'));
  if (sumsSha !== fm.sha256sums_sha256) throw new Error(`SHA256SUMS.txt changed since download (${sumsSha})`);
  const pool = new Map<string, InputFile>();
  for (const f of fm.files) {
    const path = join(dir, 'fhir', f.name);
    const got = await sha256File(path);
    if (got !== f.sha256) throw new Error(`${path}: sha256 ${got}, recorded ${f.sha256}`);
    pool.set(f.name, { name: f.name, path, sha256: got });
  }
  const selection = await selectFrom(sel.ranked, sel.size, pool);
  if (selection.missing) {
    process.stderr.write(`bundle rank ${selection.missing.rank} (${selection.missing.name}) is needed but not downloaded (${selection.replaced.length} replaced so far): run fetch --download --reserves <k>\n`);
    return 3;
  }
  const outDir = results.converted('synthea-holdout');
  const { files, body } = await convertSelection(selection, pool, outDir);
  const { dataset: _d, ...rest } = body;
  const inputs = { dataset: 'synthea-holdout', sums_file: join(dir, 'SHA256SUMS.txt'), sums_file_sha256: sumsSha, files, verified_at: new Date().toISOString() };
  await writeManifest('convert-synthea-holdout', { dataset: 'synthea-holdout', inputs, seed: sel.seed, ...rest });
  await writeJsonAtomic(join(results.holdout(v.label), 'holdout-manifest.json'), holdoutManifest(sel, selection, files, body));
  const known = selection.selected.slice().sort((a, b) => byName(a.name, b.name))[0]!.patient_id;
  await recordKnownPatient(known);
  say(`synthea-holdout: ${selection.selected.length} bundles (${selection.replaced.length} replaced), ${String(body.total)} resources -> ${outDir}`);
  return 0;
}

function holdoutManifest(sel: SelectionFile, s: Selection, files: InputFile[], body: Record<string, unknown>) {
  return {
    schema: 'fbbench.holdout-manifest/1', seed: sel.seed, purpose: sel.purpose, template_id: sel.template_id, listing: sel.listing,
    development_subset: sel.development_subset, candidates: sel.candidates, size: sel.size,
    selected: s.selected.map(x => ({ rank: x.rank, name: x.name, hash: x.hash, resources: x.resources })),
    replaced: s.replaced, files: files.map(f => ({ name: f.name, sha256: f.sha256 })),
    converted: { total: body.total, types: body.types, patients: body.patients, references: body.references },
  };
}

/** Adds known_patient["synthea-holdout"] to the git-ignored local config; refuses to change an existing value. */
async function recordKnownPatient(id: string): Promise<void> {
  const c = JSON.parse(await readFile(LOCAL_CONFIG, 'utf8')) as { known_patient: Record<string, string> };
  const have = c.known_patient['synthea-holdout'];
  if (have === id) return;
  if (have) throw new Error(`${LOCAL_CONFIG} already names known_patient.synthea-holdout = ${have}; remove it to switch holdouts`);
  c.known_patient['synthea-holdout'] = id;
  await writeJsonAtomic(LOCAL_CONFIG, c);
}

/** load: switches the shared stack to the holdout volume, loads, and checks the per-type counts. */
export async function loadCommand(v: Values): Promise<number> {
  if (!v['switch-stack']) {
    process.stderr.write('refusing to load: this stops whatever dataset the shared HAPI stack serves and starts fbbench-pg-synthea-holdout; pass --switch-stack\n');
    return 2;
  }
  const tsx = (script: string, args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', join(CODE_BENCH, script), ...args], { stdio: 'inherit', cwd: CODE_BENCH });
  if (tsx('infra/up.ts', ['--dataset', 'synthea-holdout', '--force']).status !== 0) return 1;
  for (let round = 0; round < 50; round++) {
    const r = tsx('data/load.ts', ['--dataset', 'synthea-holdout', '--scope', 'full']);
    if (r.status === 0) break;
    if (r.status !== 3) return 1;
  }
  const m = await readManifest('load-synthea-holdout');
  const counts = (m?.counts ?? {}) as { expected_total?: unknown; served_total?: unknown };
  const ok = m?.passed === true && String(counts.expected_total) === String(counts.served_total);
  say(`synthea-holdout load: ${ok ? 'passed' : 'FAILED'}, expected ${String(counts.expected_total)}, served ${String(counts.served_total)}`);
  return ok ? 0 : 1;
}

/** dry-run: plan with the (test) seed, then select and convert bundles already on disk into a scratch directory. */
export async function dryRun(v: Values): Promise<{ code: number; summary: Record<string, unknown> }> {
  const seedGiven = v.seed !== undefined || v['seed-kind'] !== undefined;
  const { label, selection, plan: p } = await plan({ ...v, 'test-seed': v['test-seed'] ?? !seedGiven });
  say(`fetch plan (not fetched): ${p.primary.length} primary objects, e.g. ${p.primary[0]?.url ?? '-'}`);
  const count = Number(v.count ?? String(HOLDOUT_SIZE));
  // Checked before the bundles on disk are read, so a bad --count fails the same way with or without the data.
  if (!Number.isInteger(count) || count < 1) throw new Error('--count must be a positive integer');
  const onDisk = await verifyInputs('synthea-dev');
  const pool = new Map(onDisk.files.map(f => [f.name, f]));
  const plannedOnDisk = p.primary.filter(e => pool.has(e.name)).length;
  if (count > pool.size) throw new Error(`--count must be 1..${pool.size}`);
  // The on-disk bundles stand in for downloaded ones: ranked by the same rule with the same seed.
  const ranked = rankCandidates(selection.seed.hex, [...pool.keys()]);
  const sel = await selectFrom(ranked, count, pool);
  const outDir = join(results.holdout(label), 'dry-run', 'converted');
  const t0 = Date.now();
  const { files, body } = await convertSelection(sel, pool, outDir);
  const types = body.types as Record<string, { count: number; sha256: string }>;
  let reference: Record<string, unknown> | null = null;
  const devManifest = join(results.converted('synthea-dev'), 'manifest.json');
  if (count === pool.size && existsSync(devManifest)) {
    // Same bundles, same converter: the output must equal converted/synthea-dev byte for byte, type by type.
    const dev = JSON.parse(await readFile(devManifest, 'utf8')) as { total: number; types: Record<string, { count: number; sha256: string }> };
    const differ = [...new Set([...Object.keys(dev.types), ...Object.keys(types)])].filter(t => dev.types[t]?.sha256 !== types[t]?.sha256);
    reference = { compared_with: devManifest, total_equal: dev.total === body.total, types_differing: differ };
  }
  const summary = {
    schema: 'fbbench.holdout-dry-run/1', label, seed: selection.seed, written_at: new Date().toISOString(),
    plan: { candidates: selection.candidates, primary: p.primary.length, reserve: p.reserve.length, primary_already_on_disk: plannedOnDisk },
    pool: { source: SYNTHEA_FHIR_DIR, files: pool.size, note: 'development bundles stand in for the holdout; the real holdout excludes them' },
    selection: { requested: count, selected: sel.selected.length, replaced: sel.replaced, first_ranks: sel.selected.slice(0, 3).map(s => s.rank) },
    converted: { out_dir: outDir, kept: v.keep === true, total: body.total, patients: body.patients, types: Object.fromEntries(Object.entries(types).map(([t, x]) => [t, x.count])), references: body.references, wall_ms: Date.now() - t0 },
    reproduces_synthea_dev: reference, inputs: files.length, ...(await gitInfo()),
  };
  await writeJsonAtomic(join(results.holdout(label), 'dry-run', 'summary.json'), summary);
  if (!v.keep) await rm(outDir, { recursive: true, force: true });
  say(`dry run ${label}: selected ${sel.selected.length} of ${pool.size} on-disk bundles (${sel.replaced.length} replaced), ${String(body.total)} resources in ${Object.keys(types).length} types, ${String(body.patients)} patients`);
  for (const [t, x] of Object.entries(types)) say(`  ${t}: ${x.count}`);
  if (reference) say(`  reproduces converted/synthea-dev: total ${reference.total_equal ? 'equal' : 'DIFFERENT'}, ${(reference.types_differing as string[]).length} types differ`);
  say(`  ${join(results.holdout(label), 'dry-run', 'summary.json')}`);
  const bad = reference !== null && (!reference.total_equal || (reference.types_differing as string[]).length > 0);
  return { code: bad ? 1 : 0, summary };
}

async function main() {
  const { values, positionals } = parseArgs({ options: OPTIONS, allowPositionals: true, strict: true });
  const cmd = positionals[0];
  let code = 0;
  if (cmd === 'plan') await plan(values);
  else if (cmd === 'fetch') code = await fetchCommand(values);
  else if (cmd === 'convert') code = await convertCommand(values);
  else if (cmd === 'load') code = await loadCommand(values);
  else if (cmd === 'dry-run') code = (await dryRun(values)).code;
  else { process.stderr.write('usage: bench:holdout -- plan|fetch|convert|load|dry-run [flags] (see holdout/cli.ts)\n'); code = 2; }
  process.exitCode = code;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
