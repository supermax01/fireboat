// Export and post-load checks for bench:load: served counts, references, decimal text and server behaviour.
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseLossless, stringifyLossless, type LosslessValue } from '../lib/json.js';
import { HAPI_BASE, isSyntheaDataset, knownPatient, lexemeProbe as lexemeProbeConfig, mimicDevPatients, proxyBase, results, slotPorts, type LoadDatasetId as DatasetId } from '../lib/paths.js';
import { log, readManifest, sha256File, writeManifest } from '../infra/manifest.js';
import { startRecordingProxy, startTokenShim } from '../infra/proxy.js';
import { isObj, literalRefs, patientLink, typeAndId, type Obj } from './fhir.js';
import { canonical, countOf, entries, FHIR_JSON, get, getJson, mapLimit, nextLink, withoutServerMeta } from './hapi.js';
import { exportDir, readProgress, stateDir, type BatchDone, type ChunkDone, type Scope } from './state.js';

const PER_PATIENT_UNIT_THRESHOLD = 20_000; // types larger than this are exported per patient, so units stay short
const EXPORT_PAGE = 200;

type PatientCounts = Record<string, Record<string, Record<string, number>>>;
interface Converted { total: number; types: Record<string, { count: number; sha256: string }> }

async function loadConverted(d: DatasetId): Promise<{ manifest: Converted; patientCounts: PatientCounts }> {
  const dir = results.converted(d);
  // Our own summary files (small integers only).
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as Converted;
  const patientCounts = JSON.parse(await readFile(join(dir, 'patient-counts.json'), 'utf8')) as PatientCounts;
  return { manifest, patientCounts };
}

const patientInScope = (d: DatasetId, scope: Scope, p: string) => scope === 'full' || isSyntheaDataset(d) || mimicDevPatients().includes(p);

interface Unit { name: string; url: string }

async function exportUnits(d: DatasetId, scope: Scope): Promise<Unit[]> {
  const { manifest, patientCounts } = await loadConverted(d);
  const units: Unit[] = [];
  for (const type of Object.keys(manifest.types).sort()) {
    const fields = patientCounts[type] ?? {};
    const linked = Object.values(fields).reduce((n, byP) => n + Object.values(byP).reduce((a, b) => a + b, 0), 0);
    if (manifest.types[type]!.count > PER_PATIENT_UNIT_THRESHOLD && linked === manifest.types[type]!.count) {
      for (const field of Object.keys(fields).sort()) {
        for (const p of Object.keys(fields[field]!).sort()) {
          if (patientInScope(d, scope, p)) units.push({ name: `${type}.${field}.${p}`, url: `${HAPI_BASE}/${type}?${field}=Patient/${p}&_count=${EXPORT_PAGE}` });
        }
      }
    } else {
      units.push({ name: `${type}.all`, url: `${HAPI_BASE}/${type}?_count=${EXPORT_PAGE}` });
    }
  }
  return units;
}

/** Pages every resource out of HAPI, one NDJSON file per unit (compact, lexemes kept). Finished units are skipped. */
export async function runExport(o: { dataset: DatasetId; scope: Scope; deadline: number }): Promise<{ complete: boolean; batches: number; resources: number }> {
  const dir = join(exportDir(o.dataset), 'units');
  await mkdir(dir, { recursive: true });
  const units = (await exportUnits(o.dataset, o.scope)).filter(u => !existsSync(join(dir, `${u.name}.ndjson`)));
  let batches = 0;
  let resources = 0;
  let stopped = false;
  await mapLimit(units, 4, async u => {
    if (stopped || Date.now() > o.deadline) { stopped = true; return; }
    const lines: string[] = [];
    let url: string | null = u.url;
    while (url) {
      if (!url.startsWith(`${HAPI_BASE}?`) && !url.startsWith(`${HAPI_BASE}/`)) throw new Error(`${u.name}: unexpected next link ${url}`);
      const bundle = await getJson(url);
      for (const e of entries(bundle)) {
        const mode = isObj(e.search) ? e.search.mode : 'match';
        if (mode === 'match' && isObj(e.resource)) lines.push(stringifyLossless(e.resource));
      }
      url = nextLink(bundle);
    }
    const path = join(dir, `${u.name}.ndjson`);
    await writeFile(`${path}.tmp`, lines.map(l => l + '\n').join(''), 'utf8');
    await rename(`${path}.tmp`, path);
    batches++;
    resources += lines.length;
    if (batches % 25 === 0) log(`  export: ${batches}/${units.length} units this chunk`);
  });
  return { complete: !stopped, batches, resources };
}

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

