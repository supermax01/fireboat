import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { GatewayEnvelope } from '../packages/core/src/index.js';
import { packageTasks, seedFacts } from '../packages/evals/src/package-tasks.js';
import { QuickstartFault, sha256 } from '../examples/quickstart/manifest.js';
import { setupOracle } from '../examples/quickstart/setup-oracle.js';
import { validateHelperAssets } from '../examples/quickstart/prepare.js';
import { atomicPrivateWrite, jsonBytes, readRunReceipt } from '../examples/quickstart/run-state.js';
import { callInvariants, coverageLimitations, judgeTask, orderLimitations, runTaskSteps, validPacket, verify, VERIFY_LIMITS, responseValid, gatewayArtifact, type GatewaySession, type RecordedCall, type TaskCall } from '../examples/quickstart/verify.js';
import type { PackageTask } from '../packages/evals/src/package-tasks.js';

type Rec = Record<string, unknown>;
const fixture = (name: string) => readFile(new URL(`../packages/evals/fixtures/quickstart/${name}`, import.meta.url), 'utf8');
const resources = await fixture('resources.ndjson');
const ASSETS = { manifest: await readFile(new URL('../examples/quickstart/seed-manifest.json', import.meta.url)), compose: await readFile(new URL('../compose.quickstart.yaml', import.meta.url)),
  resources: Buffer.from(resources) };
const seedManifest = JSON.parse(await fixture('seed-manifest.json')) as { patient: string; resources: { type: string; id: string }[] };
const patientId = seedManifest.patient.split('/')[1]!;
const versions = new Map(seedManifest.resources.map(r => [`${r.type}/${r.id}`, '1']));
const tasks = packageTasks(seedFacts(resources, seedManifest.patient, versions), 'qs-hapi');
const [latest, , drain] = tasks as [typeof tasks[0], typeof tasks[0], typeof tasks[0]];
const MANIFEST = sha256(ASSETS.manifest);
const faultCode = (code: string) => (e: unknown) => e instanceof QuickstartFault && e.code === code;
const envelope = (extra: Rec = {}): GatewayEnvelope => ({ schema_version: '0.3', source: { alias: 'qs-hapi' }, context: { handle: 'ctx' }, data: { resources: [] }, provenance: [],
  coverage: { state: 'unknown', scope: 'page', reasons: [] }, transform: { withheld_payloads: [] }, warnings: [], budget: { bytes_returned: 1 }, ...extra }) as unknown as GatewayEnvelope;
const recorded = (env: GatewayEnvelope, requestId: number): RecordedCall => ({ requestId, envelope: env, rawText: JSON.stringify({ structuredContent: env }), work: { metadata: 0, auth: 0, clinical: 1 }, resultBytes: 1, frameBytes: 1 });
/** A scripted session: `respond` answers each call; every input is kept. */
function scripted(respond: (tool: string, input: Rec, n: number) => GatewayEnvelope): GatewaySession & { inputs: [string, Rec][]; closed: boolean } {
  const inputs: [string, Rec][] = [];
  const session = { inputs, closed: false,
    async call(tool: string, input: Rec) { inputs.push([tool, input]); return recorded(respond(tool, input, inputs.length), inputs.length); },
    async close() { session.closed = true; } };
  return session;
}

/** A run directory as a completed prepare leaves it (receipt, attempt record, packet), for the checked-in helper assets. */
async function runDirectory(edit: (receipt: Rec, packet: Rec, config: Rec) => void = () => {}): Promise<{ dir: string; config: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'fireboat-verify-')), run = join(dir, 'run');
  await mkdir(run, { mode: 0o700 });
  const runId = 'a'.repeat(16), creationNonce = 'b'.repeat(64), composeSha256 = JSON.parse(ASSETS.manifest.toString('utf8')).composeSha256, containerId = 'e'.repeat(64);
  const instance = { schema: 1, runId, project: `fireboat-qs-${runId}`, service: 'hapi', containerId, creationNonce, createdAt: '2026-10-24T00:00:00.000Z', composeSha256, volumes: [] };
  const receipt: Rec = { schema: 'fireboat-quickstart-run/1', runId, project: `fireboat-qs-${runId}`, creationNonce, startedAt: '2026-10-24T00:00:00.000Z', phase: 'complete',
    manifestSha256: MANIFEST, composeSha256, containerId, attemptSha256: '', packetSha256: '', instance };
  const attempt = jsonBytes({ ...receipt, phase: 'seeding', attemptSha256: null, packetSha256: null });
  receipt.attemptSha256 = sha256(attempt);
  const { manifest, puts } = validateHelperAssets(ASSETS);
  const observed = await setupOracle(manifest, puts, { read: async target => { const body = puts.find(p => p.target === target)!.body.toString(); return Buffer.from(body.replace('{', '{\"meta\":{\"versionId\":\"1\"},')); },
    count: async type => manifest.resources.filter(r => r.type === type).length });
  const packet: Rec = { schema: 'fireboat-quickstart-setup/1', runId, creationNonce, receiptSha256: receipt.attemptSha256, manifestSha256: MANIFEST,
    instanceSha256: sha256(jsonBytes(instance)), resources: observed };
  const config: Rec = { mode: 'synthetic', source: { alias: 'qs-hapi', baseUrl: 'http://127.0.0.1:18080/fhir' }, patientId };
  edit(receipt, packet, config);
  const packetBytes = jsonBytes(packet);
  if (receipt.packetSha256 === '') receipt.packetSha256 = sha256(packetBytes);
  await atomicPrivateWrite(join(run, 'attempt.json'), attempt);
  await atomicPrivateWrite(join(run, 'setup-packet.json'), packetBytes);
  await atomicPrivateWrite(join(run, 'receipt.json'), jsonBytes(receipt));
  await writeFile(join(dir, 'gateway.config.json'), JSON.stringify(config));
  await mkdir(join(dir, 'gateway'));
  await writeFile(join(dir, 'gateway/package.json'), '{"type":"module","dependencies":{}}');
  await writeFile(join(dir, 'gateway/cli.js'), '// the installed gateway CLI\n');
  return { dir, config: join(dir, 'gateway.config.json') };
}
const launch = (dir: string, config: string) => ({ runDirectory: join(dir, 'run'), node: '/usr/bin/node', cli: join(dir, 'gateway/cli.js'), config, assets: ASSETS });
const DOCTOR = 'doctor: ready\ngateway: fireboat 0.2.0-alpha.1 schema=0.3 catalog=m3b-catalog/3\nruntime: node=24.22.0 platform=darwin arch=arm64 lossless=ok cell=recorded\n'
  + 'source: alias=qs-hapi loopback=literal-ok auth=none classification=operator-declared-synthetic\n';
const ready = async () => ({ exitCode: 0, stdout: DOCTOR });

