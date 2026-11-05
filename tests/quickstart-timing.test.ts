import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createTiming } from '../examples/quickstart/timing.js';

test('quickstart timing: failure assistance retry and cleanup retain overall elapsed time', () => {
  let now = 100;
  const timer = createTiming({ monotonicNow: () => now, utcNow: () => new Date('2026-01-01T00:00:00Z') });
  timer.event({ stage: 'gateway-install', outcome: 'start' });
  now = 130; assert.equal(timer.event({ stage: 'gateway-install', outcome: 'failure' }).elapsedMs, 30);
  now = 145; assert.equal(timer.event({ stage: 'gateway-install', outcome: 'start' }).elapsedMs, 45);
  now = 170; timer.event({ stage: 'gateway-install', outcome: 'assistance' });
  now = 190; assert.equal(timer.event({ stage: 'gateway-install', outcome: 'success' }).elapsedMs, 90);
  now = 200; timer.event({ stage: 'cleanup', outcome: 'start' });
  now = 210; timer.event({ stage: 'cleanup', outcome: 'success' });
  const packet = timer.packet();
  assert.equal(packet.elapsedMs, 110); assert.equal(packet.retries, 1); assert.equal(packet.errors, 1); assert.equal(packet.assistance, 1);
  assert.equal(packet.startedUtc, '2026-01-01T00:00:00.000Z');
  assert.deepEqual(packet.events.map(e => e.elapsedMs), [0, 30, 45, 70, 90, 100, 110]);
});
test('quickstart timing: event schema rejects arbitrary prose paths ids and extra fields', () => {
  for (const key of ['path', 'url', 'error', 'id', 'body', 'query', 'hostname', 'username']) {
    const timer = createTiming({ monotonicNow: () => 0, utcNow: () => new Date(0) });
    assert.throws(() => timer.event({ stage: 'doctor', outcome: 'start', [key]: 'private-canary' }), { code: 'TIMING_EVENT_INVALID' });
    assert.equal(timer.packet().events.length, 0);
  }
  const timer = createTiming({ monotonicNow: () => 0, utcNow: () => new Date(0) });
  for (const event of [null, { stage: 'arbitrary', outcome: 'start' }, { stage: 'doctor', outcome: 'arbitrary' }])
    assert.throws(() => timer.event(event), { code: 'TIMING_EVENT_INVALID' });
  timer.event({ stage: 'doctor', outcome: 'start' }); timer.event({ stage: 'doctor', outcome: 'success' });
  assert.deepEqual(Object.keys(timer.packet().events[0]!).sort(), ['stage', 'outcome', 'elapsedMs', 'attempt', 'retries', 'errors', 'assistance'].sort());
});
test('quickstart timing: fake executor failures advance clock without exposing child errors', async () => {
  let now = 0;
  const timer = createTiming({ monotonicNow: () => now, utcNow: () => new Date(0) });
  const command = { stage: 'seeding' as const, file: '/fake/executable', args: ['private-canary'] };
  assert.equal(await timer.run(command, async () => { now = 30; throw new Error('private-canary /path'); }), false);
  now = 50;
  assert.equal(await timer.run(command, async c => { assert.deepEqual(c, command); now = 80; return { code: 0 }; }), true);
  assert.equal(timer.packet().elapsedMs, 80); assert.equal(timer.packet().retries, 1);
  assert(!JSON.stringify(timer.packet()).includes('private-canary'));
  await assert.rejects(timer.run({ ...command, file: 'relative' }), { code: 'TIMING_COMMAND_INVALID' });
});
test('quickstart timing: invalid lifecycle and backwards clock refuse', () => {
  let now = 0;
  const timer = createTiming({ monotonicNow: () => now, utcNow: () => new Date(0) });
  assert.throws(() => timer.event({ stage: 'doctor', outcome: 'success' }), { code: 'TIMING_EVENT_INVALID' });
  timer.event({ stage: 'doctor', outcome: 'start' }); now = 10; timer.event({ stage: 'doctor', outcome: 'assistance' });
  now = 9; assert.throws(() => timer.packet(), { code: 'TIMING_CLOCK_INVALID' });
});
test('quickstart timing: native preinstall wrapper uses only builtins and creates a local closed packet', async () => {
  const source = await readFile(new URL('../examples/quickstart/timing.ts', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/from ['"]([^'"]+)['"]/g)].map(m => m[1]!);
  assert(imports.length > 0 && imports.every(s => s.startsWith('node:')));
  const root = await mkdtemp(join(tmpdir(), 'quickstart-timing-'));
  try {
    const plan = join(root, 'plan.json'), out = join(root, 'packet.json');
    await writeFile(plan, JSON.stringify([{ stage: 'gateway-install', file: process.execPath, args: ['-e', 'process.exit(0)'] }]));
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../examples/quickstart/timing.ts', import.meta.url)), '--plan', plan, '--out', out],
      { cwd: root, env: { PATH: '' }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, '');
    const packet = JSON.parse(await readFile(out, 'utf8')) as { errors: number; events: unknown[] };
    assert.equal(packet.errors, 0); assert.equal(packet.events.length, 2); assert.equal((await stat(out)).mode & 0o777, 0o600);
    assert(!JSON.stringify(packet).includes(root));
  } finally { await rm(root, { recursive: true, force: true }); }
});
