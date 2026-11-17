// Question and probe generation: templates, the hashed selection rule and the confinement and write probes. The
// development datasets use the development seed; the holdout uses the public randomness that drew it.
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DEV_SEED_HEX } from '../lib/hash.js';
import { DATASETS, type DatasetId } from '../lib/paths.js';
import { holdoutConvertManifest } from './reader.js';
import type { QuestionRecord, SeedInfo } from '../lib/types.js';
import { confinementProbes, sharedMedicationIndex, summarize, writeProbes, type PatientSummary, type ProbeRecord } from './probes.js';
import { makeCandidate, phrasings, select, type Candidate, type Selection } from './select.js';
import { forEachPatient, goldPaths, type SourcePass } from './source.js';
import { GROUPS, STRATA_GROUPS, TEMPLATES, c2NoProposal, conditionConcepts, groupOf, type GroupSpec, type StratumId } from './templates.js';

export const DEV_SEED: SeedInfo = { kind: 'dev', hex: DEV_SEED_HEX, purpose: 'saq' };

/**
 * The seed a dataset's questions, probes and strata are drawn with. mimic and synthea-dev: the development seed. The
 * holdout: the drand randomness that drew it, as `bench:holdout -- convert` recorded it.
 */
export function seedFor(dataset: DatasetId): SeedInfo {
  if (dataset !== 'synthea-holdout') return DEV_SEED;
  const { path, m } = holdoutConvertManifest();
  const s = m.seed;
  if (s?.kind !== 'drand' || !/^[0-9a-f]{64}$/.test(s.hex ?? '') || !/^[0-9]+$/.test(s.round ?? '') || !/^[0-9a-f]{64}$/.test(s.chain_hash ?? '')) {
    throw new Error(`${path}: the holdout seed is not a drand round (kind, hex, round, chain_hash)`);
  }
  return { kind: 'drand', hex: s.hex!, purpose: 'saq', round: s.round!, chain_hash: s.chain_hash! };
}

/** Manifest note for a seed. */
export const seedNote = (seed: SeedInfo): string => (seed.kind === 'dev'
  ? 'development seed (64 zeros): a fixed seed for development, not a random draw'
  : `drand round ${seed.round} randomness, the seed that drew the holdout (purpose saq for questions and strata, scripted for probes)`);

export function toQuestion(dataset: DatasetId, c: Candidate, phrasing: 'concept' | 'code', seed: SeedInfo = DEV_SEED): QuestionRecord {
  const t = TEMPLATES.get(c.templateId)!;
  return {
    schema: 'fbbench.question/1',
    id: `${dataset}.${c.templateId}.${c.hash.slice(0, 12)}`,
    dataset,
    patient_id: c.patientId,
    template_id: c.templateId,
    group: groupOf(dataset, c.templateId),
    category: t.category,
    encounter_scoped: t.encounterScoped,
    phrasing,
    question: t.text(c.prop.parameters, phrasing),
    reference_time: null,
    mimic_subject_id: null,
    parameters: c.prop.parameters,
    operations: c.prop.operations,
    answer_form: t.answerForm,
    seed,
    rank_hash: c.hash,
    candidate_key: c.candidateKey,
  };
}

export interface Generated {
  questions: QuestionRecord[];
  probes: ProbeRecord[];
  pools: Map<string, Candidate[]>;
  selection: Selection;
  pass: SourcePass;
  summaries: PatientSummary[];
}

export async function generate(dataset: DatasetId, seed: SeedInfo = DEV_SEED): Promise<Generated> {
  const pools = new Map<string, Candidate[]>();
  const templateIds = GROUPS[dataset].flatMap(g => g.templates);
  const summaries: PatientSummary[] = [];
  const conditions = new Map<string, Map<string, { code_system: string; code: string; display: string }>>();
  const pass = await forEachPatient(dataset, ctx => {
    for (const id of templateIds) {
      const list = pools.get(id) ?? [];
      for (const prop of TEMPLATES.get(id)!.propose(ctx, dataset)) list.push(makeCandidate('saq', seed.hex, id, ctx.data.patientId, prop));
      pools.set(id, list);
    }
    summaries.push(summarize(ctx, dataset));
    conditions.set(ctx.data.patientId, conditionConcepts(ctx));
  });
  // C2 "no" stratum: codes other development patients have and this one does not.
  const global = new Map<string, { code_system: string; code: string; display: string }>();
  for (const m of conditions.values()) for (const [k, c] of m) if (!global.has(k)) global.set(k, c);
  for (const [pid, own] of conditions) for (const [k, c] of global) if (!own.has(k)) {
    pools.get('C2')!.push(makeCandidate('saq', seed.hex, 'C2', pid, c2NoProposal(pid, c)));
  }
  const selection = select(dataset, pools);
  const ph = phrasings(selection.selected, id => TEMPLATES.get(id)!.phrasable);
  const questions = selection.selected.map(c => toQuestion(dataset, c, ph.get(c)!, seed));
  if (new Set(questions.map(q => q.id)).size !== questions.length) throw new Error('question id collision');
  const sharedMeds = new Map<string, string[]>();
  for (const s of pass.sharedAll) sharedMedicationIndex(s.byRef.values(), sharedMeds);
  const probes = [...confinementProbes(dataset, summaries, seed, sharedMeds), ...writeProbes(dataset, summaries, seed)].map(b => b.probe);
  return { questions, probes, pools, selection, pass, summaries };
}

