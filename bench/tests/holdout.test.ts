// Synthea holdout selection: determinism, disjointness from the development subset, replacement, the
// fetch gate. Synthetic data only: made-up listings, and the shipped Synthea listings (bench/data/synthea-coherent-100/).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { sha256Hex } from '../lib/hash.js';
import { results, SYNTHEA_ALL_FILES, SYNTHEA_SELECTED_FILES, SYNTHEA_SHA256SUMS, tmpDir } from '../lib/paths.js';
import { SUMS_FILE_SHA256, SYNTHEA_SELECTED_FILES_SHA256 } from '../data/checksums.js';
import { sha256File } from '../infra/manifest.js';
import {
  ALL_FILES_SHA256, devSubset, fetchPlan, holdoutCandidates, HOLDOUT_SIZE, keyUrl, md5FromEtag, objectUrl, parseListing, parseS3List, parseSeed,
  rankCandidates, selectHoldout, TEST_SEED_HEX, verifyDownload, type CheckResult,
} from '../holdout/select.js';
import { dryRun, fetchCommand, loadCommand, plan } from '../holdout/cli.js';

/** A listing shaped like all-files.txt: 1,278 synthetic bundle names, then the two shared files. */
function syntheticListing(): string {
  const names = Array.from({ length: 1278 }, (_, i) => `Given${i}_Family${i % 97}_${sha256Hex(`synthetic-${i}`).slice(0, 8)}-0000-0000-0000-000000000000.json`).sort();
  return [...names, 'organizations.json', 'practitioners.json'].join('\n') + '\n';
}

const SEED_A = sha256Hex('unit-seed-a');
const SEED_B = sha256Hex('unit-seed-b');
const okCheck = async (): Promise<CheckResult> => ({ ok: true, patient_id: 'p', resources: 1 });

test('development subset is awk NR % 13 == 1; candidates exclude it and the shared files', () => {
  const l = parseListing(syntheticListing());
  const dev = devSubset(l);
  assert.equal(l.bundles.length, 1278);
  assert.equal(dev.length, 99);
  assert.deepEqual(dev.slice(0, 2), [l.lines[0], l.lines[13]]);
  const c = holdoutCandidates(l);
  assert.equal(c.length, 1179);
  const devSet = new Set(dev);
  assert.ok(c.every(n => !devSet.has(n) && !n.startsWith('organizations') && !n.startsWith('practitioners')));
});

test('same seed, same ranking and selection; another seed, another selection; never a development bundle', async () => {
  const l = parseListing(syntheticListing());
  const c = holdoutCandidates(l);
  const a1 = rankCandidates(SEED_A, c);
  const a2 = rankCandidates(SEED_A, [...c].reverse());
  assert.deepEqual(a1, a2, 'input order must not matter');
  const s1 = await selectHoldout(a1, HOLDOUT_SIZE, okCheck);
  const s2 = await selectHoldout(a2, HOLDOUT_SIZE, okCheck);
  assert.deepEqual(s1.selected.map(s => s.name), s2.selected.map(s => s.name));
  assert.equal(new Set(s1.selected.map(s => s.name)).size, HOLDOUT_SIZE);
  const b = await selectHoldout(rankCandidates(SEED_B, c), HOLDOUT_SIZE, okCheck);
  const overlap = b.selected.filter(s => s1.selected.some(x => x.name === s.name)).length;
  assert.ok(overlap < 30, `two seeds overlap in ${overlap} of 99`);
  const dev = new Set(devSubset(l));
  assert.ok(s1.selected.every(s => !dev.has(s.name)));
  // Ranks follow the canonical hash: ascending, and the hash is sha256(JCS([...])) with an empty template id.
  assert.ok(a1.every((r, i) => i === 0 || a1[i - 1]!.hash < r.hash));
  assert.equal(a1[0]!.hash, sha256Hex(JSON.stringify(['fbbench/1.1', 'synthea-holdout', SEED_A, '', a1[0]!.name])));
});

test('a bundle that fails its check is replaced by the next in hash order; a missing bundle stops the walk', async () => {
  const ranked = rankCandidates(SEED_A, holdoutCandidates(parseListing(syntheticListing())));
  const bad = ranked[1]!.name;
  const s = await selectHoldout(ranked, HOLDOUT_SIZE, async n => (n === bad ? { ok: false, reason: 'synthetic failure' } : { ok: true, patient_id: n, resources: 1 }));
  assert.deepEqual(s.replaced.map(r => r.rank), [2]);
  assert.equal(s.selected.length, HOLDOUT_SIZE);
  assert.equal(s.selected.at(-1)!.rank, HOLDOUT_SIZE + 1);
  const have = new Set(ranked.slice(0, HOLDOUT_SIZE).map(r => r.name));
  const m = await selectHoldout(ranked, HOLDOUT_SIZE, async n => (n === bad ? { ok: false, reason: 'x' } : have.has(n) ? okCheck() : { missing: true }));
  assert.equal(m.missing?.rank, HOLDOUT_SIZE + 1);
  const plan = fetchPlan(ranked, HOLDOUT_SIZE, 20);
  assert.equal(plan.primary.length, 99);
  assert.equal(plan.reserve[0]!.rank, 100);
  assert.equal(plan.primary[0]!.expected.sha256, null);
});

