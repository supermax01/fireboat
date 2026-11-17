// Allocation, constraints and fill rule for question selection, in rank-hash order (lib/hash.ts). Deterministic: no
// randomness anywhere.
import { rankHash, type SeedPurpose } from '../lib/hash.js';
import type { DatasetId } from '../lib/types.js';
import { GROUPS, MAX_PER_PATIENT, type GroupSpec, type Proposal } from './templates.js';

export interface Candidate {
  templateId: string;
  patientId: string;
  prop: Proposal;
  candidateKey: string; // `${patient}|${prop.key}`
  hash: string;
}

export function makeCandidate(purpose: SeedPurpose, seedHex: string, templateId: string, patientId: string, prop: Proposal): Candidate {
  const candidateKey = `${patientId}|${prop.key}`;
  return { templateId, patientId, prop, candidateKey, hash: rankHash(purpose, seedHex, templateId, candidateKey) };
}

/** Equal split by script: floor for each, the remainder to the earliest templates in table order. */
export function splitEvenly(total: number, n: number): number[] {
  const base = Math.floor(total / n), rem = total - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < rem ? 1 : 0));
}

const byHash = (a: Candidate, b: Candidate) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0);

/** Hash order; a stratified template (C2) alternates strata, each in hash order, starting with the lowest hash. */
export function candidateOrder(cands: Candidate[]): Candidate[] {
  const strata = new Map<string, Candidate[]>();
  for (const c of cands) { const s = c.prop.stratum ?? ''; strata.set(s, [...(strata.get(s) ?? []), c]); }
  if (strata.size <= 1) return [...cands].sort(byHash);
  const lists = [...strata.values()].map(l => l.sort(byHash)).sort((a, b) => byHash(a[0]!, b[0]!));
  const out: Candidate[] = [];
  for (let i = 0; out.length < cands.length; i++) for (const l of lists) if (i < l.length) out.push(l[i]!);
  return out;
}

export interface TemplateReport { group: string; pool: number; target: number; selected: number; cap_lifted: boolean; shortfall: number; carried_in: number }

export interface Selection { selected: Candidate[]; report: Record<string, TemplateReport>; unfilled: number; distinctPatients: number }

/** `groups` defaults to the dataset's main allocation table; a stratum passes its own. */
export function select(dataset: DatasetId, pools: Map<string, Candidate[]>, groups: GroupSpec[] = GROUPS[dataset]): Selection {
  const perPatient = new Map<string, number>();
  const used = new Set<string>();
  const selected: Candidate[] = [];
  const report: Record<string, TemplateReport> = {};
  let carryGroup = 0;
  for (const group of groups) {
    const base = splitEvenly(group.count + carryGroup, group.templates.length);
    carryGroup = 0;
    let carry = 0;
    group.templates.forEach((t, i) => {
      const target = base[i]! + carry;
      const order = candidateOrder(pools.get(t) ?? []);
      const picked = new Set<Candidate>();
      const take = (c: Candidate) => {
        picked.add(c);
        used.add(`${c.patientId}|${t}|${c.prop.dedupe}`);
        perPatient.set(c.patientId, (perPatient.get(c.patientId) ?? 0) + 1);
      };
      for (const c of order) {
        if (picked.size >= target) break;
        if (used.has(`${c.patientId}|${t}|${c.prop.dedupe}`)) continue;
        if ((perPatient.get(c.patientId) ?? 0) >= MAX_PER_PATIENT) continue;
        take(c);
      }
      const capLifted = picked.size < target;
      if (capLifted) {
        for (const c of order) { // fill rule step 1: lift the per-patient cap for this template only, in hash order
          if (picked.size >= target) break;
          if (picked.has(c) || used.has(`${c.patientId}|${t}|${c.prop.dedupe}`)) continue;
          take(c);
        }
      }
      const shortfall = target - picked.size;
      report[t] = { group: group.name, pool: order.length, target, selected: picked.size, cap_lifted: capLifted, shortfall, carried_in: carry };
      selected.push(...order.filter(c => picked.has(c)));
      carry = shortfall; // fill rule step 2: next template in the group
    });
    carryGroup = carry; // fill rule step 3: next group in table order
  }
  return { selected, report, unfilled: carryGroup, distinctPatients: new Set(selected.map(c => c.patientId)).size };
}

/** Half of a template's instances name the concept only, alternating in hash order. */
export function phrasings(selected: Candidate[], phrasable: (templateId: string) => boolean): Map<Candidate, 'concept' | 'code'> {
  const out = new Map<Candidate, 'concept' | 'code'>();
  const byTemplate = new Map<string, Candidate[]>();
  for (const c of selected) byTemplate.set(c.templateId, [...(byTemplate.get(c.templateId) ?? []), c]);
  for (const list of byTemplate.values()) {
    let i = 0;
    for (const c of [...list].sort(byHash)) {
      if (!phrasable(c.templateId) || !c.prop.parameters.code) { out.set(c, 'concept'); continue; }
      out.set(c, i++ % 2 === 0 ? 'concept' : 'code');
    }
  }
  return out;
}