async function* ndjson(path: string): AsyncGenerator<string> {
  for await (const line of createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity })) if (line) yield line;
}

export async function runChecks(o: { dataset: DatasetId; scope: Scope; concurrency: number }): Promise<boolean> {
  const d = o.dataset;
  const t0 = Date.now();
  const failures: string[] = [];
  const warnings: string[] = [];
  const { manifest, patientCounts } = await loadConverted(d);
  const convDir = results.converted(d);

  // Expected resources in scope, with the canonical hash of each (server meta stripped).
  log('checks: reading converted files');
  const expected = new Map<string, string>();
  const expectedByType: Record<string, number> = {};
  let fileLexeme: string | null = null;
  for (const type of Object.keys(manifest.types).sort()) {
    for await (const line of ndjson(join(convDir, `${type}.ndjson`))) {
      const r = parseLossless(line) as Obj;
      const link = patientLink(r);
      if (link && !patientInScope(d, o.scope, link.patientId)) continue;
      const { id } = typeAndId(r, type);
      expected.set(`${type}/${id}`, sha(canonical(withoutServerMeta(r) as LosslessValue)));
      expectedByType[type] = (expectedByType[type] ?? 0) + 1;
      if (`${type}/${id}` === lexemeProbeConfig().ref) fileLexeme = valueLexeme(r);
    }
  }

  // 1. Per-type totals.
  log('checks: per-type totals');
  const typeCounts: Record<string, { expected: number; served: number }> = {};
  await mapLimit(Object.keys(expectedByType).sort(), o.concurrency, async type => {
    typeCounts[type] = { expected: expectedByType[type]!, served: await countOf(`${HAPI_BASE}/${type}?_summary=count`) };
  });
  const typeMismatch = Object.entries(typeCounts).filter(([, c]) => c.expected !== c.served);
  if (typeMismatch.length) failures.push(`per-type totals differ: ${JSON.stringify(Object.fromEntries(typeMismatch))}`);
  const servedTotal = Object.values(typeCounts).reduce((n, c) => n + c.served, 0);

  // 2. Per-patient, per-type counts (the linkage field of the converted files, searched by the same parameter name).
  log('checks: per-patient counts');
  const pairs: { type: string; field: string; patient: string; expected: number }[] = [];
  for (const [type, byField] of Object.entries(patientCounts)) {
    for (const [field, byPatient] of Object.entries(byField)) {
      for (const [patient, n] of Object.entries(byPatient)) if (patientInScope(d, o.scope, patient)) pairs.push({ type, field, patient, expected: n });
    }
  }
  pairs.sort((a, b) => (`${a.type}${a.field}${a.patient}` < `${b.type}${b.field}${b.patient}` ? -1 : 1));
  const patientMismatches: (typeof pairs[number] & { served: number })[] = [];
  await mapLimit(pairs, o.concurrency, async p => {
    const served = await countOf(`${HAPI_BASE}/${p.type}?${p.field}=Patient/${p.patient}&_summary=count`);
    if (served !== p.expected) patientMismatches.push({ ...p, served });
  });
  if (patientMismatches.length) failures.push(`${patientMismatches.length} per-patient counts differ, e.g. ${JSON.stringify(patientMismatches.slice(0, 5))}`);

  // 3. Export: same resources as the files, every served reference resolves, served content vs file content.
  log('checks: export');
  const unitDir = join(exportDir(d), 'units');
  const exportUnitsExpected = await exportUnits(d, o.scope);
  const unitFiles = (await readdir(unitDir)).filter(f => f.endsWith('.ndjson')).sort();
  if (unitFiles.length !== exportUnitsExpected.length) failures.push(`export has ${unitFiles.length} units, expected ${exportUnitsExpected.length}`);
  const served = new Map<string, string>();
  const contentDiff: Record<string, number> = {};
  const contentDiffSamples: string[] = [];
  const unexpected: string[] = [];
  let refsChecked = 0;
  const unresolved = new Map<string, number>();
  for (const f of unitFiles) {
    for await (const line of ndjson(join(unitDir, f))) {
      const r = parseLossless(line) as Obj;
      const { type, id } = typeAndId(r, f);
      const key = `${type}/${id}`;
      const h = sha(canonical(withoutServerMeta(r) as LosslessValue));
      const prev = served.get(key);
      if (prev !== undefined) {
        if (prev !== h) failures.push(`${key} exported twice with different content`);
        continue;
      }
      served.set(key, h);
      const want = expected.get(key);
      if (want === undefined) { if (unexpected.length < 20) unexpected.push(key); continue; }
      if (want !== h) {
        contentDiff[type] = (contentDiff[type] ?? 0) + 1;
        if (contentDiffSamples.length < 10) contentDiffSamples.push(key);
      }
      for (const ref of literalRefs(r)) {
        refsChecked++;
        if (!expected.has(ref)) unresolved.set(ref, (unresolved.get(ref) ?? 0) + 1);
      }
    }
  }
  const missing = [...expected.keys()].filter(k => !served.has(k));
  if (missing.length) failures.push(`${missing.length} resources not exported, e.g. ${missing.slice(0, 5).join(', ')}`);
  if (unexpected.length) failures.push(`exported resources not in the files, e.g. ${unexpected.join(', ')}`);
  if (unresolved.size) failures.push(`${unresolved.size} served references do not resolve, e.g. ${[...unresolved.keys()].slice(0, 5).join(', ')}`);
  if (Object.keys(contentDiff).length) warnings.push(`served content differs from the file (server meta ignored) for ${JSON.stringify(contentDiff)}`);
  const exportHash = sha([...served].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, h]) => `${k}\t${h}\n`).join(''));

  // 4. Lexeme probe (MIMIC).
  let lexemeProbe: Record<string, unknown> | null = null;
  if (d === 'mimic' && expected.has(lexemeProbeConfig().ref)) {
    const r = await get(`${HAPI_BASE}/${lexemeProbeConfig().ref}`);
    const servedLexeme = r.status === 200 ? valueLexeme(parseLossless(r.text) as Obj) : null;
    lexemeProbe = { ref: lexemeProbeConfig().ref, expected: lexemeProbeConfig().lexeme, file: fileLexeme, served: servedLexeme, status: r.status, ok: servedLexeme === lexemeProbeConfig().lexeme };
    if (servedLexeme !== lexemeProbeConfig().lexeme) failures.push(`lexeme probe: served ${servedLexeme}, expected ${lexemeProbeConfig().lexeme}`);
  }

  // 5. Trailing-slash read and 6. _getpages on a type-level path (outcomes recorded, not pass/fail).
  const someObs = [...expected.keys()].find(k => k.startsWith('Observation/'))!;
  const slash = await get(`${HAPI_BASE}/${someObs}/`);
  const slashBody = slash.status === 200 ? parseLossless(slash.text) as Obj : null;
  const trailingSlash = { url: `${HAPI_BASE}/${someObs}/`, status: slash.status, returned_resource: slashBody ? `${String(slashBody.resourceType)}/${String(slashBody.id)}` : null };
  const getpages = await probeGetpages();

  // 7. fullUrl and next-link origin per slot through the recording proxy; proxy method policy; token shim.
  log('checks: slot proxies');
  const proxyLog = join(stateDir(d), 'proxy-check.jsonl');
  const slots = await probeSlots(d, proxyLog);
  if (!slots.every(s => s.ok)) failures.push(`slot proxy checks failed: ${JSON.stringify(slots.filter(s => !s.ok))}`);
  const proxyPolicy = await probeProxyPolicy(d, proxyLog);
  if (!proxyPolicy.ok) failures.push(`proxy policy check failed: ${JSON.stringify(proxyPolicy)}`);
  const shim = await probeShim(d, proxyLog);
  if (!shim.ok) failures.push(`token shim check failed: ${JSON.stringify(shim)}`);

  // 8. The HAPI settings as served.
  const effective = await probeEffective();
  const infra = await readManifest('infra');
  const want = (infra?.hapi ?? {}) as Record<string, unknown>;
  if (effective.default_page_entries !== Number(String(want.default_page_size))) failures.push(`default page size served ${effective.default_page_entries}, configured ${String(want.default_page_size)}`);
  if (effective.max_page_entries !== Number(String(want.max_page_size))) failures.push(`max page size served ${effective.max_page_entries}, configured ${String(want.max_page_size)}`);
  if (!effective.search_cache_reused_ids_differ) failures.push('two identical searches shared a cached result set');

  const progress = await readProgress(d);
  const chunks = progress.filter((r): r is ChunkDone => r.schema === 'fbbench.load-chunk/1');
  const batches = progress.filter((r): r is BatchDone => r.schema === 'fbbench.load-batch/1');
  const loadChunks = chunks.filter(c => c.phase === 'load');
  const loadMs = loadChunks.reduce((n, c) => n + c.ms, 0);
  const loaded = batches.reduce((n, b) => n + b.entries, 0);
  const header = progress[0] as unknown as Record<string, unknown>;
  const passed = failures.length === 0;
  const path = await writeManifest(`load-${d}`, {
    dataset: d,
    load_scope: o.scope,
    passed,
    failures,
    warnings,
    state: header,
    converted: { dir: convDir, manifest_sha256: await sha256File(join(convDir, 'manifest.json')), plan_sha256: await sha256File(join(convDir, 'load-plan.json')) },
    timing: {
      load_ms: loadMs,
      load_chunks: loadChunks.map(c => ({ started_at: c.started_at, ms: c.ms, resources: c.resources, per_second: c.ms ? Math.round(c.resources / (c.ms / 1000)) : null })),
      export_ms: chunks.filter(c => c.phase === 'export').reduce((n, c) => n + c.ms, 0),
      checks_ms: Date.now() - t0,
      batches: batches.length,
      resources_loaded: loaded,
      resources_per_second: loadMs ? Math.round(loaded / (loadMs / 1000)) : null,
      batch_retries: batches.filter(b => b.attempts > 1).length,
    },
    counts: { expected_total: expected.size, served_total: servedTotal, by_type: typeCounts },
    per_patient: { pairs_checked: pairs.length, mismatches: patientMismatches },
    export: {
      units: unitFiles.length,
      resources: served.size,
      canonical_hash: exportHash,
      canonical_hash_rule: 'sha256 over lines "Type/id\\tsha256(canonical JSON without meta.versionId, meta.lastUpdated, meta.source)\\n" sorted by Type/id; canonical JSON sorts object keys and keeps number lexemes',
      missing: missing.length,
      unexpected: unexpected.length,
      served_differs_from_file: { by_type: contentDiff, samples: contentDiffSamples },
    },
    references: { checked: refsChecked, unresolved: unresolved.size },
    lexeme_probe: lexemeProbe,
    trailing_slash: trailingSlash,
    getpages,
    slots,
    proxy_policy: proxyPolicy,
    token_shim: shim,
    hapi_effective: effective,
  });
  log(`checks: ${passed ? 'PASSED' : 'FAILED'} (${failures.length} failures, ${warnings.length} warnings); ${path}`);
  for (const f of failures) log(`  FAIL ${f}`);
  for (const w of warnings) log(`  WARN ${w}`);
  return passed;
}

