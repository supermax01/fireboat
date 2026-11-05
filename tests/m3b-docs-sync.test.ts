import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import supportMatrix from '../packages/core/src/data/support-matrix.json' with { type: 'json' };
import compactProfiles from '../packages/core/src/data/compact-profiles.json' with { type: 'json' };
import hostProfiles from '../packages/core/src/data/host-profiles.json' with { type: 'json' };
import searchProfiles from '../packages/core/src/data/search-profiles.json' with { type: 'json' };
import { coverageV2Schema, FAULT_CODES, LAB_EVIDENCE_RECIPE_ID, RECIPE_IDS, type GatewayEnvelope02, type ToolName } from '../packages/core/src/contracts.js';
import { WARNING_MESSAGES } from '../packages/core/src/catalog.js';
import { HOST_PROFILE_REGISTRY, type HostProfileEntry } from '../packages/core/src/delivery.js';
import { observedCodeOrValueDetailed, splitEscapedCommaOrDetailed } from '../packages/core/src/repairs.js';
import { evalDataText } from '../packages/evals/src/fixture.js';
import { TASKS, parseM3bTaskFile } from '../packages/evals/src/tasks.js';
import {
  GENERATED_DOCS, G_HOST_EVIDENCE, QUERY_EVIDENCE_MEANINGS, QUERY_EVIDENCE_RULES, buildCompactProfilesDoc, buildHostProfilesDoc, buildQueryEvidenceDoc,
  buildSupportMatrixDoc, parseArguments, repairBehaviour, repairFor,
} from '../scripts/generate-m3b-docs.js';
import { hba1c, lab, output, patient, withGateway } from './s57-sdk-helpers.js';

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');
/** Registered test titles: `test('…'` / `t.test('…'` at the start of a non-comment line, across every test source. */
const registeredTitles = readdirSync(join(process.cwd(), 'tests'), { recursive: true }).map(String).filter(f => f.endsWith('.ts'))
  .flatMap(f => read(`tests/${f}`).split('\n').flatMap(line => { const m = /^\s*(?:await\s+)?(?:t\.)?test\(\s*'([^']+)'/.exec(line); return m ? [m[1]!] : []; }));
/** Top-level eval task ids, through the runner's own loaders (nested check ids are not tasks). */
const taskIds = new Set([...TASKS, ...parseM3bTaskFile(evalDataText('data/hapi-profile-tasks.json'))].map(t => t.id));
const resolvesToTest = (id: string) => registeredTitles.some(title => title.startsWith(`${id}: `));
/** The accepted qualification record of each evidenced profile. */
const QUALIFICATION_RECORDS: Readonly<Record<string, string>> = {
  'synthetic-fixture-r4-v1': 'docs/evidence/s6-profile-qualification.md',
  'hapi-r4-labs-v1': 'docs/evidence/g-backend-hapi-qualification-2026-10-23.md',
};

test('S7 every generated doc equals its regeneration byte for byte', () => {
  for (const [path, build] of Object.entries(GENERATED_DOCS)) assert.equal(read(path), build(), `${path} is stale: run node --import tsx scripts/generate-m3b-docs.ts`);
});

test('S7 the generator --check exits 0 on the committed docs', () => {
  const out = execFileSync(process.execPath, ['--import', 'tsx', 'scripts/generate-m3b-docs.ts', '--check'], { encoding: 'utf8' });
  assert.equal(out, `generate-m3b-docs: ${Object.keys(GENERATED_DOCS).length} files in sync\n`);
});

test('S7 --check fails and names stale files; malformed arguments and symlinked outputs refuse before any write', () => {
  const copy = mkdtempSync(join(tmpdir(), 'm3b-docs-'));
  const run = (args: string[], script = 'scripts/generate-m3b-docs.ts') => {
    try { execFileSync(process.execPath, ['--import', 'tsx', script, ...args], { stdio: 'pipe' }); return { code: 0, stderr: '' }; }
    catch (e) { const err = e as { status: number; stderr: Buffer }; return { code: err.status, stderr: String(err.stderr) }; }
  };
  try {
    mkdirSync(join(copy, 'docs'));
    for (const path of Object.keys(GENERATED_DOCS)) cpSync(join(process.cwd(), path), join(copy, path));
    assert.deepEqual(run(['--check', '--root', copy]), { code: 0, stderr: '' });
    writeFileSync(join(copy, 'docs/QUERY-REPAIR.md'), `${read('docs/QUERY-REPAIR.md')}edited by hand\n`);
    assert.deepEqual(run(['--check', '--root', copy]), { code: 1, stderr: 'generate-m3b-docs: out of sync with the code: docs/QUERY-REPAIR.md; regenerate.\n' });
    rmSync(join(copy, 'docs/HOST-PROFILES.md'));
    assert.equal(run(['--root', copy, '--check']).stderr, 'generate-m3b-docs: out of sync with the code: docs/HOST-PROFILES.md, docs/QUERY-REPAIR.md; regenerate.\n');
    for (const args of [['--chek', '--root', copy], ['--root', copy, 'stray'], ['--check', '--check', '--root', copy], ['--root'], ['--root', '--check']]) {
      assert.equal(run(args).code, 2, args.join(' '));
      assert.ok(!readdirSync(join(copy, 'docs')).includes('HOST-PROFILES.md'), `${args.join(' ')} wrote`);
    }
    symlinkSync(join(process.cwd(), 'scripts/generate-m3b-docs.ts'), join(copy, 'linked-generator.ts'));
    assert.equal(run(['--check', '--root', copy], join(copy, 'linked-generator.ts')).code, 1, 'a symlinked invocation still checks');
    const outside = join(copy, 'outside'); mkdirSync(outside);
    const linkedRoot = join(copy, 'linked-root'); mkdirSync(linkedRoot); symlinkSync(outside, join(linkedRoot, 'docs'));
    assert.equal(run(['--root', linkedRoot]).code, 2);
    assert.deepEqual(readdirSync(outside), [], 'nothing was written through the symlink');
  } finally { rmSync(copy, { recursive: true, force: true }); }
  assert.deepEqual(parseArguments(['--root', '/x', '--check']), { check: true, root: '/x' });
  assert.equal(parseArguments(['--check', 'x']), undefined);
});

test('S7 the docs are derived from the data: changing the matrix changes its doc', () => {
  const fewer = { ...supportMatrix, rows: supportMatrix.rows.filter(r => r.resource_type !== 'Condition') };
  const doc = buildSupportMatrixDoc(fewer as unknown as Parameters<typeof buildSupportMatrixDoc>[0]);
  assert.notEqual(doc, buildSupportMatrixDoc());
  assert.match(doc, /classifies 24 of the 147 resource types/);
  assert.match(doc, /14 patient-linked types and 10 conditional shared types/);
  assert.ok(!doc.includes('`Condition`'));
  assert.match(buildSupportMatrixDoc({ ...supportMatrix, clinical_sections: ['Labs'] } as unknown as Parameters<typeof buildSupportMatrixDoc>[0]), /M3b has 1 clinical section\./);
  const renamed = structuredClone(compactProfiles); renamed.profiles[0]!.kept_roots = ['status'];
  assert.match(buildCompactProfilesDoc(renamed), /stay whole[^.]*\): `status`\./);
});

test('S7 support matrix doc: 15 patient-linked and 10 conditional shared types, zero clinical sections, denied types named', () => {
  const doc = read('docs/SUPPORT-MATRIX.md');
  assert.equal(supportMatrix.rows.filter(r => r.policy_class === 'patient').length, 15);
  assert.equal(supportMatrix.rows.filter(r => r.policy_class === 'conditional_shared').length, 10);
  assert.equal(supportMatrix.clinical_sections.length, 0);
  assert.match(doc, /15 patient-linked types and 10 conditional shared types/);
  assert.match(doc, /These are resource types, not clinical sections: M3b has 0 clinical sections\./);
  assert.doesNotMatch(doc, /\b25 (clinical )?sections\b/i);
  for (const type of ['Specimen', 'CarePlan', 'Goal']) assert.ok(supportMatrix.decided_against.some(e => e.resource_type === type) && doc.includes(`| \`${type}\` |`), type);
  assert.equal(read('docs/support-matrix.json'), `${JSON.stringify(supportMatrix, null, 2)}\n`);
});

test('S7 every support-matrix test label is the title prefix of a registered test in tests/support-matrix.test.ts', () => {
  const labels = new Set(supportMatrix.rows.flatMap(r => r.test_ids ?? []));
  assert.ok(labels.size > 0);
  const titles = read('tests/support-matrix.test.ts').split('\n').flatMap(line => { const m = /^test\(\s*'([^']+)'/.exec(line); return m ? [m[1]!] : []; });
  for (const label of labels) assert.equal(titles.filter(t => t.startsWith(`${label}: `)).length, 1, label);
});

test('S7 query evidence doc describes exactly the schema\'s evidence labels, each with a checkable rule', () => {
  const labels = coverageV2Schema.shape.query_evidence.options;
  assert.deepEqual(Object.keys(QUERY_EVIDENCE_MEANINGS).sort(), [...labels].sort());
  assert.deepEqual(Object.keys(QUERY_EVIDENCE_RULES).sort(), [...labels].sort());
  const doc = read('docs/QUERY-EVIDENCE.md');
  for (const label of labels) assert.ok(doc.includes(`| \`${label}\` | ${QUERY_EVIDENCE_MEANINGS[label]} |`), label);
  assert.match(buildQueryEvidenceDoc(undefined, [...labels, 'invented_label']), /\| `invented_label` \| UNDESCRIBED \|/);
});

test('S7 each evidence label\'s documented rule holds on real gateway responses that carry it', async () => {
  const seen = new Map<string, number>();
  const check = (tool: ToolName, env: GatewayEnvelope02, expected: string) => {
    assert.equal(env.error, undefined, `${tool} ${expected}: ${env.error?.code}`);
    assert.equal(env.coverage.query_evidence, expected, tool);
    assert.ok(QUERY_EVIDENCE_RULES[expected]!(env.coverage, tool), `${expected} rule on ${tool}`);
    seen.set(expected, (seen.get(expected) ?? 0) + 1);
    return env;
  };
  await withGateway({}, async gateway => {
    check('fhir_capabilities', await gateway.execute('fhir_capabilities', { topic: 'server' }), 'metadata_snapshot');
    check('fhir_read', await gateway.execute('fhir_read', { resource_type: 'Observation', id: 'synthetic-lab', output }), 'exact_id_and_subject_linkage');
    check('fhir_search', await gateway.execute('fhir_search', { resource_type: 'Observation', params: [], output }), 'exact_id_and_subject_linkage');
    const generic = check('fhir_search', await gateway.execute('fhir_search', { resource_type: 'Observation', params: [hba1c[0]!], output }), 'declared_and_self_link_only');
    const handle = generic.result?.handle;
    assert.ok(handle);
    check('fhir_result', await gateway.execute('fhir_result', { handle, action: 'inspect', output }), 'retained_snapshot');
  });
  await withGateway({ profile: true }, async gateway => {
    const proved = check('fhir_search', await gateway.execute('fhir_search', { resource_type: 'Observation', params: hba1c, output }), 'tested_adapter');
    assert.ok(proved.coverage.sort, 'ordering is reported separately');
  });
  await withGateway({}, async gateway => {
    const absent = await gateway.execute('fhir_read', { resource_type: 'Observation', id: 'absent-synthetic-id', output });
    assert.equal(absent.error?.code, 'NOT_FOUND');
    assert.equal(absent.coverage.query_evidence, 'none');
    assert.ok(QUERY_EVIDENCE_RULES.none!(absent.coverage, 'fhir_read'));
    seen.set('none', 1);
  });
  assert.deepEqual([...seen.keys()].sort(), ['declared_and_self_link_only', 'exact_id_and_subject_linkage', 'metadata_snapshot', 'none', 'retained_snapshot', 'tested_adapter']);
});

test('S7 the metadata-paging and continuation-size sentences hold on real responses', async () => {
  await withGateway({ pages: [[lab('size-a'), lab('size-b')]] }, async gateway => {
    const server = await gateway.execute('fhir_capabilities', { topic: 'server' });
    assert.equal(server.data.patient_id, patient);
    assert.deepEqual((server.data.resources as { type: string }[]).map(r => r.type), ['Patient', 'Observation', 'Organization'], 'required, then executable, in that order');
    for (const key of ['snapshot_revision', 'captured_at', 'expires_at']) assert.equal(typeof server.data[key], 'string', key);
    const first = await gateway.execute('fhir_search', { resource_type: 'Observation', params: [], page_size: 1, output });
    assert.equal((first.data.resources as unknown[]).length, 1);
    const next = await gateway.execute('fhir_page', { cursor: first.pagination!.next_cursor! });
    assert.equal(next.error, undefined);
    assert.equal(next.pagination?.requested_page_size, 1, 'the continuation inherits the search page size');
    assert.equal((next.data.resources as unknown[]).length, 1);
  });
  const doc = read('docs/QUERY-EVIDENCE.md');
  assert.ok(doc.includes(`> ${WARNING_MESSAGES.METADATA_BYTE_LIMIT}`));
  assert.ok(doc.includes('it has no page-size input'));
});

test('S7 every search-profile test id resolves to a top-level eval task or a registered test, and recorded evidence matches its qualification record', () => {
  const ids = new Set(searchProfiles.profiles.flatMap(p => [...p.test_ids, ...[...p.tested_filters, ...p.tested_sorts].flatMap(f => f.test_ids)]));
  assert.ok(ids.size > 0);
  for (const id of ids) assert.ok(taskIds.has(id) || resolvesToTest(id), id);
  assert.ok(!taskIds.has('members-0') && !resolvesToTest('comment-only-proof'), 'nested check ids and comments do not resolve');
  const doc = read('docs/QUERY-EVIDENCE.md');
  for (const p of searchProfiles.profiles) {
    assert.ok(doc.includes(`### \`${p.id}\` (version ${p.version})`), p.id);
    if (!p.evidence) continue;
    const record = read(QUALIFICATION_RECORDS[p.id]!);
    for (const value of [p.evidence.report_sha256, p.evidence.capability_revision, p.evidence.tasks_sha256]) assert.ok(record.includes(value), `${p.id} ${value}`);
    assert.ok(doc.includes(p.evidence.report_sha256) && doc.includes(p.evidence.capability_revision), `${p.id} evidence`);
  }
});

test('S7 query repair doc lists every fault code once with the repair the helper actually returns, and NOT_FOUND carries none', () => {
  const doc = read('docs/QUERY-REPAIR.md');
  assert.equal(repairFor('NOT_FOUND'), undefined);
  for (const c of FAULT_CODES) {
    const rows = doc.split('\n').filter(l => l.startsWith(`| \`${c}\` |`));
    assert.equal(rows.length, 1, c);
    const r = repairFor(c);
    if (!r) { assert.ok(rows[0]!.includes('| none |'), c); continue; }
    assert.ok(rows[0]!.includes(`\`${r.action}\``), `${c} action`);
    if (r.tool) assert.ok(rows[0]!.includes(`via \`${r.tool}\``), `${c} tool`);
  }
  assert.ok(doc.includes(`> ${WARNING_MESSAGES.NO_MATCHES}`));
});

test('S7 the scan and OR-combination figures in the repair doc are the helpers\' measured behaviour, and URL encoding is left to the gateway', () => {
  const doc = read('docs/QUERY-REPAIR.md');
  const b = repairBehaviour();
  assert.ok(doc.includes(`\`page_size: ${b.scan.page_size}\``) && doc.includes(`at most ${b.scan.max_pages} clinical pages and ${b.scan.max_calls} MCP calls`));
  const many = Array.from({ length: 100 }, (_, i) => ({ code: `k${i}` }));
  const combined = observedCodeOrValueDetailed(many).value.split(',').length;
  const split = splitEscapedCommaOrDetailed(Array.from({ length: 100 }, (_, i) => `y${i}`).join(',')).parts.length;
  assert.ok(doc.includes(`At most ${combined} pairs are combined`) && doc.includes(`at most ${split} alternatives`));
  assert.match(doc, /Pass that string unchanged as the `params\[\]\.value` of `fhir_search`; the gateway URL-encodes it once, so a client must not encode it\./);
  assert.doesNotMatch(doc, /URL-encode the value/i);
  assert.match(doc, /a truncated result must be refused/);
});

test('S7 compact profiles doc names only registered recipe ids, and its prose figures agree with the numeric fields', () => {
  const registered = [...Object.values(RECIPE_IDS), LAB_EVIDENCE_RECIPE_ID] as string[];
  for (const id of [...compactProfiles.integrated_recipes, ...compactProfiles.helper_history_recipes.map(h => h.recipe_id)]) assert.ok(registered.includes(id), id);
  assert.ok(compactProfiles.integrated_recipes.includes(LAB_EVIDENCE_RECIPE_ID), 'the lab recipe is the active Observation recipe');
  assert.ok(!compactProfiles.integrated_recipes.includes(RECIPE_IDS.Observation), 'the pre-lab Observation recipe is helper/history only');
  assert.deepEqual(compactProfiles.profiles.map(p => p.recipe_id), [LAB_EVIDENCE_RECIPE_ID]);
  const doc = read('docs/COMPACT-PROFILES.md');
  const named = new Set(doc.match(/r4-[a-z0-9.-]+\/[A-Za-z]+\.[a-z0-9.]+/g) ?? []);
  for (const id of named) assert.ok(Object.values(RECIPE_IDS).includes(id as never) || id === LAB_EVIDENCE_RECIPE_ID, id);
  const s = compactProfiles.profiles[0]!.efficiency.simulated_slim_text_20lab;
  const r = compactProfiles.profiles[0]!.development.expected_ratio_range;
  for (const prose of [s.slim_lane_status, r.slim_lane_simulated]) assert.ok(prose.includes(String(s.slim_lane_compact_over_fhir)), prose);
  assert.ok(doc.includes(`simulated slim-lane compact/fhir ${s.slim_lane_compact_over_fhir}`));
});

test('S7 host profiles: the JSON registry equals the runtime registry, every entry field is rendered, and the G-HOST note matches its record', () => {
  assert.deepEqual(hostProfiles.entries, HOST_PROFILE_REGISTRY);
  const entry: HostProfileEntry = { id: 'synthetic-host-cell', version: '3', host: { name: 'Synthetic Host', version: '9.9', client_stack: 'synthetic-sdk', client_stack_version: '1.2' },
    era: 'legacy', transport: 'stdio', workflow: 'recent-labs-v1', delivery_profile: 'structured-evidence-v1', verification: 'verified',
    trace_sha256: 'a'.repeat(64), model_input_sha256: 'b'.repeat(64), tests: ['synthetic-host-test'], checked_at: '2026-10-24T00:00:00Z' };
  const doc = buildHostProfilesDoc({ ...hostProfiles, entries: [entry] });
  for (const value of ['synthetic-host-cell', 'Synthetic Host 9.9', 'synthetic-sdk 1.2', 'legacy', 'stdio', 'structured-evidence-v1', 'verified', 'a'.repeat(64), 'b'.repeat(64), 'synthetic-host-test', '2026-10-24T00:00:00Z'])
    assert.ok(doc.includes(value), value);
  const { model_input_sha256: _m, tests: _t, ...partial } = entry;
  assert.notEqual(buildHostProfilesDoc({ ...hostProfiles, entries: [partial] }), doc, 'missing evidence is visible');
  const record = read(G_HOST_EVIDENCE.path);
  for (const value of [`${G_HOST_EVIDENCE.host} ${G_HOST_EVIDENCE.version}`, G_HOST_EVIDENCE.era, G_HOST_EVIDENCE.gateway, G_HOST_EVIDENCE.commit, ...G_HOST_EVIDENCE.backends])
    assert.ok(record.includes(value), value);
});
