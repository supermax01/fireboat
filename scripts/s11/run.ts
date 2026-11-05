#!/usr/bin/env node
/** Root-only future run driver. Merely importing this file starts no generation, task, container or measurement. */
import { spawn } from 'node:child_process';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GENERATOR_PINS } from '../../examples/quickstart/manifest.js';
import { naturalChart } from './corpus.js';
import { generateCandidate } from './generate.js';
import { measureChart, type Attempt } from './measure.js';
import { makePlans } from './tasks.js';
import { analyze, type Tokens } from './report.js';
import { mutationProtocol, fidelityMutationEvidence } from './mutation-evidence.js';
import { assertDevelopmentSane, assertHeldoutUnconsumed, cohortKey, consumeHeldout, heldoutCohort, recordHeldoutEvent } from './heldout-ledger.js';
import { STUDY, hash, pool, exclusion, selectPrefix, completeCohort, requireS11, rawJsonMember, rec, type Screening, type Split, type Stratum } from './study.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TOKEN_CACHE = '/private/tmp/fireboat-s58b-ci';
interface RunInput { name: string; jar: string; python: string; cache: string; wheelhouse: string; mode: 'exploratory' | 'reference'; mutationShards?: string }
interface Selection extends Screening { label: string; patient: string; directory: string; ndjsonSha256: string; manifestSha256: string; tasksSha256: string;
  rawReceiptSha256: string; chartInventorySha256: string }