export interface StrataGenerated {
  questions: QuestionRecord[];
  pools: Map<string, Candidate[]>;
  selections: Partial<Record<StratumId, Selection>>;
  dropped: Partial<Record<StratumId, string[]>>; // templates left out of the split because their pool is empty
  pass: SourcePass;
}

/** Stratum rule: a template with an empty candidate pool is left out before the group's count is split. */
export function strataGroups(groups: GroupSpec[], pools: Map<string, Candidate[]>): { groups: GroupSpec[]; dropped: string[] } {
  const dropped: string[] = [];
  const out = groups.map(g => {
    const keep = g.templates.filter(t => (pools.get(t)?.length ?? 0) > 0);
    dropped.push(...g.templates.filter(t => !keep.includes(t)));
    return { ...g, templates: keep.length > 0 ? keep : g.templates };
  });
  return { groups: out, dropped };
}

/**
 * Stratum question sets (long-list and decimal; bench/README.md). Same seed rule and candidate hashing as generate(); each
 * stratum is selected on its own allocation table, independently of the main set and of the other stratum. No probes.
 */
export async function generateStrata(dataset: DatasetId, strata: readonly StratumId[], seed: SeedInfo = DEV_SEED): Promise<StrataGenerated> {
  const pools = new Map<string, Candidate[]>();
  const templateIds = strata.flatMap(s => STRATA_GROUPS[s][dataset].flatMap(g => g.templates));
  const pass = await forEachPatient(dataset, ctx => {
    for (const id of templateIds) {
      const list = pools.get(id) ?? [];
      for (const prop of TEMPLATES.get(id)!.propose(ctx, dataset, seed.hex)) list.push(makeCandidate('saq', seed.hex, id, ctx.data.patientId, prop));
      pools.set(id, list);
    }
  });
  const questions: QuestionRecord[] = [];
  const selections: Partial<Record<StratumId, Selection>> = {};
  const dropped: Partial<Record<StratumId, string[]>> = {};
  for (const s of strata) {
    const g = strataGroups(STRATA_GROUPS[s][dataset], pools);
    dropped[s] = g.dropped;
    // Each group is selected on its own: a shortfall never moves to another band or stratum.
    const parts = g.groups.map(group => select(dataset, pools, [group]));
    const selection: Selection = {
      selected: parts.flatMap(x => x.selected), report: Object.assign({}, ...parts.map(x => x.report)),
      unfilled: parts.reduce((n, x) => n + x.unfilled, 0), distinctPatients: new Set(parts.flatMap(x => x.selected.map(c => c.patientId))).size,
    };
    selections[s] = selection;
    const ph = phrasings(selection.selected, id => TEMPLATES.get(id)!.phrasable);
    questions.push(...selection.selected.map(c => toQuestion(dataset, c, ph.get(c)!, seed)));
  }
  if (new Set(questions.map(q => q.id)).size !== questions.length) throw new Error('question id collision');
  return { questions, pools, selections, dropped, pass };
}

/** Rebuilds .local/bench-results/dev/<file> from the per-dataset files that exist (mimic first). */
export async function rebuildDev(file: string, perDataset: (d: DatasetId) => string): Promise<string> {
  const lines: string[] = [];
  for (const d of DATASETS) if (existsSync(perDataset(d))) lines.push(...readFileSync(perDataset(d), 'utf8').split('\n').filter(Boolean));
  const out = goldPaths.dev(file);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, lines.map(l => l + '\n').join(''), 'utf8');
  return out;
}
