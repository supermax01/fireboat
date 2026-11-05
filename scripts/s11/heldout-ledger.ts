import { appendFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Attempt } from './measure.js';
import { STUDY, hash, requireS11 } from './study.js';

/**
 * The persistent, study-level heldout ledger. It lives BESIDE the per-run directories (under the same ignored
 * `artifacts/m3b-measurement/` parent), so a new `--run` name cannot reset it; its upper-case name can never be a run
 * name. It is procedural custody on one operator's disk, not a security boundary: it makes reuse refuse mechanically and
 * every exposure visible, it cannot stop a person deleting it.
 */
export const LEDGER_DIRECTORY = 'HELDOUT-LEDGER';
export interface HeldoutCohort { study: string; pools: readonly number[]; pool_size: number }
export const heldoutCohort = (): HeldoutCohort => ({ study: STUDY.schema, pools: [...STUDY.pools.heldout], pool_size: STUDY.poolSize });
const cohortSeeds = (cohort: HeldoutCohort): Set<number> => new Set(cohort.pools.flatMap(start => Array.from({ length: cohort.pool_size }, (_, i) => start + i)));
export const cohortKey = (cohort: HeldoutCohort): string => hash(JSON.stringify({ study: cohort.study, pools: [...cohort.pools], pool_size: cohort.pool_size }));
export interface LedgerEvent { run: string; event: 'custody' | 'unsealed'; cohort_key: string; at: string; detail_sha256?: string }

async function ledger(parent: string): Promise<string> {
  const directory = join(parent, LEDGER_DIRECTORY);
  try { await mkdir(directory, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
  const stat = await lstat(directory); requireS11(stat.isDirectory() && !stat.isSymbolicLink(), 'LEDGER_INVALID');
  return directory;
}
async function readEvents(directory: string): Promise<LedgerEvent[]> {
  let text = '';
  try { text = await readFile(join(directory, 'events.jsonl'), 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line) as LedgerEvent);
}

/** Append-only exposure log: every heldout custody and unseal event of every run, never rewritten. */
export async function recordHeldoutEvent(parent: string, event: LedgerEvent): Promise<void> {
  requireS11(/^[a-z0-9][a-z0-9-]{0,63}$/.test(event.run) && /^[a-f0-9]{64}$/.test(event.cohort_key), 'LEDGER_EVENT_INVALID');
  await appendFile(join(await ledger(parent), 'events.jsonl'), `${JSON.stringify(event)}\n`, { mode: 0o600, flag: 'a' });
}

/**
 * Preflight, before any generation: refuse when ANY seed of this heldout cohort was ever unsealed by any run, under any
 * run name. Returns the earlier exposure events (custody without unseal) for disclosure in the new run's freeze.
 */
export async function assertHeldoutUnconsumed(parent: string, cohort: HeldoutCohort = heldoutCohort()): Promise<LedgerEvent[]> {
  const directory = await ledger(parent), mine = cohortSeeds(cohort);
  for (const name of (await readdir(directory)).filter(n => n.startsWith('CONSUMED-'))) {
    requireS11(/^CONSUMED-[a-f0-9]{64}\.json$/.test(name), 'LEDGER_INVALID');
    const consumed = JSON.parse(await readFile(join(directory, name), 'utf8')) as { cohort?: HeldoutCohort };
    requireS11(consumed.cohort && Array.isArray(consumed.cohort.pools) && Number.isSafeInteger(consumed.cohort.pool_size), 'LEDGER_INVALID');
    if ([...cohortSeeds(consumed.cohort)].some(seed => mine.has(seed))) throw new Error('HELDOUT_ALREADY_CONSUMED');
  }
  return readEvents(directory);
}

/** Exclusive, single-use consumption of the cohort, written before the first heldout task; returns the record's hash. */
export async function consumeHeldout(parent: string, record: { run: string; at: string; corpus_freeze_sha256: string; development_freeze_sha256: string },
  cohort: HeldoutCohort = heldoutCohort()): Promise<string> {
  await assertHeldoutUnconsumed(parent, cohort);
  const key = cohortKey(cohort), text = `${JSON.stringify({ ...record, cohort, cohort_key: key }, null, 2)}\n`;
  try { await writeFile(join(await ledger(parent), `CONSUMED-${key}.json`), text, { mode: 0o400, flag: 'wx' }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('HELDOUT_ALREADY_CONSUMED'); throw e; }
  await recordHeldoutEvent(parent, { run: record.run, event: 'unsealed', cohort_key: key, at: record.at, detail_sha256: hash(text) });
  return hash(text);
}

/** Failure causes and capture reasons that mean the harness or confinement is broken, not a measured outcome. */
export const HARNESS_FAILURE_CAUSES: readonly string[] = ['harness_error', 'upstream_confinement_missing', 'upstream_count_mismatch'];
export const HARNESS_ATTEMPT_REASONS: readonly string[] = ['CATALOG_MISSING', 'WIRE_CAPTURE_MISSING', 'MODEL_CAPTURE_MISSING', 'EVAL_ACCOUNTING_MISMATCH'];
/** A broken harness must never consume the holdout: refuse to unseal while any development attempt shows one. */
export function assertDevelopmentSane(attempts: readonly Pick<Attempt, 'split' | 'reason' | 'eval'>[]): void {
  requireS11(!attempts.some(a => a.split === 'heldout'), 'HELDOUT_MEASURED_EARLY');
  const development = attempts.filter(a => a.split === 'development');
  requireS11(development.length > 0, 'DEVELOPMENT_MISSING');
  requireS11(!development.some(a => (a.reason !== undefined && HARNESS_ATTEMPT_REASONS.includes(a.reason))
    || a.eval?.failures.some(f => HARNESS_FAILURE_CAUSES.includes(f.cause))), 'DEVELOPMENT_HARNESS_FAILURE');
}