export function parseRunArgs(args: readonly string[]): RunInput {
  requireS11(args[0] === '--after-aggregate', 'AFTER_AGGREGATE_REQUIRED');
  const flags: Record<string, string> = {};
  for (let i = 1; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    requireS11(key && ['--run', '--jar', '--python', '--cache', '--wheelhouse', '--tokenizer-mode', '--mutation-shards'].includes(key) && value && !flags[key], 'RUN_ARGUMENTS'); flags[key] = value;
  }
  requireS11(/^[a-z0-9][a-z0-9-]{0,63}$/.test(flags['--run'] ?? ''), 'RUN_NAME_REQUIRED');
  requireS11(['exploratory', 'reference'].includes(flags['--tokenizer-mode'] ?? ''), 'TOKENIZER_MODE_REQUIRED');
  const result: RunInput = { name: flags['--run']!, jar: flags['--jar'] ?? resolve(ROOT, '../../synthea/v4.0.0/synthea-with-dependencies.jar'),
    python: flags['--python'] ?? `${TOKEN_CACHE}/venv/bin/python`, cache: flags['--cache'] ?? `${TOKEN_CACHE}/cache`,
    wheelhouse: flags['--wheelhouse'] ?? `${TOKEN_CACHE}/hash-checked-wheels`, mode: flags['--tokenizer-mode'] as RunInput['mode'],
    ...(flags['--mutation-shards'] ? { mutationShards: flags['--mutation-shards'] } : {}) };
  requireS11([result.jar, result.python, result.cache, result.wheelhouse, ...(result.mutationShards ? [result.mutationShards] : [])].every(p => isAbsolute(p) && !/[,\0\r\n]/.test(p)), 'INPUT_PATH_INVALID');
  return result;
}
async function privateJson(path: string, value: unknown) { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' }); }
async function execute(file: string, args: string[], input?: string): Promise<string> {
  return new Promise((accept, reject) => {
    const env = Object.fromEntries(['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_CONTEXT'].filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]));
    const child = spawn(file, args, { cwd: ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = []; let bytes = 0;
    child.stdout.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 8_388_608) child.kill('SIGKILL'); else out.push(chunk); });
    child.stderr.resume(); // Arbitrary subprocess text is never an ordinary log.
    child.once('error', () => reject(new Error('LOCAL_COMMAND_MISSING')));
    child.once('exit', code => code === 0 && bytes <= 8_388_608 ? accept(Buffer.concat(out).toString('utf8')) : reject(new Error('LOCAL_COMMAND_FAILED')));
    child.stdin.end(input);
  });
}
async function sourceSnapshot() {
  const list = (await execute('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])).split('\0')
    .filter(p => /^(scripts|packages|examples|tests|docs|proposals)\//.test(p) || ['PLAN.md', 'AGENTS.md', 'package.json', 'package-lock.json', 'tsconfig.json'].includes(p))
    .filter(p => /\.(ts|mjs|json|py|txt|md|properties)$/.test(p)).sort();
  const files = [];
  for (const path of list) {
    const info = await lstat(join(ROOT, path)); requireS11(info.isFile() && !info.isSymbolicLink(), 'SOURCE_FILE_INVALID');
    const bytes = await readFile(join(ROOT, path)); files.push({ path, bytes: bytes.length, sha256: hash(bytes) });
  }
  return { commit: (await execute('git', ['rev-parse', 'HEAD'])).trim(), sha256: hash(JSON.stringify(files)), files };
}
async function verifySources(snapshot: Awaited<ReturnType<typeof sourceSnapshot>>) {
  const current = await sourceSnapshot(); requireS11(current.commit === snapshot.commit && current.sha256 === snapshot.sha256, 'FROZEN_SOURCES_CHANGED');
}
async function makeOutput(name: string) {
  let parent = await realpath(ROOT);
  for (const part of ['artifacts', 'm3b-measurement']) {
    const path = join(parent, part);
    try { await mkdir(path, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    const stat = await lstat(path); requireS11(stat.isDirectory() && !stat.isSymbolicLink(), 'OUTPUT_SYMLINK'); parent = path;
  }
  const out = join(parent, name); await mkdir(out, { mode: 0o700 }); return out;
}
async function tokenizer(input: RunInput, captures: string, outParent: string, name: string, preflight = false): Promise<Tokens | undefined> {
  const lock = join(ROOT, 'packages/evals/data/tokenizers.lock.json'), requirements = join(ROOT, 'scripts/requirements-tokenizers.txt');
  const common = ['--captures', captures, '--lock', lock, '--requirements', requirements, '--cache', input.cache, '--wheelhouse', input.wheelhouse,
    '--out', join(outParent, name), ...(preflight ? ['--preflight'] : [])];
  if (input.mode === 'exploratory') await execute(input.python, [join(ROOT, 'scripts/s11/tokenize.py'), ...common, '--exploratory']);
  else {
    const pins = JSON.parse(await readFile(lock, 'utf8')) as { python: { image: string; platform: string } };
    const mounts = [[ROOT, '/repo'], [input.cache, '/cache'], [input.wheelhouse, '/wheels'], [captures, '/captures'], [outParent, '/result']];
    const args = ['run', '--rm', '--pull', 'never', '--network', 'none', '--platform', pins.python.platform, '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges', '--tmpfs', '/tmp:rw,nosuid,size=256m', ...mounts.flatMap(([src, dst]) => ['--mount', `type=bind,src=${src},dst=${dst}${dst === '/result' ? '' : ',readonly'}`]), pins.python.image,
      'sh', '-ec', 'python -m pip install --require-hashes --no-index --find-links /wheels --target /tmp/site -r /repo/scripts/requirements-tokenizers.txt >/tmp/pip.log 2>&1 && PYTHONPATH=/tmp/site python /repo/scripts/s11/tokenize.py "$@"', 's11-tokenize',
      '--captures', '/captures', '--lock', '/repo/packages/evals/data/tokenizers.lock.json', '--requirements', '/repo/scripts/requirements-tokenizers.txt',
      '--cache', '/cache', '--wheelhouse', '/wheels', '--out', `/result/${name}`, '--image-reference', pins.python.image, ...(preflight ? ['--preflight'] : [])];
    await execute('docker', args);
  }
  if (preflight) return undefined;
  return JSON.parse(await readFile(join(outParent, name, 'tokens.json'), 'utf8')) as Tokens;
}
async function jarInventory(jar: string, python: string) {
  const code = 'import sys,zipfile,hashlib,json\nz=zipfile.ZipFile(sys.argv[1])\nnames=sorted(n for n in z.namelist() if not n.endswith("/") and (n.startswith("modules/") or n.endswith(".properties")))\nprint(json.dumps([{"path":n,"bytes":len(z.read(n)),"sha256":hashlib.sha256(z.read(n)).hexdigest()} for n in names],separators=(",",":")))';
  const inventory: unknown = JSON.parse(await execute(python, ['-I', '-c', code, jar]));
  requireS11(Array.isArray(inventory) && inventory.length > 0, 'JAR_MODULE_INVENTORY_MISSING'); return inventory;
}
export async function runStudy(input: RunInput) {
  const started = performance.now();
  requireS11(process.version === 'v24.22.0', 'NODE_24_22_0_REQUIRED');
  const out = await makeOutput(input.name), snapshot = await sourceSnapshot();
  const mutations = await mutationProtocol(ROOT);
  let stage = 'preflight';
  let stageStarted = started;
  const stageTimings: Record<string, number> = {};
  const transition = (next: string) => { const now = performance.now(); stageTimings[stage] = now - stageStarted; stage = next; stageStarted = now; };
  // The heldout ledger sits beside every run directory; heldout chart material stays in this run's separate custody tree.
  const parent = dirname(out), cohort = heldoutCohort();
  const custody = join(out, 'heldout-custody');
  let unsealed = false;
  try {
    // Refuse before any generation when this heldout cohort was already unsealed by ANY run name.
    const priorExposures = await assertHeldoutUnconsumed(parent, cohort);
    await privateJson(join(out, 'preregistration-freeze.json'), { schema: STUDY.schema, frozen_at: new Date().toISOString(), study: STUDY,
      source: snapshot, preregistration_sha256: hash(await readFile(join(ROOT, 'docs/S11-PREREGISTRATION.md'))), generatorPins: GENERATOR_PINS,
      tokenizer_mode: input.mode, mutations, efficiency_status: 'unmeasured', heldout_unsealed: false,
      heldout_cohort_key: cohortKey(cohort), prior_heldout_exposures: priorExposures });
    // Supplied mutation evidence is validated now, so invalid evidence stops the study before any chart exists.
    if (input.mutationShards) await fidelityMutationEvidence(ROOT, mutations, input.mutationShards);
    const jar = await readFile(input.jar); requireS11(jar.length === GENERATOR_PINS.synthea.bytes && hash(jar) === GENERATOR_PINS.synthea.sha256, 'JAR_MISMATCH');
    await execute('docker', ['image', 'inspect', `eclipse-temurin@${GENERATOR_PINS.jdk.childDigest}`, '--format', '{{.Id}}']);
    const preflightCaptures = join(out, 'preflight-captures'); await mkdir(preflightCaptures, { mode: 0o700 });
    await tokenizer(input, preflightCaptures, out, 'tokenizer-preflight', true);
    await privateJson(join(out, 'jar-modules.json'), await jarInventory(input.jar, input.python));
    transition('corpus');
    const screened: (Screening & { exclusion: string | null })[] = [], selected: Selection[] = [];
    const screenedRoot = join(out, 'screened'); await mkdir(screenedRoot, { mode: 0o700 });
    const charts = join(out, 'charts'); await mkdir(charts, { mode: 0o700 });
    // Custody separation: heldout raw exports, receipts and chart views never enter the development-readable trees.
    await mkdir(custody, { mode: 0o700 });
    const custodyScreened = join(custody, 'screened'), custodyCharts = join(custody, 'charts');
    await mkdir(custodyScreened, { mode: 0o700 }); await mkdir(custodyCharts, { mode: 0o700 });
    const screenedFor = (split: Split) => split === 'heldout' ? custodyScreened : screenedRoot;
    const chartsFor = (split: Split) => split === 'heldout' ? custodyCharts : charts;
    let fulfilled = true;
    for (const split of ['development', 'heldout'] as const) for (const stratum of STUDY.strata) {
      const rows: Screening[] = [];
      for (const seed of pool(split, stratum)) {
        // A failed generator/repeatability check aborts the study; it is never a size-based seed exclusion.
        const generated = await generateCandidate({ split, stratum, seed, jar: input.jar, out: join(screenedFor(split), `${split}-${stratum}-${seed}`) });
        let chart: ReturnType<typeof naturalChart> | undefined;
        let row: Screening = { split, stratum, seed, chartResources: null, eligibleObservations: null, sanitizedObservationBytes: null };
        try {
          chart = naturalChart(generated.exports);
          row = { ...row, chartResources: chart.chartResources, eligibleObservations: chart.eligibleObservations, sanitizedObservationBytes: chart.sanitizedObservationBytes };
        } catch (error) {
          const code = error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'CHART_TRANSFORM_FAILED';
          row.failure = code;
        }
        const reason = exclusion(row); rows.push(row); screened.push({ ...row, exclusion: reason ?? null });
        const receipt = { ...generated, exports: undefined, screening: row, exclusion: reason ?? null };
        await privateJson(join(screenedFor(split), `${split}-${stratum}-${seed}`, 'receipt.json'), receipt);
        if (!reason && chart) {
          const label = `${split}-${stratum}-${rows.filter(r => !exclusion(r)).length}`, directory = join(chartsFor(split), label); await mkdir(directory, { mode: 0o700 });
          await writeFile(join(directory, 'resources.ndjson'), chart.seed.ndjson, { mode: 0o600, flag: 'wx' });
          await privateJson(join(directory, 'natural-manifest.json'), chart.seed.manifest);
          await privateJson(join(directory, 'chart-inventory.json'), chart.chartInventory);
          const plans = makePlans(chart.seed.ndjson, label); await privateJson(join(directory, 'tasks.json'), plans);
          selected.push({ ...row, label, patient: chart.patient, directory: relative(out, directory), ndjsonSha256: hash(chart.seed.ndjson),
            manifestSha256: hash(await readFile(join(directory, 'natural-manifest.json'))), tasksSha256: hash(await readFile(join(directory, 'tasks.json'))),
            rawReceiptSha256: hash(await readFile(join(screenedFor(split), `${split}-${stratum}-${seed}`, 'receipt.json'))),
            chartInventorySha256: hash(await readFile(join(directory, 'chart-inventory.json'))) });
        }
        if (selectPrefix(rows, split, stratum).fulfilled) break;
      }
      if (!selectPrefix(rows, split, stratum).fulfilled) fulfilled = false;
    }
    fulfilled = fulfilled && completeCohort(selected);
    await verifySources(snapshot);
    await privateJson(join(out, 'corpus-freeze.json'), { schema: STUDY.schema, frozen_at: new Date().toISOString(), fulfilled,
      selected, screening: screened, source_sha256: snapshot.sha256,
      cohort_sha256: hash(JSON.stringify(selected)), screening_sha256: hash(JSON.stringify(screened)), generator_inventory_sha256: hash(await readFile(join(out, 'jar-modules.json'))) });
    // Every materialized heldout cohort is an exposure, recorded outside the run directory whether or not it is unsealed.
    await recordHeldoutEvent(parent, { run: input.name, event: 'custody', cohort_key: cohortKey(cohort), at: new Date().toISOString(),
      detail_sha256: hash(await readFile(join(out, 'corpus-freeze.json'))) });
    if (!fulfilled) {
      transition('report');
      await privateJson(join(out, 'report.json'), { ...analyze([], undefined, false), corpus_status: 'unfulfilled', screening: screened,
        stage_ms_descriptive_only: stageTimings, total_ms_descriptive_only: performance.now() - started });
      const reportSha256 = hash(await readFile(join(out, 'report.json')));
      await writeFile(join(out, 'SHA256SUMS'), `${reportSha256}  report.json\n`, { mode: 0o600, flag: 'wx' });
      process.stdout.write(`${JSON.stringify({ status: 'unfulfilled-unmeasured', selected: selected.length, source_sha256: snapshot.sha256, report_sha256: reportSha256 })}\n`); return;
    }
    requireS11(selected.length === 30, 'CORPUS_SIZE');
    const captures = join(out, 'captures'); await mkdir(captures, { mode: 0o700 });
    const attempts: Attempt[] = [];
    const measure = async (selection: Selection) => {
      // Heldout custody opens only after the exclusive ledger consumption and the run's unseal marker.
      requireS11(selection.split !== 'heldout' || unsealed, 'HELDOUT_SEALED');
      const directory = join(out, selection.directory), ndjson = await readFile(join(directory, 'resources.ndjson'), 'utf8');
      requireS11(hash(ndjson) === selection.ndjsonSha256 && hash(await readFile(join(directory, 'tasks.json'))) === selection.tasksSha256
        && hash(await readFile(join(directory, 'natural-manifest.json'))) === selection.manifestSha256
        && hash(await readFile(join(directory, 'chart-inventory.json'))) === selection.chartInventorySha256
        && hash(await readFile(join(screenedFor(selection.split), `${selection.split}-${selection.stratum}-${selection.seed}`, 'receipt.json'))) === selection.rawReceiptSha256, 'CORPUS_CHANGED');
      attempts.push(...await measureChart({ ndjson, patient: selection.patient, label: selection.label, split: selection.split, stratum: selection.stratum,
        out: join(captures, selection.label), codeRevision: snapshot.commit }));
    };
    transition('development');
    for (const chart of selected.filter(c => c.split === 'development')) await measure(chart);
    const developmentTokens = await tokenizer(input, captures, out, 'development-tokens');
    const development = analyze(attempts, developmentTokens, true);
    const perRoot: Record<string, number> = {};
    for (const chart of selected.filter(c => c.split === 'development')) {
      const ndjson = await readFile(join(out, chart.directory, 'resources.ndjson'), 'utf8');
      for (const line of ndjson.trimEnd().split('\n')) {
        const resource = rec(JSON.parse(line))!;
        for (const key of Object.keys(resource)) { const name = `${resource.resourceType}.${key}`; perRoot[name] = (perRoot[name] ?? 0) + Buffer.byteLength(rawJsonMember(line, key)!); }
      }
    }
    await privateJson(join(out, 'development-freeze.json'), { frozen_at: new Date().toISOString(), source_sha256: snapshot.sha256,
      corpus_freeze_sha256: hash(await readFile(join(out, 'corpus-freeze.json'))), per_root_source_value_bytes: perRoot,
      token_report_sha256: hash(await readFile(join(out, 'development-tokens', 'tokens.json'))),
      per_root_delivered_value_bytes: attempts.map(a => ({ id: a.id, arm: a.arm, era: a.era, bytes: a.resource_root_bytes })),
      observed_development_distributions: development.c2, token_range_status: input.mode === 'exploratory' ? 'exploratory only; reference expectation unmeasured' : 'measured development, not heldout attainment',
      prospective_empirical_ranges: development.c2.filter(c => c.split === 'development').map(c => ({ era: c.era, arm: c.arm,
        basis: 'observed development min/max; descriptive expectation, not a prediction interval or heldout result',
        correct_development_answers: c.correct, model_bytes: { min: c.model_bytes_per_correct_answer.min, max: c.model_bytes_per_correct_answer.max },
        reference_model_tokens: input.mode === 'reference' ? c.tokens.map(t => ({ encoding: t.encoding, min: t.per_correct_answer.min, max: t.per_correct_answer.max })) : 'unmeasured' })), study: STUDY });
    await verifySources(snapshot);
    // A broken harness or confinement failure in development never consumes the holdout.
    assertDevelopmentSane(attempts);
    // This exclusive marker precedes the FIRST heldout task. No resume/retry path can replace an opened study, and the
    // study-level ledger consumption (outside this run directory) makes the cohort single-use across run names.
    transition('heldout');
    const unsealedAt = new Date().toISOString();
    const developmentFreezeSha256 = hash(await readFile(join(out, 'development-freeze.json'))), corpusFreezeSha256 = hash(await readFile(join(out, 'corpus-freeze.json')));
    const consumptionSha256 = await consumeHeldout(parent, { run: input.name, at: unsealedAt, corpus_freeze_sha256: corpusFreezeSha256, development_freeze_sha256: developmentFreezeSha256 }, cohort);
    await privateJson(join(out, 'HELDOUT-UNSEALED.json'), { at: unsealedAt, source_sha256: snapshot.sha256,
      development_freeze_sha256: developmentFreezeSha256, corpus_freeze_sha256: corpusFreezeSha256, heldout_ledger_consumption_sha256: consumptionSha256 });
    unsealed = true;
    for (const chart of selected.filter(c => c.split === 'heldout' && c.stratum === 'large')) await measure(chart);
    transition('analysis');
    const tokens = await tokenizer(input, captures, out, 'all-tokens');
    await verifySources(snapshot);
    const mutationEvidence = await fidelityMutationEvidence(ROOT, mutations, input.mutationShards);
    const report = analyze(attempts, tokens, true, mutationEvidence.passed);
    transition('report');
    await privateJson(join(out, 'report.json'), { ...report, source_sha256: snapshot.sha256, corpus_freeze_sha256: hash(await readFile(join(out, 'corpus-freeze.json'))),
      token_report_sha256: hash(await readFile(join(out, 'all-tokens', 'tokens.json'))), development_freeze_sha256: hash(await readFile(join(out, 'development-freeze.json'))),
      heldout_unsealed_sha256: hash(await readFile(join(out, 'HELDOUT-UNSEALED.json'))),
      stage_ms_descriptive_only: stageTimings, total_ms_descriptive_only: performance.now() - started,
      fidelity_mutations: mutationEvidence,
      missing_acceptance_inputs: [...(mutationEvidence.passed ? [] : ['exact-source applicable fidelity-mutant aggregate evidence']), ...(input.mode === 'exploratory' ? ['pinned Linux/amd64 reference tokenizer execution'] : []), 'verified structured-delivery host capture'],
      execution: 'source SDK/gateway with synthetic adapter; not an installed artifact, HAPI or autonomous model trial' });
    await writeFile(join(out, 'SHA256SUMS'), `${hash(await readFile(join(out, 'report.json')))}  report.json\n`, { mode: 0o600, flag: 'wx' });
    process.stdout.write(`${JSON.stringify({ status: 'reported-no-default-change', attempts: attempts.length, report_sha256: hash(await readFile(join(out, 'report.json'))) })}\n`);
  } catch (error) {
    const code = error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'S11_RUN_FAILED';
    const failedStage = stage; transition('failed');
    await privateJson(join(out, 'failure.json'), { stage: failedStage, code, status: 'unmeasured', no_selective_rerun: true,
      stage_ms_descriptive_only: stageTimings, total_ms_descriptive_only: performance.now() - started });
    throw new Error(code);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runStudy(parseRunArgs(process.argv.slice(2))); }
  catch (error) { process.stderr.write(`${error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'S11_RUN_FAILED'}\n`); process.exitCode = 1; }
}
