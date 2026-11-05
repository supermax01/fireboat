import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseRunArgs } from '../scripts/s11/run.js';
import { fidelityMutantSet, fidelityMutationEvidence, type MutationProtocol } from '../scripts/s11/mutation-evidence.js';
import { LEDGER_DIRECTORY, assertDevelopmentSane, assertHeldoutUnconsumed, consumeHeldout, heldoutCohort, recordHeldoutEvent, type HeldoutCohort } from '../scripts/s11/heldout-ledger.js';
import type { Attempt } from '../scripts/s11/measure.js';

test('S11 root driver requires a new named study, explicit after-aggregate and tokenizer mode; absolute local inputs only', () => {
  assert.throws(() => parseRunArgs([]), /AFTER_AGGREGATE_REQUIRED/);
  assert.throws(() => parseRunArgs(['--after-aggregate', '--run', 'r1']), /TOKENIZER_MODE_REQUIRED/);
  const args = ['--after-aggregate', '--run', 's11-r1', '--tokenizer-mode', 'exploratory'];
  const parsed = parseRunArgs(args);
  assert.equal(parsed.mode, 'exploratory'); assert.ok(parsed.jar.startsWith('/') && parsed.jar.endsWith('/synthea/v4.0.0/synthea-with-dependencies.jar'));
  assert.ok(parsed.wheelhouse.endsWith('/hash-checked-wheels'));
  assert.throws(() => parseRunArgs([...args, '--run', 'twice']), /RUN_ARGUMENTS/);
  assert.throws(() => parseRunArgs([...args, '--jar', '../relative.jar']), /INPUT_PATH_INVALID/);
  assert.throws(() => parseRunArgs([...args, '--unknown', 'x']), /RUN_ARGUMENTS/);
  assert.throws(() => parseRunArgs(['--after-aggregate', '--run', '../escape', '--tokenizer-mode', 'reference']), /RUN_NAME_REQUIRED/);
});
test('S11 offline token counting hashes captured messages and sums message tokenizations without cross-message merges', () => {
  // Pure fake encoder: no real tokenizer, Docker, network, generator, gateway, task session or installation.
  const program = String.raw`
import importlib.util, pathlib, tempfile, types, json, hashlib
spec=importlib.util.spec_from_file_location('s11_tokenize',pathlib.Path('scripts/s11/tokenize.py').resolve())
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Encoder:
 def encode_ordinary(self,text): return [0] * (1 if text else 0)
m.s5.load_tokenizers=lambda args,report: ({},{'cl100k_base':Encoder(),'o200k_base':Encoder()})
with tempfile.TemporaryDirectory() as root:
 p=pathlib.Path(root); capture=p/'captures';capture.mkdir();segments=[]
 for index,(kind,text) in enumerate([('model','a'),('model','b'),('request','{}'),('catalog','{}'),('wire','{}')]):
  name=str(index)+'.txt';(capture/name).write_text(text);data=text.encode();segments.append({'kind':kind,'file':{'path':name,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}})
 attempt={'id':'one','segments':segments,'model_bytes':2,'wire_result_bytes':2}
 (capture/'attempts.json').write_text(json.dumps({'schema':'fireboat-s11-capture/1','attempts':[attempt]}))
 args=types.SimpleNamespace(captures=capture,exploratory=True,preflight=False)
 report=m.tokenize(args); assert report['status']=='exploratory'
 assert report['attempts'][0]['tokens']['cl100k_base']=={'catalog':1,'request':1,'model':2,'wire':1,'combined_task':4}
 (capture/'0.txt').write_text('tampered')
 try: m.tokenize(args)
 except m.s5.GateError as e: assert e.code=='INPUT_HASH_MISMATCH'
 else: raise AssertionError('corrupt capture accepted')
print('pure-tokenizer-pass')
`;
  assert.equal(execFileSync('python3', ['-I', '-B', '-c', program], { encoding: 'utf8' }).trim(), 'pure-tokenizer-pass');
});
test('S11 heldout artifacts and source harness are absent from the explicit npm package inventory', () => {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as { files: string[] };
  assert.ok(manifest.files.length > 0);
  assert.ok(manifest.files.every(p => !/^(artifacts|scripts\/s11|tests\/s11)/.test(p)));
  const ignore = readFileSync('.gitignore', 'utf8'); assert.ok(ignore.split('\n').includes('artifacts/'));
});