function valueLexeme(r: Obj): string | null {
  const q = r.valueQuantity;
  return isObj(q) && q.value !== undefined && q.value !== null ? String(q.value) : null;
}

const ids = (b: Obj) => entries(b).map(e => (isObj(e.resource) ? `${String(e.resource.resourceType)}/${String(e.resource.id)}` : '?'));

async function probeGetpages(): Promise<Record<string, unknown>> {
  const first = await getJson(`${HAPI_BASE}/Observation?_count=5`);
  const next = nextLink(first);
  if (!next) return { next_link: null };
  const rootPage = await get(next);
  const u = new URL(next);
  const typeLevel = `${u.origin}${u.pathname.replace(/\/$/, '')}/Observation${u.search}`;
  const typePage = await get(typeLevel);
  const rootIds = rootPage.status === 200 ? ids(parseLossless(rootPage.text) as Obj) : null;
  const typeIds = typePage.status === 200 ? ids(parseLossless(typePage.text) as Obj) : null;
  return {
    next_link: next,
    server_root: { status: rootPage.status, entries: rootIds?.length ?? null },
    type_level: { url: typeLevel, status: typePage.status, entries: typeIds?.length ?? null, same_entries_as_root: rootIds !== null && typeIds !== null && rootIds.join() === typeIds.join() },
  };
}