test('shipped Synthea listings: pinned digests; the rule reproduces selected-files.txt; the holdout is disjoint from it', async () => {
  const path = SYNTHEA_ALL_FILES;
  assert.ok(existsSync(path), `${path} missing`);
  assert.equal(await sha256File(path), ALL_FILES_SHA256);
  assert.equal(await sha256File(SYNTHEA_SELECTED_FILES), SYNTHEA_SELECTED_FILES_SHA256);
  assert.equal(await sha256File(SYNTHEA_SHA256SUMS), SUMS_FILE_SHA256['synthea-dev']);
  const l = parseListing(readFileSync(path, 'utf8'));
  const selected = readFileSync(SYNTHEA_SELECTED_FILES, 'utf8').split('\n').map(x => x.trim().normalize('NFC')).filter(Boolean);
  assert.deepEqual(devSubset(l), selected);
  const c = holdoutCandidates(l);
  assert.equal(c.length, 1179);
  const s = await selectHoldout(rankCandidates(TEST_SEED_HEX, c), HOLDOUT_SIZE, okCheck);
  const dev = new Set(selected);
  assert.equal(s.selected.filter(x => dev.has(x.name)).length, 0);
});

test('seeds: 64 hex, drand needs its round and chain hash, the test seed is fixed', () => {
  assert.throws(() => parseSeed({ hex: 'abc', kind: 'nist' }));
  assert.throws(() => parseSeed({ hex: SEED_A, kind: 'drand' }), /round/);
  assert.equal(parseSeed({ hex: SEED_A.toUpperCase(), kind: 'drand', round: '123', chainHash: SEED_B }).hex, SEED_A);
  assert.equal(parseSeed({ test: true }).hex, TEST_SEED_HEX);
  assert.notEqual(TEST_SEED_HEX, '0'.repeat(64));
  assert.throws(() => parseSeed({ test: true, hex: SEED_A }));
});

test('S3 listing, ETag and download checks', () => {
  const body = Buffer.from('{"resourceType":"Bundle"}');
  const md5 = createHash('md5').update(body).digest('hex');
  const xml = `<?xml version="1.0"?><ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>t&amp;1</NextContinuationToken>
<Contents><Key>coherent/unzipped/fhir/A_B.json</Key><LastModified>2022-01-01T00:00:00.000Z</LastModified><ETag>&quot;${md5}&quot;</ETag><Size>${body.length}</Size></Contents>
<Contents><Key>coherent/unzipped/fhir/C_D.json</Key><ETag>&quot;${md5}-3&quot;</ETag><Size>9</Size></Contents></ListBucketResult>`;
  const r = parseS3List(xml);
  assert.equal(r.truncated, true);
  assert.equal(r.next, 't&1');
  assert.equal(r.objects.length, 2);
  assert.equal(md5FromEtag(r.objects[0]!.etag), md5);
  assert.equal(md5FromEtag(r.objects[1]!.etag), null);
  assert.equal(verifyDownload(body, r.objects[0]!).md5_checked, true);
  assert.throws(() => verifyDownload(Buffer.from('x'), r.objects[0]!), /bytes/);
  assert.throws(() => verifyDownload(Buffer.alloc(body.length), r.objects[0]!), /md5/);
  assert.equal(objectUrl('Ä b.json'), 'https://synthea-open-data.s3.amazonaws.com/coherent/unzipped/fhir/%C3%84%20b.json');
});

test('holdout: an NFD key in the S3 listing keeps its raw form for the download URL', () => {
  const nfd = 'coherent/unzipped/fhir/Negro\u0301n_x.json';
  const xml = `<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>${nfd}</Key><ETag>"abc"</ETag><Size>3</Size></Contents></ListBucketResult>`;
  const o = parseS3List(xml).objects[0]!;
  assert.equal(o.key, nfd.normalize('NFC'));
  assert.equal(o.raw_key, nfd);
  assert.equal(keyUrl(o.raw_key), 'https://synthea-open-data.s3.amazonaws.com/coherent/unzipped/fhir/Negro%CC%81n_x.json');
});

test('fetch prints the plan and refuses without --download, and refuses any download for a test seed; load needs --switch-stack', async () => {
  await mkdir(tmpDir('bench-tests'), { recursive: true });
  const dir = await mkdtemp(join(tmpDir('bench-tests'), 'holdout-'));
  const listing = join(dir, 'all-files.txt');
  await writeFile(listing, syntheticListing());
  const seed = sha256Hex('holdout-unit-test-fetch-gate');
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  let label = '';
  try {
    process.stdout.write = (() => true) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    ({ label } = await plan({ seed, 'seed-kind': 'test', listing }));
    assert.equal(await fetchCommand({ label }), 2);
    assert.equal(await fetchCommand({ label, download: true }), 2);
    assert.equal(await loadCommand({}), 2);
    await assert.rejects(dryRun({ seed, 'seed-kind': 'test', listing, count: '0' }), /--count/);
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
    await rm(dir, { recursive: true, force: true });
    if (label) await rm(results.holdout(label), { recursive: true, force: true });
  }
});
