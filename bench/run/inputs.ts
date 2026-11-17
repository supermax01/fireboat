// Input digests a scripted campaign ran against. Recorded in every scripted manifest; bench:score
// refuses to score when the current files differ, so regenerated questions or gold never meet old runs silently.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sha256File } from '../lib/hash.js';
import { results, type DatasetId } from '../lib/paths.js';
import type { ArmId } from '../lib/types.js';

export const probesFile = (d: DatasetId) => join(results.questions(d), '..', 'probes.jsonl');
export const probeGoldFile = (d: DatasetId) => join(results.gold(d), '..', 'probe-gold.jsonl');

const sha = async (p: string) => (existsSync(p) ? sha256File(p) : null);

export interface DatasetInputs {
  questions: string | null; probes: string | null; gold: string | null; probe_gold: string | null; converted_manifest: string | null;
}

export async function datasetInputs(d: DatasetId): Promise<DatasetInputs> {
  return {
    questions: await sha(results.questions(d)),
    probes: await sha(probesFile(d)),
    gold: await sha(results.gold(d)),
    probe_gold: await sha(probeGoldFile(d)),
    converted_manifest: await sha(join(results.converted(d), 'manifest.json')),
  };
}

/** Stratum question and gold files a campaign ran against (bench:scripted --strata <dir>). */
export interface StrataInputs { dir: string; questions: string | null; gold: string | null }

export const strataFiles = (dir: string, d: DatasetId) => ({ questions: join(dir, d, 'questions.jsonl'), gold: join(dir, d, 'gold.jsonl') });

export async function strataInputs(dir: string, d: DatasetId): Promise<StrataInputs> {
  const f = strataFiles(dir, d);
  return { dir, questions: await sha(f.questions), gold: await sha(f.gold) };
}

export interface ArmInputs { install_manifest: string | null; dist_sha256?: string | null; package_lock_sha256?: string | null; wheel_sha256?: string | null }

export async function armInputs(arms: readonly ArmId[]): Promise<Record<string, ArmInputs>> {
  const out: Record<string, ArmInputs> = {};
  for (const a of arms) {
    const p = join(results.manifests, `install-${a === 'Ws' || a === 'Wm' ? 'W' : a}.json`); // Ws, Wm: W's install
    const m = existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>) : {};
    const pick = (k: string) => (typeof m[k] === 'string' ? (m[k] as string) : undefined);
    out[a] = { install_manifest: await sha(p), dist_sha256: pick('dist_sha256'), package_lock_sha256: pick('package_lock_sha256'), wheel_sha256: pick('wheel_sha256') };
  }
  return out;
}

export function infraImages(): Record<string, unknown> | null {
  const p = join(results.manifests, 'infra.json');
  if (!existsSync(p)) return null;
  const m = JSON.parse(readFileSync(p, 'utf8')) as { images?: Record<string, unknown> };
  return m.images ?? null;
}

export interface CampaignInputs {
  datasets: Partial<Record<DatasetId, DatasetInputs>>; manifests: string[]; missing: string[];
  strata?: Partial<Record<DatasetId, StrataInputs>>; // present only for campaigns run with --strata
}

/** Inputs recorded by every scripted manifest of a campaign; throws if two manifests of one dataset disagree. */
export function recordedInputs(campaign: string): CampaignInputs {
  const files = existsSync(results.manifests) ? readdirSync(results.manifests).filter(f => f.startsWith(`scripted-${campaign}-`) && f.endsWith('.json')).sort() : [];
  const out: CampaignInputs = { datasets: {}, manifests: [], missing: [] };
  for (const f of files) {
    const m = JSON.parse(readFileSync(join(results.manifests, f), 'utf8')) as { campaign?: string; dataset: DatasetId; inputs?: { dataset?: DatasetInputs; strata?: StrataInputs } };
    // The file prefix also matches campaigns whose name extends this one (dev-m1 vs dev-m1-strata); the recorded name decides.
    if (m.campaign !== undefined && m.campaign !== campaign) continue;
    out.manifests.push(f);
    if (m.inputs?.strata) {
      const prevS = out.strata?.[m.dataset];
      if (prevS && JSON.stringify(prevS) !== JSON.stringify(m.inputs.strata)) throw new Error(`scripted manifests of ${campaign}/${m.dataset} disagree on stratum inputs (${f})`);
      out.strata = { ...(out.strata ?? {}), [m.dataset]: m.inputs.strata };
    }
    const di = m.inputs?.dataset;
    if (!di) { out.missing.push(f); continue; }
    const prev = out.datasets[m.dataset];
    if (prev && JSON.stringify(prev) !== JSON.stringify(di)) throw new Error(`scripted manifests of ${campaign}/${m.dataset} disagree on inputs (${f})`);
    out.datasets[m.dataset] = di;
  }
  return out;
}

/**
 * Differences between recorded and current inputs, as "dataset.field: recorded != current". Stratum files are compared
 * in `strataDir` when given (bench:score --strata), else in the recorded directory.
 */
export async function inputMismatches(rec: CampaignInputs, strataDir?: string): Promise<string[]> {
  const diffs: string[] = rec.missing.map(f => `${f}: no input digests recorded`);
  for (const [d, r] of Object.entries(rec.datasets) as [DatasetId, DatasetInputs][]) {
    const now = await datasetInputs(d);
    for (const k of Object.keys(r) as (keyof DatasetInputs)[]) if (r[k] !== now[k]) diffs.push(`${d}.${k}: ${r[k]} != ${now[k]}`);
  }
  for (const [d, r] of Object.entries(rec.strata ?? {}) as [DatasetId, StrataInputs][]) {
    const now = await strataInputs(strataDir ?? r.dir, d);
    for (const k of ['questions', 'gold'] as const) if (r[k] !== now[k]) diffs.push(`${d}.strata.${k}: ${r[k]} != ${now[k]}`);
  }
  return diffs;
}