async function probeSlots(d: DatasetId, logPath: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (let slot = 0; slot <= 7; slot++) {
    const port = slotPorts(slot).recordingProxy;
    let proxy;
    try {
      proxy = await startRecordingProxy({ slot, runId: `infra-check-${d}-slot${slot}`, logPath });
    } catch (e) {
      out.push({ slot, port, ok: false, error: `listen failed: ${(e as Error).message}` });
      continue;
    }
    try {
      const b = await getJson(`${proxyBase(slot)}/Patient?_id=${knownPatient(d)}`);
      const fullUrl = entries(b)[0]?.fullUrl;
      const page = await getJson(`${proxyBase(slot)}/Observation?_count=1`);
      const next = nextLink(page);
      const prefix = `http://127.0.0.1:${port}/fhir`;
      const ok = typeof fullUrl === 'string' && fullUrl.startsWith(`${prefix}/`) && typeof next === 'string' && next.startsWith(prefix);
      out.push({ slot, port, full_url: fullUrl ?? null, next_link_origin: next ? new URL(next).origin : null, ok });
    } catch (e) {
      out.push({ slot, port, ok: false, error: (e as Error).message });
    } finally {
      await proxy.close();
    }
  }
  return out;
}

async function probeProxyPolicy(d: DatasetId, logPath: string): Promise<Record<string, unknown> & { ok: boolean }> {
  const proxy = await startRecordingProxy({ slot: 0, runId: `infra-check-${d}-policy`, logPath });
  try {
    const base = proxyBase(0);
    // Harmless if the proxy failed to block them: HAPI would reject the mismatched PUT body and find nothing to delete.
    const probeId = 'fbbench-proxy-probe-absent';
    const put = await fetch(`${base}/Patient/${probeId}`, { method: 'PUT', headers: { 'content-type': FHIR_JSON }, body: '{"resourceType":"Observation"}' });
    const putBody = await put.text();
    const del = await fetch(`${base}/Patient/${probeId}`, { method: 'DELETE' });
    await del.text();
    const search = await fetch(`${base}/Patient/_search`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: FHIR_JSON }, body: `_id=${knownPatient(d)}` });
    const searchBody = parseLossless(await search.text()) as Obj;
    const gz = await fetch(`${base}/Patient/${knownPatient(d)}`, { headers: { accept: FHIR_JSON, 'accept-encoding': 'gzip' } });
    await gz.arrayBuffer();
    const r = {
      put_status: put.status, put_is_operation_outcome: putBody.includes('OperationOutcome'),
      delete_status: del.status,
      post_search_status: search.status, post_search_entries: entries(searchBody).length,
      gzip_status: gz.status,
    };
    return { ...r, ok: put.status === 403 && del.status === 403 && search.status === 200 && entries(searchBody).length === 1 && gz.status === 200 };
  } finally {
    await proxy.close();
  }
}

