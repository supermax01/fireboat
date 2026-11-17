import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

// Standalone before installation: every import above is a Node built-in.
export const TIMING_STAGES = ['prerequisites', 'gateway-install', 'helper-install', 'configuration', 'startup',
  'seeding', 'doctor', 'verification', 'cleanup'] as const;
export type TimingStage = typeof TIMING_STAGES[number];
export type TimingOutcome = 'start' | 'success' | 'failure' | 'assistance';
export type TimingFaultCode = 'TIMING_EVENT_INVALID' | 'TIMING_CLOCK_INVALID' | 'TIMING_COMMAND_INVALID' | 'TIMING_IO';
export class TimingFault extends Error {
  readonly code: TimingFaultCode;
  constructor(code: TimingFaultCode) { super(code); this.name = 'TimingFault'; this.code = code; }
}
const fault = (code: TimingFaultCode): TimingFault => new TimingFault(code);
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
type EventInput = Readonly<{ stage: TimingStage; outcome: TimingOutcome }>;
export function closedTimingEvent(value: unknown): value is EventInput {
  return record(value) && Object.keys(value).length === 2 && TIMING_STAGES.includes(value.stage as TimingStage) &&
    ['start', 'success', 'failure', 'assistance'].includes(value.outcome as string);
}
export type TimingEvent = Readonly<EventInput & {
  elapsedMs: number; attempt: number; retries: number; errors: number; assistance: number;
}>;
export type TimingClock = Readonly<{ monotonicNow: () => number; utcNow: () => Date }>;
export type StageCommand = Readonly<{ stage: TimingStage; file: string; args: readonly string[] }>;
export type StageExecutor = (command: StageCommand) => Promise<{ code: number | null }>;
const defaultClock: TimingClock = { monotonicNow: () => performance.now(), utcNow: () => new Date() };
function validCommand(value: unknown): value is StageCommand {
  return record(value) && Object.keys(value).length === 3 && TIMING_STAGES.includes(value.stage as TimingStage) &&
    typeof value.file === 'string' && isAbsolute(value.file) && value.file.length <= 8192 && !value.file.includes('\0') &&
    Array.isArray(value.args) && value.args.length <= 128 && value.args.every(a => typeof a === 'string' && a.length <= 8192 && !a.includes('\0'));
}
export const spawnStage: StageExecutor = command => new Promise(accept => {
  const child = spawn(command.file, [...command.args], { shell: false, stdio: 'inherit' });
  child.once('error', () => accept({ code: null }));
  child.once('exit', code => accept({ code }));
});

export function createTiming(clock: TimingClock = defaultClock) {
  const { monotonicNow } = clock;
  const started = monotonicNow(), date = clock.utcNow();
  if (!Number.isFinite(started) || !(date instanceof Date) || !Number.isFinite(date.getTime())) throw fault('TIMING_CLOCK_INVALID');
  const startedUtc = date.toISOString();
  let attemptStarted = started, lastElapsed = 0, retries = 0, errors = 0, assistance = 0;
  let active: TimingStage | undefined;
  const attempts = new Map<TimingStage, number>(), events: TimingEvent[] = [];
  const offset = (): number => {
    const elapsed = monotonicNow() - started;
    if (!Number.isFinite(elapsed) || elapsed < lastElapsed) throw fault('TIMING_CLOCK_INVALID');
    lastElapsed = elapsed; return elapsed;
  };
  const event = (event: unknown): TimingEvent => {
    if (!closedTimingEvent(event)) throw fault('TIMING_EVENT_INVALID');
    const input = event as EventInput;
    if (events.length >= 4096 || (input.outcome === 'start' ? active !== undefined : active !== input.stage))
      throw fault('TIMING_EVENT_INVALID');
    if (input.outcome === 'start') {
      attemptStarted = monotonicNow();
      const previous = attempts.get(input.stage) ?? 0;
      if (previous) retries++;
      attempts.set(input.stage, previous + 1); active = input.stage;
    } else if (input.outcome === 'failure') errors++;
    else if (input.outcome === 'assistance') assistance++;
    const result: TimingEvent = Object.freeze({ stage: input.stage, outcome: input.outcome, elapsedMs: offset(),
      attempt: attempts.get(input.stage)!, retries, errors, assistance });
    events.push(result);
    if (input.outcome === 'success' || input.outcome === 'failure') active = undefined;
    return result;
  };
  return Object.freeze({
    event,
    packet() {
      return Object.freeze({ schema: 1 as const, startedUtc, elapsedMs: offset(), retries, errors, assistance,
        events: Object.freeze([...events]) });
    },
    async run(command: StageCommand, executor: StageExecutor = spawnStage): Promise<boolean> {
      if (!validCommand(command)) throw fault('TIMING_COMMAND_INVALID');
      // Freeze the argv before the asynchronous executor can observe substitutions.
      const snapshot = Object.freeze({ ...command, args: Object.freeze([...command.args]) });
      event({ stage: snapshot.stage, outcome: 'start' });
      let ok = false;
      try { ok = (await executor(snapshot)).code === 0; } catch { /* failure event, no error prose */ }
      event({ stage: snapshot.stage, outcome: ok ? 'success' : 'failure' });
      return ok;
    }
  });
}

// Native Node 24 type stripping or the root-built JS bootstrap needs no helper
// installation. The local packet is created exclusively with restrictive mode.
/** True when this module is the process entry, also when it is started through a symlink (an npm bin shim, macOS /var). */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try { return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}
if (isMainModule()) {
  try {
    const args = process.argv.slice(2), timer = createTiming();
    if (args.length !== 4 || args[0] !== '--plan' || args[2] !== '--out' || !isAbsolute(args[1]!) || !isAbsolute(args[3]!))
      throw fault('TIMING_COMMAND_INVALID');
    const raw = await readFile(args[1]!);
    if (raw.byteLength > 131_072) throw fault('TIMING_COMMAND_INVALID');
    const plan: unknown = JSON.parse(raw.toString('utf8'));
    if (!Array.isArray(plan) || plan.length < 1 || plan.length > 128 || !plan.every(validCommand)) throw fault('TIMING_COMMAND_INVALID');
    for (const command of plan) await timer.run(command);
    const packet = timer.packet();
    await writeFile(args[3]!, `${JSON.stringify(packet)}\n`, { flag: 'wx', mode: 0o600 });
    process.exitCode = packet.errors ? 1 : 0;
  } catch (error) {
    process.stderr.write(`${error instanceof TimingFault ? error.code : 'TIMING_IO'}\n`); process.exitCode = 2;
  }
}
