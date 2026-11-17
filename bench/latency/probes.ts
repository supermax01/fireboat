// Latency probes: 10 single-call operations per dataset, all for one patient so that one server session
// (fireboat binds the patient by configuration) can run them all. Built from converted/<dataset>/ only; code systems
// and codes are taken from the data, never written here.
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { rankHash } from '../lib/hash.js';
import { parseLossless } from '../lib/json.js';
import { results, type DatasetId } from '../lib/paths.js';
import { isObj, type Obj } from '../data/fhir.js';

export type ProbeOp = { op: 'read'; type: string; id: string } | { op: 'search'; type: string; params: [string, string][] };
export interface LatencyProbe { id: string; label: string; op: ProbeOp }
export interface ProbeSet { schema: 'fbbench.latency-probes/1'; dataset: DatasetId; seed_hex: string; patient_id: string; probes: LatencyProbe[] }

export const PROBE_COUNT = 10;
/** Patient-compartment types searched by patient, in preference order (types the patient lacks are skipped). */
export const SEARCH_TYPES = ['Condition', 'MedicationRequest', 'Encounter', 'Procedure', 'DiagnosticReport', 'Immunization', 'MedicationAdministration', 'AllergyIntolerance', 'CarePlan', 'Specimen', 'MedicationDispense', 'Claim'];

const byHash = <T>(xs: T[], key: (x: T) => string, label: string, seed: string): T[] =>
  xs.map(x => ({ x, h: rankHash('scripted', seed, label, key(x)) })).sort((a, b) => (a.h < b.h ? -1 : a.h > b.h ? 1 : 0)).map(e => e.x);

async function patientResources(dataset: DatasetId, type: string, patientId: string): Promise<Obj[]> {
  const out: Obj[] = [];
  const needle = `"Patient/${patientId}"`;
  const rl = createInterface({ input: createReadStream(join(results.converted(dataset), `${type}.ndjson`), { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.includes(needle)) continue;
    const r = parseLossless(line);
    if (!isObj(r)) continue;
    const s = (isObj(r.subject) ? r.subject : isObj(r.patient) ? r.patient : null);
    if (s && s.reference === `Patient/${patientId}`) out.push(r);
  }
  return out;
}

const codings = (cc: unknown): { system: string; code: string }[] =>
  isObj(cc) && Array.isArray(cc.coding) ? cc.coding.filter(isObj).flatMap(c => (typeof c.system === 'string' && typeof c.code === 'string' ? [{ system: c.system, code: c.code }] : [])) : [];

/** The patient (first by rank hash with Observations, Encounters and enough searchable types) and the 10 probes. */
export async function buildProbes(dataset: DatasetId, seedHex: string): Promise<ProbeSet> {
  const patients = JSON.parse(await readFile(join(results.converted(dataset), 'patients.json'), 'utf8')) as { patient_id: string; by_type: Record<string, number> }[]; // our own file
  const eligible = patients.filter(p => (p.by_type.Observation ?? 0) > 0 && (p.by_type.Encounter ?? 0) > 0 && SEARCH_TYPES.filter(t => (p.by_type[t] ?? 0) > 0).length >= 6);
  const patient = byHash(eligible, p => p.patient_id, 'latency-patient', seedHex)[0];
  if (!patient) throw new Error(`${dataset}: no patient with Observations, Encounters and six searchable types`);
  const pid = patient.patient_id;
  const P: [string, string] = ['patient', `Patient/${pid}`];
  const observations = await patientResources(dataset, 'Observation', pid);
  const encounters = await patientResources(dataset, 'Encounter', pid);
  const obs = byHash(observations, r => String(r.id), 'latency-observation', seedHex)[0]!;
  const enc = byHash(encounters, r => String(r.id), 'latency-encounter', seedHex)[0]!;
  const codes = [...new Map(observations.flatMap(r => codings(r.code)).map(c => [`${c.system}|${c.code}`, c])).keys()];
  const code = byHash(codes, c => c, 'latency-code', seedHex)[0]!;
  const categories = [...new Set(observations.flatMap(r => (Array.isArray(r.category) ? r.category.flatMap(codings) : [])).map(c => `${c.system}|${c.code}`))];
  const category = byHash(categories, c => c, 'latency-category', seedHex)[0];
  const probes: Omit<LatencyProbe, 'id'>[] = [
    { label: 'read Patient', op: { op: 'read', type: 'Patient', id: pid } },
    { label: 'read Observation', op: { op: 'read', type: 'Observation', id: String(obs.id) } },
    { label: 'read Encounter', op: { op: 'read', type: 'Encounter', id: String(enc.id) } },
    { label: 'search Observation by code', op: { op: 'search', type: 'Observation', params: [P, ['code', code]] } },
  ];
  if (category) probes.push({ label: 'search Observation by category', op: { op: 'search', type: 'Observation', params: [P, ['category', category]] } });
  for (const t of SEARCH_TYPES) {
    if (probes.length >= PROBE_COUNT) break;
    if ((patient.by_type[t] ?? 0) > 0) probes.push({ label: `search ${t}`, op: { op: 'search', type: t, params: [P] } });
  }
  if (probes.length < PROBE_COUNT) throw new Error(`${dataset}: only ${probes.length} probes for ${pid}`);
  return { schema: 'fbbench.latency-probes/1', dataset, seed_hex: seedHex, patient_id: pid, probes: probes.map((p, i) => ({ id: `P${String(i + 1).padStart(2, '0')}`, ...p })) };
}

/** Probe order for one round: ascending rank hash (purpose "order"), different per round. */
export function roundOrder(probes: readonly LatencyProbe[], seedHex: string, dataset: string, round: number): LatencyProbe[] {
  return byHashOrder(probes, seedHex, `latency-${dataset}-round-${round}`);
}
const byHashOrder = (probes: readonly LatencyProbe[], seedHex: string, label: string) =>
  probes.map(p => ({ p, h: rankHash('order', seedHex, label, p.id) })).sort((a, b) => (a.h < b.h ? -1 : 1)).map(e => e.p);