async function probeShim(d: DatasetId, logPath: string): Promise<Record<string, unknown> & { ok: boolean }> {
  const proxy = await startRecordingProxy({ slot: 0, runId: `infra-check-${d}-shim`, logPath });
  const shim = await startTokenShim({ slot: 0 });
  try {
    const origin = `http://127.0.0.1:${slotPorts(0).tokenShim}`;
    const tok = await fetch(`${origin}/oauth2/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' });
    const tokBody = JSON.parse(await tok.text()) as { access_token?: string }; // the shim's own JSON
    const b = await getJson(`${origin}/fhir/Patient?_id=${knownPatient(d)}`);
    const fullUrl = entries(b)[0]?.fullUrl;
    const ok = tok.status === 200 && typeof tokBody.access_token === 'string' && typeof fullUrl === 'string' && fullUrl.startsWith(`${origin}/fhir/`);
    return { token_status: tok.status, full_url: fullUrl ?? null, ok };
  } finally {
    await shim.close();
    await proxy.close();
  }
}

async function probeEffective(): Promise<{
  default_page_entries: number; max_page_entries: number; search_cache_reused_ids_differ: boolean;
  total_without_param: string | null; total_with_accurate: string | null;
}> {
  const def = await getJson(`${HAPI_BASE}/Observation`);
  const max = await getJson(`${HAPI_BASE}/Observation?_count=1000`);
  const a = nextLink(await getJson(`${HAPI_BASE}/Observation?_count=3`));
  const b = nextLink(await getJson(`${HAPI_BASE}/Observation?_count=3`));
  const pages = (u: string | null) => (u ? new URL(u).searchParams.get('_getpages') : null);
  const acc = await getJson(`${HAPI_BASE}/Observation?_count=1&_total=accurate`);
  return {
    default_page_entries: entries(def).length,
    max_page_entries: entries(max).length,
    search_cache_reused_ids_differ: pages(a) !== null && pages(b) !== null && pages(a) !== pages(b),
    total_without_param: def.total === undefined ? null : String(def.total),
    total_with_accurate: acc.total === undefined ? null : String(acc.total),
  };
}