test('quickstart verify packet versions: malformed non-empty strings refuse with valid bindings and numeric inventories, before any launch', async () => {
  const { dir, config } = await runDirectory();
  try {
    const run = join(dir, 'run'), receipt = await readRunReceipt(run);
    const packet = JSON.parse(await readFile(join(run, 'setup-packet.json'), 'utf8')) as Rec;
    const { puts } = validateHelperAssets(ASSETS);
    assert.equal(validPacket(packet, receipt, MANIFEST, puts), true, 'the completed prepare is a positive control');
    const rows = packet.resources as Rec[], row = rows[0]!;
    for (const version of ['v2.3-4', 'a'.repeat(64)]) {
      row.versionId = version;
      assert.equal(validPacket(packet, receipt, MANIFEST, puts), true, 'valid opaque versions need not be numeric');
    }
    // Change only a string version: the row shape, target, raw digest and exact approved numbers stay valid.
    row.versionId = 'bad/version';
    const packetBytes = jsonBytes(packet);
    await atomicPrivateWrite(join(run, 'setup-packet.json'), packetBytes);
    await atomicPrivateWrite(join(run, 'receipt.json'), jsonBytes({ ...receipt, packetSha256: sha256(packetBytes) }));
    const boundReceipt = await readRunReceipt(run);
    assert.equal(boundReceipt.packetSha256, sha256(await readFile(join(run, 'setup-packet.json'))));
    assert.equal(validPacket(packet, boundReceipt, MANIFEST, puts), false, 'a bound packet still requires a legal version');
    let doctors = 0, sessions = 0;
    await assert.rejects(verify(launch(dir, config), {
      doctor: async () => { doctors++; return ready(); },
      openSession: async () => { sessions++; throw new Error('unexpected session'); },
    }), faultCode('VERIFY_RUN_INVALID'));
    assert.equal(doctors, 0); assert.equal(sessions, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('quickstart verify: a run is verified only as a completed prepare of these helper assets, its closed packet bound to the receipt and attempt', async () => {
  const targets = (p: Rec) => p.resources as Rec[];
  for (const [label, edit] of [
    ['an incomplete run', (r: Rec) => { r.phase = 'failed'; }],
    ['a packet the receipt does not bind', (r: Rec) => { r.packetSha256 = '9'.repeat(64); }],
    ['an attempt record the receipt does not bind', (r: Rec) => { r.attemptSha256 = '7'.repeat(64); }],
    ['a packet of another run', (_: Rec, p: Rec) => { p.runId = '0'.repeat(16); }],
    ['a packet of another manifest', (_: Rec, p: Rec) => { p.manifestSha256 = '8'.repeat(64); }],
    ['another packet schema', (_: Rec, p: Rec) => { p.schema = 'fireboat-quickstart-setup/2'; }],
    ['a packet with an unknown field', (_: Rec, p: Rec) => { p.extra = true; }],
    ['a packet bound to another attempt', (_: Rec, p: Rec) => { p.receiptSha256 = '6'.repeat(64); }],
    ['a packet bound to another instance', (_: Rec, p: Rec) => { p.instanceSha256 = '5'.repeat(64); }],
    ['a duplicated target', (_: Rec, p: Rec) => { targets(p).push({ ...targets(p)[0]! }); }],
    ['a receipt of another manifest', (r: Rec) => { r.manifestSha256 = '8'.repeat(64); }],
    ['a missing target', (_: Rec, p: Rec) => { targets(p).pop(); }],
    ['an unlisted target', (_: Rec, p: Rec) => { targets(p)[0] = { ...targets(p)[0]!, target: 'Observation/unlisted' }; }],
    ['empty numeric inventories', (_: Rec, p: Rec) => { for (const row of targets(p)) row.numbers = []; }],
    ['invented numeric inventory', (_: Rec, p: Rec) => { targets(p)[0]!.numbers = [{ pointer: '/valueQuantity/value', lexeme: '777.00' }, { pointer: '/valueQuantity/value', lexeme: 'not-a-number' }, { pointer: 'not-a-pointer', lexeme: '00' }]; }],
    ['a non-record numeric row', (_: Rec, p: Rec) => { targets(p)[0]!.numbers = [null]; }],
    ['an ill-typed numeric row', (_: Rec, p: Rec) => { targets(p)[0]!.numbers = [{ pointer: 17, lexeme: null }]; }],
    ['an extra numeric row field', (_: Rec, p: Rec) => { const row = targets(p).find(r => (r.numbers as Rec[]).length)!; (row.numbers as Rec[])[0]!.extra = true; }],
    ['reordered numeric pointers', (_: Rec, p: Rec) => { const row = targets(p).find(r => (r.numbers as Rec[]).length > 1)!; (row.numbers as Rec[]).reverse(); }],
    ['a malformed version', (_: Rec, p: Rec) => { targets(p)[0] = { ...targets(p)[0]!, versionId: '' }; }],
    ['a malformed stored digest', (_: Rec, p: Rec) => { targets(p)[0] = { ...targets(p)[0]!, rawSha256: 'x' }; }],
    ['a row with an unknown field', (_: Rec, p: Rec) => { targets(p)[0] = { ...targets(p)[0]!, body: '{}' }; }],
  ] as [string, (r: Rec, p: Rec) => void][]) {
    const { dir, config } = await runDirectory(edit);
    try { await assert.rejects(verify(launch(dir, config), { openSession: async () => { throw new Error('no session'); }, doctor: ready }), faultCode('VERIFY_RUN_INVALID'), label); }
    finally { await rm(dir, { recursive: true, force: true }); }
  }
  // The assets in use are the run's: another manifest, and a seed changed after prepare (7.00 -> 777.00), refuse before any expectation is derived.
  const { dir, config } = await runDirectory();
  try {
    const attempt = join(dir, 'run', 'attempt.json'), original = await readFile(attempt);
    await atomicPrivateWrite(attempt, Buffer.from(original.toString('utf8').replace('"seeding"', '"preparing"')));
    await assert.rejects(verify(launch(dir, config), { openSession: async () => { throw new Error('no session'); }, doctor: ready }), faultCode('VERIFY_RUN_INVALID'), 'an attempt record changed after the receipt bound it');
    await atomicPrivateWrite(attempt, original);
    const other = { ...ASSETS, manifest: Buffer.from(`${ASSETS.manifest.toString('utf8').trimEnd()} \n`) };
    await assert.rejects(verify({ ...launch(dir, config), assets: other }, { openSession: async () => { throw new Error('no session'); }, doctor: ready }), faultCode('VERIFY_RUN_INVALID'));
    const changed = { ...ASSETS, resources: Buffer.from(resources.replace('"value":7.00,', '"value":777.00,')) };
    assert.notEqual(changed.resources.toString(), resources);
    await assert.rejects(verify({ ...launch(dir, config), assets: changed }, { openSession: async () => { throw new Error('no session'); }, doctor: ready }), faultCode('SEED_NOT_LISTED'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('quickstart verify: the attempt hash binds exact bytes even when JSON content is unchanged', async () => {
  const { dir, config } = await runDirectory();
  try {
    const run = join(dir, 'run'), attempt = join(run, 'attempt.json'), original = await readFile(attempt), receipt = await readRunReceipt(run);
    const reformatted = Buffer.from(`${JSON.stringify(JSON.parse(original.toString('utf8')))}\n`);
    assert.deepEqual(JSON.parse(reformatted.toString('utf8')), JSON.parse(original.toString('utf8')), 'reformatting preserves the complete attempt content');
    assert.equal(sha256(original), receipt.attemptSha256, 'prepare bound the original bytes');
    assert.notEqual(sha256(reformatted), receipt.attemptSha256, 'equal JSON content has different bytes');
    let doctors = 0, sessions = 0;
    const dependencies = {
      doctor: async () => { doctors++; return { exitCode: 1, stdout: 'doctor: not-ready\n' }; },
      openSession: async () => { sessions++; throw new Error('unexpected session'); },
    };
    await assert.rejects(verify(launch(dir, config), dependencies), faultCode('VERIFY_DOCTOR'), 'the original attempt passes run validation');
    assert.equal(doctors, 1); doctors = 0;
    // The semantic comparison still passes; only the exact-byte binding can refuse this rewrite.
    await atomicPrivateWrite(attempt, reformatted);
    await assert.rejects(verify(launch(dir, config), dependencies), faultCode('VERIFY_RUN_INVALID'), 'an equivalent attempt still must match its bound bytes');
    assert.equal(doctors, 0); assert.equal(sessions, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('quickstart verify: the config must name the manifest target and the seed\'s natural patient; one private snapshot serves the doctor and every session', async () => {
  for (const [label, edit] of [
    ['another port', (_: Rec, __: Rec, c: Rec) => { c.source = { alias: 'qs-hapi', baseUrl: 'http://127.0.0.1:18091/fhir' }; }],
    ['another patient', (_: Rec, __: Rec, c: Rec) => { c.patientId = 'qs-edge-other-patient'; }],
    ['a non-synthetic mode', (_: Rec, __: Rec, c: Rec) => { c.mode = 'clinical'; }],
    ['an unsafe alias', (_: Rec, __: Rec, c: Rec) => { c.source = { alias: 'qs hapi/../x', baseUrl: 'http://127.0.0.1:18080/fhir' }; }],
  ] as [string, (r: Rec, p: Rec, c: Rec) => void][]) {
    const { dir, config } = await runDirectory(edit);
    try { await assert.rejects(verify(launch(dir, config), { openSession: async () => { throw new Error('no session'); }, doctor: ready }), faultCode('VERIFY_CONFIG_INVALID'), label); }
    finally { await rm(dir, { recursive: true, force: true }); }
  }
  const { dir, config } = await runDirectory();
  try {
    const doctorConfigs: string[] = [], sessionConfigs: string[] = [];
    const report = await verify(launch(dir, config), { doctor: async l => { doctorConfigs.push(l.config); await writeFile(config, '{"mode":"changed"}'); return ready(); },
      wait: async () => {}, eras: ['modern'], openSession: async l => { sessionConfigs.push(l.config); return scripted((_tool, _input, n) => envelope(n === 1 ? { result: { handle: 'h' } } : {})); } });
    const out = join(dir, 'run', report.verificationId);
    const snapshot = join(out, 'verify-gateway.config.json');
    assert.deepEqual(doctorConfigs, [snapshot]);
    assert.deepEqual([...new Set(sessionConfigs)].sort(), [join(out, 'verify-package-drain-reproject.config.json'), join(out, 'verify-control.config.json'), snapshot].sort());
    assert.equal((await stat(snapshot)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await readFile(snapshot, 'utf8')).patientId, patientId, 'the snapshot keeps the bytes read once, whatever the operator file becomes');
    assert.deepEqual({ ...report.launch, artifactSha256: undefined, artifactFiles: undefined, configs: undefined }, { artifactSha256: undefined, artifactFiles: undefined, configs: undefined, cliSha256: sha256('// the installed gateway CLI\n'), configSha256: sha256(JSON.stringify({ mode: 'synthetic', source: { alias: 'qs-hapi', baseUrl: 'http://127.0.0.1:18080/fhir' }, patientId })),
      gateway: 'fireboat 0.2.0-alpha.1 schema=0.3 catalog=m3b-catalog/3', runtime: 'node=24.22.0 platform=darwin arch=arm64 lossless=ok cell=recorded' });
    assert.ok(report.controls.every(control => control.status === 'fail'), 'malformed discovery controls cannot pass');
    assert.equal(report.instrumentation, 'request-observer'); assert.equal(report.manifestSha256, MANIFEST);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('quickstart verify: the doctor must report ready before any task runs', async () => {
  const { dir, config } = await runDirectory();
  try {
    let sessions = 0;
    for (const doctor of [async () => ({ exitCode: 1, stdout: 'doctor: not-ready\n' }), async () => ({ exitCode: 0, stdout: 'doctor: fault\n' }),
      async () => ({ exitCode: 0, stdout: DOCTOR.replace('gateway: fireboat', 'gateway: other') }), async () => ({ exitCode: 0, stdout: DOCTOR.replace('alias=qs-hapi', 'alias=other') }),
      async () => ({ exitCode: 0, stdout: DOCTOR.replace(/runtime: .*\n/, '') }), async () => ({ exitCode: 0, stdout: DOCTOR.replace('doctor: ready', 'doctor: not-ready') }),
      async () => ({ exitCode: 1, stdout: DOCTOR })])
      await assert.rejects(verify(launch(dir, config), { openSession: async () => { sessions++; return scripted(() => envelope()); }, doctor }), faultCode('VERIFY_DOCTOR'));
    assert.equal(sessions, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('quickstart verify: steps reuse earlier handles, wait out the TTL, drain within bounds and use the arm\'s view', async () => {
  let page = 0;
  const session = scripted((tool, _input, n) => n === 1 ? envelope({ result: { handle: 'res_synthetic' }, pagination: { next_cursor: 'cur_1' } })
    : tool === 'fhir_page' ? envelope(++page < 2 ? { result: { handle: 'res_second' }, pagination: { next_cursor: `cur_${page + 1}` } } : { result: { handle: 'res_last' } }) : envelope());
  const waits: number[] = [];
  const calls = await runTaskSteps(drain, 'compact', session, () => {}, async ms => { waits.push(ms); });
  assert.deepEqual(session.inputs.map(([tool]) => tool), ['fhir_search', 'fhir_page', 'fhir_page', 'fhir_result', 'fhir_result', 'fhir_result', 'fhir_result']);
  assert.deepEqual(session.inputs[1]![1], { cursor: 'cur_1', output: { format: 'compact', max_bytes: 65536 } });
  assert.ok(session.inputs.slice(3).every(([, input]) => input.handle === 'res_synthetic'), 'every retained-result step uses step 0\'s handle');
  assert.deepEqual(waits, [5500], 'the expiry step waits past the 5 s TTL');
  assert.deepEqual(calls.map(c => c.step), [0, 0, 0, 1, 2, 3, 4]);
  assert.ok(calls.every(c => c.resourceType === 'Observation'));
  const endless = scripted(tool => envelope(tool === 'fhir_search' || tool === 'fhir_page' ? { pagination: { next_cursor: 'again' }, result: { handle: 'h' } } : {}));
  await assert.rejects(runTaskSteps(drain, 'fhir', { call: async (tool, input) => { if (endless.inputs.length > VERIFY_LIMITS.drainPages + 5) throw new Error('unbounded drain'); return endless.call(tool, input); }, close: async () => {} },
    () => {}, async () => {}), faultCode('VERIFY_DRAIN_LIMIT'));
  const handleless = scripted(() => envelope());
  await assert.rejects(runTaskSteps(drain, 'fhir', handleless, () => {}, async () => {}), faultCode('VERIFY_HANDLE_MISSING'));
  const selected = scripted(() => envelope());
  await runTaskSteps(latest, 'selected', selected, () => {});
  assert.deepEqual(selected.inputs[3]![1].output, { format: 'fhir', fields: ['status', 'code', 'effectiveDateTime', 'valueQuantity'], max_bytes: 24576 });
  assert.deepEqual(selected.inputs[0]![1].output, { format: 'fhir', max_bytes: 24576 }, 'no fields on capabilities');
});

test('quickstart verify: the latest result is reported unverified unless an adapter verified the order, and failing checks fail the run', () => {
  const sortedCall = (order: string): TaskCall[] => [{ step: 3, envelope: envelope({ coverage: { state: 'unknown', scope: 'page', reasons: [], sort: { requested: ['-date'], effective: null, order } } }), work: { metadata: 0, auth: 0, clinical: 1 }, resultBytes: 1, frameBytes: 1 }];
  assert.deepEqual(orderLimitations(latest, sortedCall('requested_unverified')), ['LATEST_UNVERIFIED']);
  assert.deepEqual(orderLimitations(latest, []), ['LATEST_UNVERIFIED'], 'no evidence is no verification');
  assert.deepEqual(orderLimitations(latest, sortedCall('verified_by_adapter')), []);
  assert.deepEqual(orderLimitations(drain, []), [], 'unsorted tasks claim no order');
  const covered = (coverage: Rec): TaskCall => ({ step: 0, envelope: envelope({ coverage: { state: 'partial', scope: 'page', reasons: [], ...coverage } }), work: { metadata: 0, auth: 0, clinical: 1 }, resultBytes: 1, frameBytes: 1 });
  assert.deepEqual(coverageLimitations([covered({ query_evidence: 'unverified_continuation' }), covered({ reasons: ['MORE_PAGES', 'FILTER_EXECUTION_UNVERIFIED'] })]),
    ['CONTINUATION_UNVERIFIED', 'FILTER_UNVERIFIED'], 'the gateway\'s own unverified coverage is carried into the run');
  assert.deepEqual(coverageLimitations([covered({ query_evidence: 'metadata_snapshot' })]), []);
  const { run } = judgeTask(latest, 'fhir', sortedCall('requested_unverified'));
  assert.equal(run.status, 'fail');
  const continued = judgeTask(latest, 'fhir', [...sortedCall('requested_unverified'), { ...sortedCall('requested_unverified')[0]!, envelope: envelope({ coverage: { state: 'partial', scope: 'page', reasons: [], query_evidence: 'unverified_continuation' } }) }]);
  assert.deepEqual(continued.run.limitations, ['CONTINUATION_UNVERIFIED', 'LATEST_UNVERIFIED'], 'the run carries the gateway\'s unverified continuation too');
  assert.ok(run.failing.includes('hba1c-membership') && run.checks.failed === run.failing.length && run.checks.passed >= 1, 'the matching sort check passes, the rest fail');
});

test('quickstart verify: 18 task-arm runs, private evidence and a summary of statuses, counts and hashes only', async () => {
  const { dir, config } = await runDirectory();
  try {
    const opened: Rec[] = [];
    const report = await verify(launch(dir, config), { doctor: ready, wait: async () => {},
      openSession: async options => { opened.push(options); return scripted((tool, _input, n) => envelope(n === 1 ? { result: { handle: 'h' } } : {})); } });
    assert.equal(report.runs.length, 18);
    assert.equal(report.passed + report.failed, 18);
    assert.ok(report.runs.every(r => r.status === 'fail'), 'empty envelopes satisfy no task');
    assert.ok(report.runs.every(r => r.failing.includes('invariant:frames')), 'injected sessions without full frames cannot establish complete evidence');
    assert.deepEqual([...new Set(opened.map(o => o.era))], ['modern', 'legacy']);
    assert.ok(opened.filter(o => String(o.config).endsWith('verify-package-drain-reproject.config.json')).length === 6, 'the drain task runs on its derived TTL config');
    const out = join(dir, 'run', report.verificationId);
    const derived = JSON.parse(await readFile(join(out, 'verify-package-drain-reproject.config.json'), 'utf8')) as Rec;
    assert.deepEqual(derived.limits, { ttlMs: 5000 });
    for (const name of ['verify-evidence.ndjson', 'verify-report.json']) assert.equal((await stat(join(out, name))).mode & 0o777, 0o600, name);
    const evidence = await readFile(join(out, 'verify-evidence.ndjson'));
    assert.equal(report.evidenceSha256, sha256(evidence));
    const summary = JSON.stringify(report);
    assert.ok(!summary.includes(patientId) && !summary.includes('qs-edge') && !summary.includes(dir), 'no patient, resource id or path in the summary');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('quickstart verify CLI: absolute flags only, and a fixed summary line whose exit code follows the runs', async () => {
  const { runQuickstart } = await import('../examples/quickstart/main.js');
  const report = (failed: number) => ({ schema: 'fireboat-quickstart-verify/1' as const, runId: 'a'.repeat(16), verificationId: 'verify-abcdef', controls: [], manifestSha256: 'd'.repeat(64), packetSha256: 'b'.repeat(64), doctor: 'ready' as const,
    launch: { artifactSha256: '0'.repeat(64), artifactFiles: 1, configs: [], cliSha256: 'e'.repeat(64), configSha256: 'f'.repeat(64), gateway: 'fireboat', runtime: 'node' }, instrumentation: 'request-observer' as const, passed: 18 - failed, failed, evidenceSha256: 'c'.repeat(64),
    runs: [{ era: 'modern' as const, task: 'package-latest-hba1c' as const, arm: 'fhir' as const, status: 'pass' as const, checks: { passed: 1, failed: 0, incomparable: 0 }, failing: [], limitations: ['LATEST_UNVERIFIED'] }] });
  const assets = async () => ({ manifest: Buffer.from('{}'), compose: Buffer.from(''), resources: Buffer.from('') });
  const flags = ['--run-dir', '/r', '--node', '/n', '--cli', '/c', '--config', '/g'];
  const ok = await runQuickstart(['verify', ...flags], { assets, verify: async () => report(0) });
  assert.deepEqual(ok, { line: `VERIFY_OK runs=1 passed=18 failed=0 limitations=LATEST_UNVERIFIED evidence=${'c'.repeat(64)}`, exitCode: 0 });
  assert.equal((await runQuickstart(['verify', ...flags], { assets, verify: async () => report(2) })).exitCode, 1);
  assert.deepEqual(await runQuickstart(['verify', '--run-dir', 'relative', ...flags.slice(2)], { assets, verify: async () => report(0) }), { line: 'CLI_USAGE', exitCode: 2 });
});

test('quickstart verify invariants: bytes, decoding, accounting, identity, outcomes and chains are judged on every call, whatever the checks read', () => {
  const task: PackageTask = { id: 'package-status-sensitive', question: 'q', fields: [], perCallBytes: 4096, checks: [
    { kind: 'callOutcome', id: 'expected-not-found', step: 1, outcome: 'application_error', code: 'NOT_FOUND' }],
    steps: [{ tool: 'fhir_read', input: {} }, { tool: 'fhir_read', input: {} }] };
  const good = (step: number, extra: Rec = {}): TaskCall => {
    const env = envelope({ budget: { bytes_returned: 0, byte_limit: 4096 }, ...extra });
    let rawText = JSON.stringify({ structuredContent: env });
    for (let i = 0; i < 3; i++) { (env.budget as Rec).bytes_returned = Buffer.byteLength(rawText); rawText = JSON.stringify({ structuredContent: env }); }
    return { step, envelope: env, rawText, work: { metadata: 0, auth: 0, clinical: 1 }, resultBytes: Buffer.byteLength(rawText), frameBytes: Buffer.byteLength(rawText) + 40 };
  };
  const notFound = good(1, { error: { code: 'NOT_FOUND', safe_message: 'x' } });
  assert.deepEqual(callInvariants(task, [good(0), notFound]).filter(id => !id.startsWith('invariant:response:')), []);
  const swap = (call: TaskCall, change: Partial<TaskCall>): TaskCall => ({ ...call, ...change });
  /** The same call with its envelope edited and its raw text and bytes re-measured (the accounting is left as edited). */
  const remeasured = (call: TaskCall, change: (env: Rec) => void): TaskCall => {
    const env = structuredClone(call.envelope!) as unknown as Rec; change(env);
    const rawText = JSON.stringify({ structuredContent: env });
    return { ...call, envelope: env as unknown as GatewayEnvelope, rawText, resultBytes: Buffer.byteLength(rawText) };
  };
  const cases: [string, TaskCall[], string][] = [
    ['a step without calls', [good(0)], 'invariant:missing:1'],
    ['bytes that are not the captured result member', [swap(good(0), { resultBytes: good(0).resultBytes + 1 }), notFound], 'invariant:bytes:0'],
    ['a result over the requested ceiling', [swap(good(0), { rawText: `${good(0).rawText}${' '.repeat(5000)}`, resultBytes: good(0).resultBytes + 5000 }), notFound], 'invariant:bytes:0'],
    ['a decoded envelope that is not the raw structured content', [swap(good(0), { envelope: envelope({ budget: good(0).envelope!.budget, source: { alias: 'qs-hapi', capability_revision: 'other' } }) }), notFound], 'invariant:decoded:0'],
    ['accounting that disagrees with the measured bytes', [remeasured(good(0), env => { (env.budget as Rec).bytes_returned = 1; }), notFound], 'invariant:accounting:0'],
    ['accounting against another ceiling', [remeasured(good(0), env => { (env.budget as Rec).byte_limit = 8192; }), notFound], 'invariant:accounting:0'],
    ['a result padded outside the structured content', [((c: TaskCall) => { const rawText = c.rawText!.replace(/}$/, ',"content":[{"type":"text","text":"padding"}]}'); return { ...c, rawText, resultBytes: Buffer.byteLength(rawText) }; })(good(0)), notFound], 'invariant:accounting:0'],
    ['another gateway identity in the run', [good(0, { context: { handle: 'ctx-other' } }), notFound], 'invariant:identity'],
    ['an unexpected application error', [good(0, { error: { code: 'NOT_FOUND', safe_message: 'x' } }), notFound], 'invariant:outcome:0'],
    ['another error than the step expects', [good(0), good(1, { error: { code: 'RESULT_EXPIRED', safe_message: 'x' } })], 'invariant:outcome:1'],
    ['an expected error followed by another call', [good(0), notFound, good(1)], 'invariant:outcome:1'],
    ['an envelope-less call', [good(0), notFound, { step: 0, work: { metadata: 0, auth: 0, clinical: 0 }, resultBytes: 0, frameBytes: 10 } as TaskCall], 'invariant:outcome:0'],
    ['an envelope-less JSON-RPC error', [{ step: 0, outcome: { class: 'json_rpc_error', code: -32603 }, work: { metadata: 0, auth: 0, clinical: 0 }, resultBytes: 0, frameBytes: 10 } as TaskCall, notFound], 'invariant:outcome:0'],
    ['a query chain whose digest does not bind its query', [good(0, { coverage: { state: 'unknown', scope: 'page', reasons: [], query_digest: '0'.repeat(64), constraints: [] } }), notFound], 'invariant:chain:0'],
  ];
  for (const [label, calls, id] of cases) assert.ok(callInvariants(task, calls).includes(id), label);
  // An invariant failure fails the run even when every check passes.
  const { run } = judgeTask({ ...task, checks: [] }, 'fhir', [good(0, { context: { handle: 'ctx-other' } }), good(1)]);
  assert.equal(run.status, 'fail'); assert.ok(run.failing.includes('invariant:identity'));
});

test('quickstart verify setup: closed seeding attempt, compose identity and exact approved numeric lexemes are semantically bound after hashing', async () => {
  for (const label of ['not-json', 'foreign-run', 'failed-phase', 'extra-field', 'different-compose', 'wrong-lexeme', 'receipt-manifest']) {
    const { dir, config } = await runDirectory();
    try {
      const run = join(dir, 'run'), receipt = JSON.parse(await readFile(join(run, 'receipt.json'), 'utf8')) as Rec;
      const packet = JSON.parse(await readFile(join(run, 'setup-packet.json'), 'utf8')) as Rec;
      const attempt = JSON.parse(await readFile(join(run, 'attempt.json'), 'utf8')) as Rec;
      if (label === 'foreign-run') attempt.runId = '0'.repeat(16);
      if (label === 'failed-phase') attempt.phase = 'failed';
      if (label === 'extra-field') attempt.extra = true;
      if (label === 'different-compose') {
        receipt.composeSha256 = attempt.composeSha256 = '1'.repeat(64);
        (receipt.instance as Rec).composeSha256 = (attempt.instance as Rec).composeSha256 = receipt.composeSha256;
        packet.instanceSha256 = sha256(jsonBytes(receipt.instance));
      }
      if (label === 'receipt-manifest') receipt.manifestSha256 = attempt.manifestSha256 = '8'.repeat(64);
      if (label === 'wrong-lexeme') {
        const row = (packet.resources as Rec[]).find(r => (r.numbers as Rec[]).length)!;
        (row.numbers as Rec[])[0]!.lexeme = '777.00';
      }
      const attemptBytes = label === 'not-json' ? Buffer.from('this is not JSON') : jsonBytes(attempt);
      receipt.attemptSha256 = packet.receiptSha256 = sha256(attemptBytes);
      const packetBytes = jsonBytes(packet); receipt.packetSha256 = sha256(packetBytes);
      await atomicPrivateWrite(join(run, 'attempt.json'), attemptBytes);
      await atomicPrivateWrite(join(run, 'setup-packet.json'), packetBytes);
      await atomicPrivateWrite(join(run, 'receipt.json'), jsonBytes(receipt));
      await assert.rejects(verify(launch(dir, config), { doctor: ready, openSession: async () => { throw Error('no launch'); } }), faultCode('VERIFY_RUN_INVALID'), label);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});

test('quickstart verify launch binding: an exclusive run lock, unique outputs, actual config hashes and a changed transitive artifact refusal', async () => {
  const { dir, config } = await runDirectory();
  try {
    let release!: () => void, entered!: () => void;
    const paused = new Promise<void>(resolve => { release = resolve; }), reached = new Promise<void>(resolve => { entered = resolve; });
    const sessions = async () => scripted((_tool, _input, n) => envelope(n === 1 ? { result: { handle: 'h' } } : {}));
    const first = verify(launch(dir, config), { eras: ['modern'], arms: ['fhir'], wait: async () => {}, openSession: sessions,
      doctor: async () => { entered(); await paused; return ready(); } });
    try {
      // A pre-doctor rejection must fail this test instead of leaving its entry latch pending forever.
      await Promise.race([reached, first]);
      await assert.rejects(verify(launch(dir, config), { doctor: ready, openSession: sessions, eras: ['modern'], arms: ['fhir'], wait: async () => {} }), faultCode('RUN_LOCKED'));
    } finally { release(); await first; }
    const a = await first;
    const b = await verify(launch(dir, config), { eras: ['modern'], arms: ['fhir'], wait: async () => {}, doctor: ready, openSession: sessions });
    assert.notEqual(a.verificationId, b.verificationId);
    assert.equal((await stat(join(dir, 'run', a.verificationId))).mode & 0o777, 0o700);
    for (const report of [a, b]) for (const row of report.launch.configs) {
      const bytes = await readFile(join(dir, 'run', report.verificationId, row.name)); assert.equal(row.sha256, sha256(bytes));
    }
    assert.equal(a.launch.configs.length, 3, 'base, TTL and clean-control configs');
    assert.deepEqual((await readdir(join(dir, 'run'))).filter(n => n === 'verify.lock'), [], 'the exclusive lock is released');
    const main = join(dir, 'gateway/main.js'); await writeFile(main, 'export const version = 1;');
    const artifact = await gatewayArtifact(join(dir, 'gateway/cli.js'));
    for (const file of [main, join(dir, 'gateway/cli.js')]) {
      await assert.rejects(verify(launch(dir, config), { eras: ['modern'], arms: ['fhir'], wait: async () => {}, openSession: sessions,
        doctor: async () => { await writeFile(file, 'export const changed = 2;'); return ready(); } }), faultCode('VERIFY_DOCTOR'));
    }
    assert.notEqual((await gatewayArtifact(join(dir, 'gateway/cli.js'))).sha256, artifact.sha256);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

/** Actual gateway rendering and lossless serialization, with already-sanitized seed snapshots; no HTTP or listener. */
async function renderedStatus(arm: 'fhir' | 'compact' | 'selected', change?: (resource: Rec) => void, maxBytes = 131072, requestBytes = tasks[1]!.perCallBytes) {
  const { FhirGateway } = await import('../packages/core/src/index.js');
  const { parseFhirJson, stringifyFhir } = await import('../packages/core/src/decimal.js');
  const { sanitize } = await import('../packages/core/src/privacy.js');
  const g: any = new FhirGateway({ mode: 'synthetic', source: { alias: 'qs-hapi', baseUrl: 'http://127.0.0.1:9/fhir' }, patientId, contextId: 'ctx', limits: { maxBytes } });
  g.capabilityRevision = 'cap-test'; g.fhirVersion = '4.0.1';
  const status = { ...tasks[1]!, perCallBytes: requestBytes }, bodies = resources.trimEnd().split('\n').map(line => parseFhirJson(line) as Rec);
  let id = 0;
  const session: GatewaySession = { async call(tool, input) {
    const admission = g.admitV2(tool, input);
    const resource = bodies.find(r => r.resourceType === input.resource_type && r.id === input.id);
    let env;
    if (!resource || input.id === 'qs-edge-other-hba1c') env = g.errorV2(tool, { code: 'NOT_FOUND', retryable: false }, admission);
    else {
      const original = { ...resource, resourceType: resource.resourceType as string, meta: { versionId: '1' } }; change?.(original);
      const record = sanitize(original); record.retrievedAt = '2026-10-24T00:00:00.000Z';
      env = g.renderV2({ type: input.resource_type, records: [record], offset: 0, query: [], suppressed: false }, admission, tool);
    }
    g.bytesV2(env, { era: 'modern', profile: 'full-text-v1' });
    const rawText = stringifyFhir(g.sdkResultV2(env, { era: 'modern', profile: 'full-text-v1' }));
    return { requestId: ++id, rawText, envelope: JSON.parse(rawText).structuredContent, resultBytes: Buffer.byteLength(rawText), frameBytes: Buffer.byteLength(rawText) + 40,
      work: { metadata: 0, auth: 0, clinical: 1 }, ...(env.error ? { outcome: { class: 'application_error' as const, code: env.error.code } } : {}) };
  }, async close() { g.close(); } };
  try { return await runTaskSteps(status, arm, session, () => {}); } finally { await session.close(); }
}
/** Edit both delivered channels and converge accounting, so independent semantic guards must reject the witness. */
function rewritten(call: TaskCall, edit: (env: Rec, result: Rec) => void, mirror = true): TaskCall {
  const result = JSON.parse(call.rawText!) as Rec, env = result.structuredContent as Rec; edit(env, result);
  let rawText = '';
  for (let i = 0; i < 8; i++) {
    if (mirror) (result.content as Rec[])[0]!.text = JSON.stringify(env);
    rawText = JSON.stringify(result); const size = Buffer.byteLength(rawText);
    if ((env.budget as Rec).bytes_returned === size) break; (env.budget as Rec).bytes_returned = size;
  }
  return { ...call, rawText, envelope: env as unknown as GatewayEnvelope, resultBytes: Buffer.byteLength(rawText) };
}

test('quickstart verify response gate: trusted identity, complete provenance, resource-free safe errors and exact visible text are independently judged', async () => {
  const status = tasks[1]!;
  for (const arm of ['fhir', 'compact', 'selected'] as const) {
    const calls = await renderedStatus(arm);
    assert.equal(judgeTask(status, arm, calls).run.status, 'pass', `gateway-rendered ${arm} control: ${JSON.stringify(judgeTask(status, arm, calls).run)}`);
    const edits: [string, number, (e: Rec, r: Rec) => void, boolean?][] = [
      ['schema', 0, e => { e.schema_version = '9.9'; }],
      ['source', 0, e => { (e.source as Rec).alias = 'foreign'; }],
      ['FHIR', 0, e => { (e.source as Rec).fhir_version = '9.9'; }],
      ['context', 0, e => { (e.context as Rec).mode = 'unbound'; }],
      ['provenance', 0, e => { e.provenance = []; }],
      ['timestamp', 0, e => { (e.provenance as Rec[])[0]!.retrieved_at = '2026-02-30T00:00:00Z'; }],
      ['count', 0, e => { (e.pagination as Rec).returned_matches = 0; }],
      ['includes', 0, e => { (e.pagination as Rec).returned_includes = 99; }],
      ['manifest body', 4, e => { const rows = (e.transform as Rec).withheld_payloads as Rec[]; rows[0]!.body = { resourceType: 'Patient', id: 'invented' }; }],
      ['outer metadata body', 3, (_e, r) => { r._meta = { body: { resourceType: 'Patient', id: 'invented' } }; }],
      ['error body', 3, e => { (e.data as Rec).resources = [{ resourceType: 'Patient', id: 'invented' }]; }],
      ['unsafe error', 3, e => { (e.error as Rec).safe_message = 'PRIVATE upstream diagnostics'; }],
      ['visible contradiction', 0, (_e, r) => { (r.content as Rec[])[0]!.text = 'The result is final, 999%.'; }, false],
    ];
    for (const [label, at, edit, mirror] of edits) {
      const changed = calls.map((c, i) => i === at ? rewritten(c, edit, mirror ?? true) : c);
      assert.ok(callInvariants(status, changed).includes(`invariant:response:${at}`), `${arm}/${label}`);
    }
    // The same internally consistent false identity on EVERY call is still refused against the trusted binding.
    const foreign = calls.map(c => rewritten(c, e => { e.schema_version = '9.9'; (e.source as Rec).alias = 'foreign'; (e.source as Rec).fhir_version = '9.9'; (e.context as Rec).mode = 'unbound'; }));
    assert.ok(callInvariants(status, foreign).includes('invariant:response:0'));
  }
});

test('quickstart verify task checks: gateway-rendered negative facts and NOT_FOUND messages cannot be skipped', async () => {
  const status = tasks[1]!;
  const changed = await renderedStatus('fhir', r => { if (r.id === 'qs-edge-hba1c-corrected') r.status = 'final'; });
  const judged = judgeTask(status, 'fhir', changed);
  assert.equal(judged.run.status, 'fail'); assert.ok(judged.run.failing.includes('corrected-status'));
  assert.ok(judged.results.some(r => r.check_id === 'corrected-status' && r.status === 'fail'));
  assert.equal(callInvariants(status, changed).length, 0, 'the negative fact run otherwise has valid gateway responses');
  const good = await renderedStatus('fhir');
  const wrongMessages = good.map((c, i) => i === 2 || i === 3 ? rewritten(c, e => { (e.error as Rec).safe_message = 'Changed message'; }) : c);
  const messageResults = judgeTask(status, 'fhir', wrongMessages).results;
  for (const id of ['wrong-patient-message', 'absent-message']) assert.ok(messageResults.some(r => r.check_id === id && r.status === 'fail'), id);
});

test('quickstart verify ceiling: the validated 32768 operator ceiling passes requests up to 65536; reported ceilings are exact', async () => {
  const status = { ...tasks[1]!, perCallBytes: 65536 }, calls = await renderedStatus('fhir', undefined, 32768, 65536);
  const adjusted = calls;
  const binding = { alias: 'qs-hapi', fhirVersion: '4.0.1', maxBytes: 32768, defaultBytes: 24576 };
  assert.equal(judgeTask(status, 'fhir', adjusted, binding).run.status, 'pass');
  assert.ok(callInvariants(status, adjusted.map(c => rewritten(c, e => { (e.budget as Rec).byte_limit = 16384; })), binding).includes('invariant:accounting:0'));
});

test('quickstart verify controls: clean launch is explicit, complete frames stay private and an observed discovery difference fails comparison', async () => {
  for (const scenario of ['equal', 'different', 'misplaced-body', 'row-body', 'repair-body', 'manifest-body']) {
    const differs = scenario === 'different', malformed = !['equal', 'different'].includes(scenario);
    const { dir, config } = await runDirectory();
    try {
      const launches: boolean[] = [];
      const report = await verify(launch(dir, config), { doctor: ready, eras: ['modern'], arms: ['fhir'], wait: async () => {}, openSession: async l => {
        if (!l.config.endsWith('verify-control.config.json')) return scripted((_tool, _input, n) => envelope(n === 1 ? { result: { handle: 'h' } } : {}));
        launches.push(l.observe!);
        return { async close() {}, async call(_tool, input) {
          const env = { schema_version: '0.3', request_id: 'control', source: { alias: 'qs-hapi', fhir_version: '4.0.1', capability_revision: 'rev' },
            context: { handle: 'ctx_quickstart_verify_control', mode: 'patient-bound', policy_revision: 'policy' },
            data: { workflow: 'recent-labs-v1', matrix_revision: 'matrix', default_policy: 'deny_unclassified', clinical_sections: ['laboratory'], document_support: 'metadata_only', snapshot_revision: 'rev', captured_at: '2026-10-24T00:00:00Z', expires_at: '2026-10-24T00:01:00Z',
              rows: [{ resource_type: 'Observation', policy_class: 'patient', patient_link: 'subject', source_advertised: !(differs && l.observe), advertised_interactions: ['read', 'search-type'], policy_interactions: ['read', 'search-type'], executable_interactions: ['read', 'search-type'], instance_policy: 'bounded', compact_recipe: null, workflow_role: 'required', limitations: [] }] },
            coverage: { state: 'complete_for_query', scope: 'metadata', query_evidence: 'metadata_snapshot', query_exhausted: true, pages_observed: 0, authorization_limited: false, reasons: ['DECLARED_CAPABILITIES_NOT_PRODUCTION_VERIFICATION'] },
            transform: { format: 'fhir', requested_format: 'fhir', delivery_profile: 'full-text-v1', projected: false, withheld_payloads: [], omitted_fields: [], unresolved_fields: [], narrative_omitted: false, recipe_ids: [], structural_resource_indices: [] },
            warnings: [], budget: { bytes_returned: 0, byte_limit: 24576, elapsed_ms: 0, upstream_calls: 1, limit_reached: false } };
          const body = { resourceType: 'Patient', id: 'invented' };
          if (scenario === 'misplaced-body') (env.data as Rec).resources = [body];
          if (scenario === 'row-body') (env.data.rows[0] as Rec).body = body;
          if (scenario === 'repair-body') (env.warnings as Rec[]) = [{ code: 'WRONG', message: 'message', repair: { action: 'narrow_query', body } }];
          if (scenario === 'manifest-body') (env.transform.withheld_payloads as Rec[]).push({ path: '/data', reason: 'OMITTED', body });
          let rawText = '';
          for (let i = 0; i < 8; i++) { rawText = JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(env) }], structuredContent: env }); const size = Buffer.byteLength(rawText); if (env.budget.bytes_returned === size) break; env.budget.bytes_returned = size; }
          const rawFrame = `{"jsonrpc":"2.0","id":1,"result":${rawText}}\n`;
          return { requestId: 1, rawText, envelope: JSON.parse(rawText).structuredContent, rawFrame, frames: [
            { direction: 'sent' as const, text: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: _tool, arguments: input } }) + '\n' },
            { direction: 'received' as const, text: rawFrame }], resultBytes: Buffer.byteLength(rawText), frameBytes: Buffer.byteLength(rawFrame), work: { metadata: l.observe ? 1 : 0, auth: 0, clinical: 0 } };
        } };
      } });
      assert.deepEqual(launches, [false, true]);
      assert.equal(report.controls[0]!.status, differs || malformed ? 'fail' : 'pass');
      if (differs || malformed) assert.ok(report.runs.every(run => run.failing.includes('invariant:clean-control')));
      const evidence = await readFile(join(dir, 'run', report.verificationId, 'verify-evidence.ndjson'), 'utf8');
      const controls = evidence.trimEnd().split('\n').map(line => JSON.parse(line)).filter(row => row.kind.endsWith('-control'));
      assert.equal(controls.length, 2); assert.ok(controls.every(row => row.rawFrame.endsWith('\n') && row.frames.length === 2));
      assert.ok(!JSON.stringify(report).includes('source_advertised'), 'raw control data stays in private evidence');
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});

test('quickstart verify search gate: gateway-rendered 32768 drain pages keep trusted page size, counts, provenance and exact allowances in all arms', async () => {
  const { FhirGateway } = await import('../packages/core/src/index.js');
  const { parseFhirJson, stringifyFhir } = await import('../packages/core/src/decimal.js');
  const { sanitize } = await import('../packages/core/src/privacy.js');
  const { buildQueryEvidence } = await import('../packages/core/src/query.js');
  const task = { ...drain, steps: [drain.steps[0]!], checks: [] };
  for (const arm of ['fhir', 'compact', 'selected'] as const) {
    const g: any = new FhirGateway({ mode: 'synthetic', source: { alias: 'qs-hapi', baseUrl: 'http://127.0.0.1:9/fhir' }, patientId, contextId: 'ctx', limits: { maxBytes: 32768 } });
    g.capabilityRevision = 'cap-test'; g.fhirVersion = '4.0.1';
    try {
      const records = resources.trimEnd().split('\n').map(line => parseFhirJson(line) as Rec).filter(r => r.resourceType === 'Observation' && (r.subject as Rec)?.reference === `Patient/${patientId}`).slice(0, 100)
        .map(r => { const s = sanitize({ ...r, resourceType: 'Observation', meta: { versionId: '1' } }); s.retrievedAt = '2026-10-24T00:00:00.000Z'; return s; });
      const input = { ...task.steps[0]!.input, output: { format: arm === 'compact' ? 'compact' : 'fhir', max_bytes: 65536, ...(arm === 'selected' ? { fields: [...drain.fields] } : {}) } };
      const pairs = [{ name: 'subject', value: `Patient/${patientId}` }, ...(task.steps[0]!.input.params as { name: string; value: string }[])];
      const queryEvidence = buildQueryEvidence({ resourceType: 'Observation', pairs, gatewayEnforcedIndices: new Set([0]), sourceRevision: g.capabilityRevision, policyRevision: g.policyRevision, contextHandle: 'ctx' });
      const env = g.renderV2({ type: 'Observation', records, offset: 0, query: [...pairs, { name: '_count', value: '100' }], suppressed: false, queryEvidence }, g.admitV2('fhir_search', input), 'fhir_search');
      const rawText = stringifyFhir(g.sdkResultV2(env, { era: 'modern', profile: 'full-text-v1' }));
      const call: TaskCall = { step: 0, tool: 'fhir_search', input, envelope: JSON.parse(rawText).structuredContent, rawText, resultBytes: Buffer.byteLength(rawText), frameBytes: Buffer.byteLength(rawText) + 40, work: { metadata: 0, auth: 0, clinical: 1 } };
      const binding = { alias: 'qs-hapi', fhirVersion: '4.0.1', maxBytes: 32768, defaultBytes: 24576 };
      assert.equal(call.envelope!.budget.byte_limit, 32768); assert.ok(call.resultBytes <= 32768);
      assert.deepEqual(callInvariants(task, [call], binding), [], arm);
      for (const [label, edit] of [
        ['missing provenance', (e: Rec) => { e.provenance = []; }],
        ['invalid page size', (e: Rec) => { (e.pagination as Rec).requested_page_size = 1; }],
        ['invalid count', (e: Rec) => { (e.pagination as Rec).returned_matches = 0; (e.pagination as Rec).returned_includes = 99; }],
        ['wrong reported allowance', (e: Rec) => { (e.budget as Rec).byte_limit = 16384; }],
      ] as [string, (e: Rec) => void][]) {
        const failing = callInvariants(task, [rewritten(call, edit)], binding);
        assert.ok(failing.includes(label === 'wrong reported allowance' ? 'invariant:accounting:0' : 'invariant:response:0'), `${arm}/${label}`);
      }
    } finally { g.close(); }
  }
});


test('quickstart verify artifact bounds: dependency resolution rows and all manifest/file reads share the closure budgets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qs-artifact-bounds-'));
  try {
    const cli = join(dir, 'cli.js'); await writeFile(cli, '// cli');
    await writeFile(join(dir, 'package.json'), '{"dependencies":{}}');
    const first = await gatewayArtifact(cli); assert.deepEqual(await gatewayArtifact(cli), first, 'sorted deterministic artifact binding');
    const block = Buffer.alloc(8 * 1024 * 1024);
    for (let i = 0; i < 8; i++) await writeFile(join(dir, `block-${i}.json`), block);
    await assert.rejects(gatewayArtifact(cli), 'the total read allowance includes package metadata and refuses before reading beyond it');
    for (let i = 0; i < 8; i++) await rm(join(dir, `block-${i}.json`));
    await mkdir(join(dir, 'shared')); await mkdir(join(dir, 'node_modules'));
    await writeFile(join(dir, 'shared/package.json'), '{"name":"shared","version":"1","dependencies":{}}');
    await writeFile(join(dir, 'shared/index.js'), 'export const value = 1;');
    const names = Array.from({ length: 8192 }, (_, i) => `alias-${i}`);
    for (let i = 0; i < names.length; i += 128) await Promise.all(names.slice(i, i + 128).map(name => symlink(join(dir, 'shared'), join(dir, 'node_modules', name), 'dir')));
    await writeFile(join(dir, 'package.json'), JSON.stringify({ dependencies: Object.fromEntries(names.slice(0, 4).map(name => [name, '1'])) }));
    assert.equal((await gatewayArtifact(cli)).files, 4, 'file counts exclude dependency-resolution rows');
    await writeFile(join(dir, 'package.json'), JSON.stringify({ dependencies: Object.fromEntries(names.map(name => [name, '1'])) }));
    await assert.rejects(gatewayArtifact(cli), faultCode('VERIFY_DOCTOR'), 'repeated dependency aliases are bounded even when their files have already been hashed');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
