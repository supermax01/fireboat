// Gold computation shared by bench:gold and the tests (rules in bench/GOLD-RULINGS.md).
import { readFileSync } from 'node:fs';
import { parseNumbersAsStrings } from '../lib/json.js';
import type { DatasetId } from '../lib/paths.js';
import type { GoldRecord, QuestionRecord } from '../lib/types.js';
import { seedFor } from './generate.js';
import { confinementProbes, sharedMedicationIndex, summarize, writeProbes, type PatientSummary } from './probes.js';
import { computeCore, lexemeEligible, type Ctx } from './rules.js';
import { forEachPatient } from './source.js';

export function goldRecord(q: Pick<QuestionRecord, 'id' | 'dataset' | 'patient_id' | 'template_id' | 'parameters' | 'answer_form'>, ctx: Ctx): GoldRecord {
  const core = computeCore({ template_id: q.template_id, parameters: q.parameters, patient_id: q.patient_id }, ctx);
  if (core.answer_form !== q.answer_form) throw new Error(`${q.id}: answer form ${core.answer_form} != ${q.answer_form}`);
  const size = core.depends_on.length;
  return {
    schema: 'fbbench.gold/1', question_id: q.id, dataset: q.dataset, patient_id: q.patient_id, implementation: 'ts',
    answer_form: core.answer_form, answer_kind: core.answer_kind, answer: core.answer, answer_list: core.answer_list,
    value_as_recorded: core.value_as_recorded, unit: core.unit, timestamp: core.timestamp, items: core.items,
    provenance: core.provenance, depends_on: core.depends_on, completeness: { size, pages_at_100: Math.max(1, Math.ceil(size / 100)) },
    lexeme_eligible: lexemeEligible(core), rule_notes: core.rule_notes,
  };
}

export const readRecords = <T>(path: string): T[] => readFileSync(path, 'utf8').split('\n').filter(Boolean).map(l => parseNumbersAsStrings(l) as T);

export async function computeGold(dataset: DatasetId, questions: QuestionRecord[]) {
  const byPatient = new Map<string, QuestionRecord[]>();
  for (const q of questions) byPatient.set(q.patient_id, [...(byPatient.get(q.patient_id) ?? []), q]);
  const gold = new Map<string, GoldRecord>();
  const failures: { question_id: string; error: string }[] = [];
  const summaries: PatientSummary[] = [];
  const pass = await forEachPatient(dataset, ctx => {
    summaries.push(summarize(ctx, dataset));
    for (const q of byPatient.get(ctx.data.patientId) ?? []) {
      try { gold.set(q.id, goldRecord(q, ctx)); } catch (e) { failures.push({ question_id: q.id, error: e instanceof Error ? e.message : String(e) }); }
    }
  });
  const sharedMeds = new Map<string, string[]>();
  for (const s of pass.sharedAll) sharedMedicationIndex(s.byRef.values(), sharedMeds);
  const seed = seedFor(dataset); // probe gold regenerates the probes with the dataset's seed
  const probes = [...confinementProbes(dataset, summaries, seed, sharedMeds), ...writeProbes(dataset, summaries, seed)];
  const ordered = questions.map(q => gold.get(q.id)).filter((g): g is GoldRecord => !!g);
  return { gold: ordered, failures, probes, pass };
}

