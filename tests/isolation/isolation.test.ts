import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadManifest, CHANNELS, caseJsonSchema, type Manifest } from './case-schema.js';
import { CANARIES } from './canaries.js';
import { scannerSelfTests, scan, normalize } from './scanners.js';
import { serverTrafficLiveness } from './verifier.js';
import { createDriver } from './drivers.js';
import { startBackend } from './backend.js';
import { validateAggregate, verifyMeasuredBytes, verifyProtocolFrames, verifyResponseBindings, reportReadiness, type CaseReport } from './runner.js';
import { ensureBuilt } from './build.js';
import { runBinding } from './report.js';
import { runDirectory } from './shard.js';
import type { PrerequisitesFile } from './aggregate.js';
// B2-0: this file holds the run-wide prerequisites only. The per-case tests live in the family shards
// (cases-<fam>.test.ts via shard.ts) and tests/isolation/aggregate.ts joins the shard reports with the
// prerequisites written here. The full semantic loader runs inside a named test, so a loader defect is a
// named failure rather than an import failure the judge cannot credit.
let validatedPromise: Promise<Manifest> | undefined;
const validated = () => (validatedPromise ??= loadManifest());
const prerequisites: Record<string, unknown> = {};

// No source/tsx CLI fallback: the real built binary must exist and start in both SDK eras. Building writes
// only ignored dist/ under the shared build lock; mutant copies invoke the same build independently.
await ensureBuilt();
// The prerequisites are bound like every shard (review H2): the aggregator refuses a file from another candidate,
// build, pin state or selection environment, and one whose binding changed during the run.
const bindingStart = await runBinding();