type GateMutant = { id: string };
const gate = await import(new URL('../scripts/mutation-guards.mjs', import.meta.url).href) as {
  MUTANTS: GateMutant[]; mutantListHash(m: GateMutant[]): string; partitionMutants(m: GateMutant[], n: number): GateMutant[][];
  buildShardReport(input: Record<string, unknown>): { results: { id: string; verdict: string }[] }; shardReportFileName(i: number, n: number): string;
};
const declared = JSON.parse(readFileSync('scripts/mutation-survivors.json', 'utf8')) as { id: string; justification: string }[];
const binding = { commit: 'a'.repeat(40), tree: 'b'.repeat(40), inputsSha256: 'c'.repeat(64), survivorsSha256: 'd'.repeat(64), nodeVersion: 'v24.22.0', platform: 'darwin', arch: 'arm64', runId: null, runAttempt: null };
/** A complete, otherwise valid 14-shard aggregate in which `verdict` decides each mutant's outcome. */
async function shardSet(verdict: (id: string) => 'killed' | 'survived', drop?: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 's11-fidelity-shards-'));
  for (const [index, shard] of gate.partitionMutants(gate.MUTANTS, 14).entries()) {
    const results = shard.filter(m => m.id !== drop).map(m => { const v = verdict(m.id);
      return { id: m.id, status: v, failingTests: v === 'killed' ? ['synthetic killing test'] : [], anchorMatches: 1, reproducedTimeout: false, kill_kind: v === 'killed' ? 'named' : null }; });
    const report = gate.buildShardReport({ shardIndex: index + 1, shardCount: 14, mutants: gate.MUTANTS, binding, baseline: 'green', results, durationMs: 1, scheduledIds: shard.map(m => m.id) });
    await writeFile(join(directory, gate.shardReportFileName(index + 1, 14)), JSON.stringify(report));
  }
  return directory;
}

test('E5 the frozen fidelity set treats declared survivors as the aggregate does: a valid aggregate is accepted, a missing required kill is not', async () => {
  const set = fidelityMutantSet(gate.MUTANTS, declared);
  const survivors = new Set(declared.map(d => d.id));
  // Both declared survivors edit packages/core/src/index.ts, so they are applicable, but never required kills.
  assert.deepEqual(set.declared_survivors.map(s => s.id).sort(), [...survivors].sort());
  assert.ok(set.declared_survivors.every(s => /^[a-f0-9]{64}$/.test(s.justification_sha256)));
  assert.ok(set.required_ids.length > 50 && set.required_ids.every(id => !survivors.has(id)));
  assert.ok(set.required_ids.includes('s11-host-fidelity') && set.required_ids.includes('citation-index-dropped'));
  assert.ok(set.required_ids.includes('scheme-screen') && !set.required_ids.includes('local-refusal-identity-lost'), 'the frozen file rule selects privacy.ts, not auth');
  const protocol: MutationProtocol = { binding, list_sha256: gate.mutantListHash(gate.MUTANTS), ...set };
  const directories: string[] = [];
  const evidence = async (verdict: (id: string) => 'killed' | 'survived', drop?: string, frozen = protocol) => {
    const directory = await shardSet(verdict, drop); directories.push(directory);
    return fidelityMutationEvidence(process.cwd(), frozen, directory);
  };
  try {
    assert.equal((await fidelityMutationEvidence(process.cwd(), protocol)).status, 'unmeasured');
    // Acceptance: declared survivors survive, every other mutant is killed.
    const valid = await evidence(id => survivors.has(id) ? 'survived' : 'killed');
    assert.equal(valid.passed, true); assert.equal(valid.status, 'passed'); assert.equal(valid.report_hashes.length, 14);
    // Rejection: a required fidelity mutant that survived, or never ran, is no pass.
    const required = set.required_ids[0]!;
    await assert.rejects(evidence(id => survivors.has(id) || id === required ? 'survived' : 'killed'), /FIDELITY_AGGREGATE_INVALID/);
    await assert.rejects(evidence(id => survivors.has(id) ? 'survived' : 'killed', required), /FIDELITY_AGGREGATE_INVALID/);
    // Killing a declared survivor is what the aggregate itself rejects, so requiring that kill could never pass.
    await assert.rejects(evidence(() => 'killed'), /FIDELITY_AGGREGATE_INVALID/);
    // A frozen set that disagrees with the survivors in force (e.g. one that still required a declared survivor) is refused.
    const stale = { ...protocol, required_ids: [...protocol.required_ids, set.declared_survivors[0]!.id], declared_survivors: protocol.declared_survivors.slice(1) };
    await assert.rejects(evidence(id => survivors.has(id) ? 'survived' : 'killed', undefined, stale), /FIDELITY_SET_CHANGED/);
  } finally { for (const directory of directories) await rm(directory, { recursive: true, force: true }); }
});

