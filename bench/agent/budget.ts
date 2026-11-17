// Run cap and budget guard. Both refuse before anything is launched.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { completeLines, repairPartialTail } from '../lib/jsonl.js';
import { MAX_BUDGET_USD } from './host.js';

/** Never more than 6 real-agent smoke runs in total, counting failed runs and retries (the smoke test is a harness check, not a result). */
export const SMOKE_RUN_CAP = 6;

/** The host stops after the turn that crosses --max-budget-usd, so one run can overshoot by its last turn. */
export const OVERSHOOT_FACTOR = 1.1;

export const WORST_CASE_PER_RUN_USD = MAX_BUDGET_USD * OVERSHOOT_FACTOR;

/**
 * Complete lines in a JSONL file (each record and each claim is one line). 0 if the file does not exist.
 * A partial last line (crash mid-append) is moved aside first and never counted as a record.
 */
export function countLines(path: string): number {
  if (!existsSync(path)) return 0;
  repairPartialTail(path);
  return completeLines(readFileSync(path, 'utf8')).length;
}

/**
 * Runs already used: the larger of finished records and launch claims. A claim is written before every launch,
 * so a crash between launch and record still counts against the cap.
 */
export const runsUsed = (recordsPath: string, claimsPath: string): number =>
  Math.max(countLines(recordsPath), countLines(claimsPath));

export interface CapCheck { ok: boolean; used: number; planned: number; cap: number; reason: string }

export function checkRunCap(used: number, planned: number, cap = SMOKE_RUN_CAP): CapCheck {
  const ok = Number.isInteger(planned) && planned >= 0 && used + planned <= cap;
  return { ok, used, planned, cap, reason: ok ? '' : `would make ${used + planned} runs; cap is ${cap} (${used} used)` };
}

export interface BudgetEstimate {
  runs: number;
  per_run_usd: number;
  basis: 'worst_case' | 'given';
  estimated_usd: number;
  cap_usd: number;
  ok: boolean;
  reason: string;
}

/**
 * Refuses a batch whose estimated cost exceeds the cap. Default per-run estimate is the worst case
 * (--max-budget-usd plus the last-turn overshoot allowance); a smaller explicit estimate is allowed but recorded.
 * Infrastructure re-runs are not in `runs`; each is checked again before it starts.
 */
export function estimateBatch(runs: number, capUsd: number, perRunUsd?: number): BudgetEstimate {
  if (!Number.isFinite(capUsd) || capUsd < 0) throw new Error('budget cap must be a non-negative number');
  if (perRunUsd !== undefined && (!Number.isFinite(perRunUsd) || perRunUsd <= 0)) throw new Error('per-run estimate must be positive');
  const per = perRunUsd ?? WORST_CASE_PER_RUN_USD;
  const estimated = Math.round(runs * per * 100) / 100;
  const ok = estimated <= capUsd;
  return {
    runs, per_run_usd: per, basis: perRunUsd === undefined ? 'worst_case' : 'given', estimated_usd: estimated, cap_usd: capUsd, ok,
    reason: ok ? '' : `estimated USD ${estimated.toFixed(2)} (${runs} x ${per.toFixed(2)}) exceeds cap USD ${capUsd.toFixed(2)}`,
  };
}

/** Sum of reported total_cost_usd lexemes (as numbers, for the guard only; records keep the lexeme). */
export function spentUsd(costs: readonly (string | null)[]): number {
  return costs.reduce((s, c) => s + (c === null ? 0 : Number(c)), 0);
}

/**
 * Exclusive lock for one smoke batch (`<dir>/.lock`, created with O_EXCL, holding the PID). Two concurrent
 * bench:agent-smoke processes can therefore never both read the same used-run count and both launch past the cap.
 * A lock whose PID is no longer alive is stale and taken over. Released on process exit.
 */
export function acquireBatchLock(dir: string): () => void {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, '.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx');
      writeSync(fd, `${process.pid}\n`);
      closeSync(fd);
      let held = true;
      const release = () => { if (held) { held = false; try { unlinkSync(path); } catch { /* already gone */ } } };
      process.once('exit', release);
      return release;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const pid = Number(readFileSync(path, 'utf8').trim());
      if (Number.isInteger(pid) && pid > 0 && pidAlive(pid)) throw new Error(`another smoke batch holds ${path} (pid ${pid})`);
      unlinkSync(path); // stale: its process is gone
    }
  }
  throw new Error(`could not acquire ${path}`);
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}