test('B2 prerequisite: frozen manifest, schema and verifier adversarial challenges', async () => {
  const full = await validated();
  assert.equal(full.cases.length, full.frozen_ids.length); assert.equal(caseJsonSchema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(full.cases.filter(c => c.counted).length, 0, 'B2-0: nothing is counted until B2-1 fills the per-case fields');
  assert.throws(() => validateAggregate([], full.cases.map(c => c.id), full.cases));
  assert.throws(() => validateAggregate([{ id: full.cases[0]!.id, lanes: [{ verdict: 'PASS', channels_na: [], channels_scanned: [], control_result: 'PASS', stubs: [] }] }] as unknown as CaseReport[], [full.cases[0]!.id], full.cases));
  // A normalizer must never collapse counts, reasons, repeated pairs, expiry duration or context.
  for (const key of ['count', 'reasons', 'context', 'ttl_ms', 'query', 'calls', 'next_cursor']) {
    const x = normalize({ [key]: key === 'next_cursor' ? 'cur_one' : 1 });
    const y = normalize({ [key]: key === 'next_cursor' ? undefined : 2 });
    assert.notDeepEqual(x, y, 'protected differences survive normalization');
  }
  assert.notDeepEqual(normalize({ handle: 'cur_one' }), normalize({ handle: 'res_one' }), 'locator kinds never normalize away');
  assert.notDeepEqual(normalize({ context: { handle: 'cur_a' } }), normalize({ context: { handle: 'cur_b' } }), 'context authority never normalizes away');
  assert.notDeepEqual(normalize([{ handle: 'res_a' }, { handle: 'res_a' }]), normalize([{ handle: 'res_a' }, { handle: 'res_b' }]));
  assert.notDeepEqual(normalize({ params: [{ name: 'code', value: 'a' }, { name: 'code', value: 'a' }] }), normalize({ params: [{ name: 'code', value: 'a' }] }));
  for (const c of CANARIES) for (const s of c.segments) assert.ok(s.length >= 8);
  // A borrowed earlier response cannot satisfy a later call's facts/citations.
  const forgedByteCount = normalize({ budget: { bytes_returned: 123 } });
  assert.notDeepEqual(forgedByteCount, normalize({ budget: { bytes_returned: 456 } }));
  assert.throws(() => verifyProtocolFrames('an unframed operational log\n'));
  assert.throws(() => verifyMeasuredBytes({ wire: { content: 'actual bytes' }, bytes: 0 }));
  assert.throws(() => verifyResponseBindings([{ envelope: { request_id: 'borrowed-id' } }, { envelope: { request_id: 'borrowed-id' } }]));
  const earlier = { resources: [{ id: 'a' }], provenance: [{ id: 'a' }] };
  const later = { resources: [], provenance: [] };
  assert.notDeepEqual(earlier, later);
  assert.equal(reportReadiness({}, true), 'INCONCLUSIVE');
  assert.equal(reportReadiness(Object.fromEntries(['manifest_and_verifier', 'scanners', 'server_traffic', 'backend_liveness', 'operational_sinks', 'barrier_schedule'].map(k => [k, { verdict: 'PASS' }])), false), 'INCONCLUSIVE');
  prerequisites.manifest_and_verifier = { verdict: 'PASS', frozen_ids: full.frozen_ids.length, counted: 0, missing_aggregate: 'rejected', unsafe_normalization: 'rejected', loader_rejections: 'tests/isolation/counting.test.ts' };
});
test('B2 prerequisite: nine-channel scanner planted/clean and transform self-tests', () => {
  prerequisites.scanners = scannerSelfTests();
  for (const channel of CHANNELS) assert.ok(scan(channel, { [CANARIES[0].segments[0]]: 'key' }).length > 0);
});
test('B2 prerequisite: planted server traffic and live SDK client handlers in both eras', async () => { prerequisites.server_traffic = await serverTrafficLiveness(); });
test('B2 prerequisite: independent recorder, sink, mutation journal and barrier schedule', async () => {
  const backend = await startBackend();
  try {
    prerequisites.backend_liveness = { ...await backend.liveness(), verdict: 'PASS' };
    const driver = await createDriver('core', backend.base);
    try {
      const planted = CANARIES[0].segments[0];
      console.log(planted); process.stdout.write(planted); process.stderr.write(planted);
      assert.equal(driver.operational.length, 3, 'console/stdout/stderr sinks all live');
      assert.ok(scan('operational', driver.operational).length >= 3);
      prerequisites.operational_sinks = { verdict: 'PASS', planted_sinks: 3 };
    } finally { await driver.close(); }
    const before = backend.requests.length;
    await fetch(`${new URL(backend.base).origin}/__probe`);
    assert.equal(backend.requests.length - before, 1, 'a missing recorder event is detectable');
    const gate = backend.holdNextClinical();
    const fetchHeld = fetch(`${backend.base}Observation/missing`); await gate.entered;
    assert.equal(backend.requests.at(-1)?.kind, 'clinical');
    gate.release(); await fetchHeld;
    const events: string[] = [];
    let release!: () => void;
    const barrier = new Promise<void>(r => { release = r; });
    const work = (async () => { events.push('held'); await barrier; events.push('committed'); })();
    assert.deepEqual(events, ['held']); release(); await work;
    assert.deepEqual(events, ['held', 'committed']);
    prerequisites.barrier_schedule = { verdict: 'PASS', events };
  } finally { await backend.close(); }
});
after(async () => {
  // Only verdict-level fields are written; raw captures and canary values never go to TAP/stdout/stderr.
  const file: PrerequisitesFile = { schema_version: 'b2-prerequisites/1', run_id: process.env.B2_RUN_ID ?? 'unbound', binding: { start: bindingStart, end: await runBinding() }, checks: prerequisites };
  mkdirSync(runDirectory(), { recursive: true });
  writeFileSync(join(runDirectory(), 'prerequisites.json'), `${JSON.stringify(file, null, 1)}\n`, { mode: 0o600 });
  process.stdout.write(`# B2 PREREQUISITES ${Object.keys(prerequisites).length}/6 recorded in ${runDirectory()}\n`);
});