test('E2 the heldout ledger lives beside the run directories and makes the cohort single-use across run names', async () => {
  const parent = await mkdtemp(join(tmpdir(), 's11-ledger-'));
  try {
    assert.throws(() => parseRunArgs(['--after-aggregate', '--run', LEDGER_DIRECTORY, '--tokenizer-mode', 'exploratory']), /RUN_NAME_REQUIRED/);
    await mkdir(join(parent, 'first-run'));
    assert.deepEqual(await assertHeldoutUnconsumed(parent), []);
    const cohort = heldoutCohort(), key = (await import('../scripts/s11/heldout-ledger.js')).cohortKey(cohort);
    await recordHeldoutEvent(parent, { run: 'first-run', event: 'custody', cohort_key: key, at: '2026-10-25T00:00:00Z' });
    assert.equal((await assertHeldoutUnconsumed(parent)).length, 1, 'an exposure without unseal is disclosed, not consumed');
    const record = { run: 'first-run', at: '2026-10-25T00:00:01Z', corpus_freeze_sha256: 'e'.repeat(64), development_freeze_sha256: 'f'.repeat(64) };
    assert.match(await consumeHeldout(parent, record), /^[a-f0-9]{64}$/);
    // A new run name, a changed study label over the same pools, or any overlapping pool cannot reopen it.
    await assert.rejects(consumeHeldout(parent, { ...record, run: 'renamed-run' }), /HELDOUT_ALREADY_CONSUMED/);
    await assert.rejects(assertHeldoutUnconsumed(parent), /HELDOUT_ALREADY_CONSUMED/);
    const relabelled: HeldoutCohort = { ...cohort, study: 'fireboat-s11/2' }, overlapping: HeldoutCohort = { ...cohort, pools: [cohort.pools[2]! + 100] };
    await assert.rejects(assertHeldoutUnconsumed(parent, relabelled), /HELDOUT_ALREADY_CONSUMED/);
    await assert.rejects(assertHeldoutUnconsumed(parent, overlapping), /HELDOUT_ALREADY_CONSUMED/);
    assert.equal((await assertHeldoutUnconsumed(parent, { study: 'fireboat-s11/2', pools: [300000], pool_size: 128 })).length, 2, 'a disjoint new holdout is available');
    const files = await readdir(join(parent, LEDGER_DIRECTORY));
    assert.deepEqual(files.filter(f => f.startsWith('CONSUMED-')).length, 1);
    const events = (await readFile(join(parent, LEDGER_DIRECTORY, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line).event);
    assert.deepEqual(events, ['custody', 'unsealed']);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('E2 a broken development harness or confinement failure refuses to unseal; measured outcomes do not', () => {
  const attempt = (over: Partial<Attempt> = {}) => ({ split: 'development', eval: { failures: [] }, ...over }) as unknown as Attempt;
  assert.doesNotThrow(() => assertDevelopmentSane([attempt(), attempt({ status: 'fail', eval: { failures: [{ cause: 'expected_fact_mismatch', detail: '' }] } as never })]));
  for (const cause of ['upstream_confinement_missing', 'harness_error', 'upstream_count_mismatch'])
    assert.throws(() => assertDevelopmentSane([attempt(), attempt({ eval: { failures: [{ cause, detail: '' }] } as never })]), /DEVELOPMENT_HARNESS_FAILURE/, cause);
  assert.throws(() => assertDevelopmentSane([attempt({ reason: 'EVAL_ACCOUNTING_MISMATCH' })]), /DEVELOPMENT_HARNESS_FAILURE/);
  assert.throws(() => assertDevelopmentSane([attempt(), attempt({ split: 'heldout' })]), /HELDOUT_MEASURED_EARLY/);
  assert.throws(() => assertDevelopmentSane([]), /DEVELOPMENT_MISSING/);
});
