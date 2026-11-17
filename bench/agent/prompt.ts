// Prompt and answer schema. The template and the schema live next to this file, verbatim.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256Hex } from '../lib/hash.js';
import { BENCH } from '../lib/paths.js';
import type { QuestionRecord } from '../lib/types.js';

export const PROMPT_TEMPLATE_PATH = join(BENCH, 'agent', 'prompt.template.txt');
export const ANSWER_SCHEMA_PATH = join(BENCH, 'agent', 'answer.schema.json');

/** Like the shell's "$(cat file)": trailing newlines are removed. */
const shellCat = (text: string) => text.replace(/\n+$/, '');

export interface PromptParts {
  patient_id: string;
  question: string;
  mimic_subject_id: string | null;
  reference_time: string | null;
  datastore_id?: string | null; // for servers that need a data store id (HealthLake); unused by the agent smoke test
}

export function renderPrompt(template: string, p: PromptParts): string {
  const values: Record<string, string> = {
    patient_id: p.patient_id,
    question: p.question,
    subject_id_sentence: p.mimic_subject_id ? ` This patient's MIMIC subject_id is ${p.mimic_subject_id}.` : '',
    datastore_sentence: p.datastore_id ? ` Datastore id: ${p.datastore_id}.` : '',
    reference_time_line: p.reference_time ? `Assume the current time is ${p.reference_time}.\n` : '',
  };
  const out = shellCat(template).replace(/\{\{([a-z_]+)\}\}/g, (_m, key: string) => {
    const v = values[key];
    if (v === undefined) throw new Error(`unknown prompt placeholder {{${key}}}`);
    return v;
  });
  for (const [k, v] of Object.entries(values)) if (/\{\{|\}\}/.test(v)) throw new Error(`placeholder syntax inside ${k}`);
  return out;
}

export function promptFor(template: string, q: QuestionRecord): string {
  if (q.reference_time !== null && !/(Z|[+-]\d\d:\d\d)$/.test(q.reference_time)) {
    throw new Error(`${q.id}: reference_time needs an explicit offset`);
  }
  return renderPrompt(template, {
    patient_id: q.patient_id,
    question: q.question,
    mimic_subject_id: q.mimic_subject_id,
    reference_time: q.reference_time,
  });
}

export interface LoadedPromptFiles { template: string; schemaText: string; schemaSha256: string; templateSha256: string }

export async function loadPromptFiles(): Promise<LoadedPromptFiles> {
  const template = await readFile(PROMPT_TEMPLATE_PATH, 'utf8');
  const schemaText = shellCat(await readFile(ANSWER_SCHEMA_PATH, 'utf8'));
  return { template, schemaText, schemaSha256: sha256Hex(schemaText), templateSha256: sha256Hex(template) };
}
