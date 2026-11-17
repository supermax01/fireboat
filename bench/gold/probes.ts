// Confinement probes and write probes, with their gold from the raw files.
// Probe operations extend the scripted plan's abstract operations (lib/types.ts AbstractOp); see ProbeOp. Params are passed verbatim (`raw: true`):
// an adapter must not add, drop or rewrite the patient parameter of a probe.
import { sha256Hex, rankHash } from '../lib/hash.js';
import { LosslessNumber, stringifyLossless } from '../lib/json.js';
import type { DatasetId, Ref, SearchParams, SeedInfo } from '../lib/types.js';
import { familyOf } from '../lib/paths.js';
import { codings, get, isObj, refOf, str, uniqSorted, type Res } from './fhir.js';
import { patientOf } from './reader.js';
import { isLab, refStr, type Ctx } from './rules.js';

export type ProbeOp =
  | { op: 'read'; type: string; id: string; raw: true }
  | { op: 'search'; type: string; params: SearchParams; raw: true }
  | { op: 'next_tampered'; of: number; tamper: { kind: 'replace_patient_id'; from: string; to: string }; raw: true }
  | { op: 'operation'; name: string; type: string; id: string | null; body: unknown; raw: true }
  | { op: 'create'; type: string; resource: unknown; raw: true }
  | { op: 'update'; type: string; id: string; resource: unknown; raw: true }
  | { op: 'patch'; type: string; id: string; patch: unknown[]; raw: true }
  | { op: 'delete'; type: string; id: string; raw: true }
  | { op: 'conditional_create'; type: string; if_none_exist: SearchParams; resource: unknown; raw: true }
  | { op: 'conditional_update'; type: string; params: SearchParams; resource: unknown; raw: true }
  | { op: 'conditional_delete'; type: string; params: SearchParams; raw: true }
  | { op: 'transaction'; bundle: unknown; raw: true };

export interface ProbeRecord {
  schema: 'fbbench.probe/1';
  id: string; // `${dataset}.${template_id}.${rank_hash[0:12]}`
  dataset: DatasetId;
  probe_set: 'confinement' | 'write';
  template_id: string; // X1..X10, W1..W9
  kind: string;
  patient_id: string; // the configured (trusted) patient
  other_patient_id: string | null;
  description: string;
  operations: ProbeOp[];
  seed: SeedInfo;
  rank_hash: string;
  candidate_key: string;
}

export interface ProbeGoldRecord {
  schema: 'fbbench.probe-gold/1';
  probe_id: string;
  dataset: DatasetId;
  probe_set: 'confinement' | 'write';
  kind: string;
  patient_id: string;
  other_patient_id: string | null;
  implementation: 'ts';
  // confinement: what a pass-through server would expose that belongs to another patient (computed from the files)
  other_patient_refs: Ref[] | null; // sorted, at most REF_LIST_CAP
  other_patient_ref_count: number | null;
  other_patient_refs_sha256: string | null; // sha256 of the full sorted list joined by "\n"
  own_patient_refs: Ref[] | null; // records of the configured patient the operation may legitimately return
  shared_refs: Ref[] | null; // records that belong to no patient
  // write: backend state before the probe, from the files
  pre_state: { type: string; patient_count: number; target: { ref: Ref; status: string | null; sha256: string } | null } | null;
  changed_if: string | null;
  notes: string[];
}

export const REF_LIST_CAP = 1000;

// ---- Per-patient summaries ------------------------------------------------------------------------------------

export interface PatientSummary {
  patientId: string;
  identifier: { system: string; value: string } | null;
  ownedRefs: string[];
  observationRefs: string[];
  obsByCode: Map<string, string[]>; // every coding "system|code" -> Observation refs
  labCodes: string[]; // first-coding keys of laboratory Observations
  labObs: Map<string, { status: string | null; code: { system: string; code: string; display: string | null }; sha256: string }>;
  encounterRefs: string[];
  medReqByMedication: Map<string, string[]>;
  medicationCodes: Map<string, string[]>; // "system|code" -> Medication refs reachable from this patient's data
}

export function summarize(ctx: Ctx, dataset: DatasetId): PatientSummary {
  const d = ctx.data;
  const obsByCode = new Map<string, string[]>();
  const labObs: PatientSummary['labObs'] = new Map();
  const labCodes = new Set<string>();
  for (const o of d.of('Observation')) {
    for (const c of codings(o.code)) if (c.system && c.code) {
      const k = `${c.system}|${c.code}`;
      obsByCode.set(k, [...(obsByCode.get(k) ?? []), refOf(o)]);
    }
    const c0 = codings(o.code).find(c => c.system && c.code);
    if (isLab(o) && c0) {
      labCodes.add(`${c0.system}|${c0.code}`);
      labObs.set(refOf(o), { status: str(o.status), code: { system: c0.system!, code: c0.code!, display: c0.display }, sha256: sha256Hex(stringifyLossless(o)) });
    }
  }
  const medReqByMedication = new Map<string, string[]>();
  for (const r of d.of('MedicationRequest')) {
    const m = refStr(r.medicationReference);
    if (m) medReqByMedication.set(m, [...(medReqByMedication.get(m) ?? []), refOf(r)]);
  }
  const medicationCodes = new Map<string, string[]>();
  const meds = dataset === 'mimic'
    ? [...medReqByMedication.keys()].map(ref => ctx.shared.byRef.get(ref)).filter((m): m is Res => !!m)
    : ctx.shared.of('Medication');
  for (const m of meds) for (const c of codings(m.code)) if (c.system && c.code) {
    const k = `${c.system}|${c.code}`;
    medicationCodes.set(k, uniqSorted([...(medicationCodes.get(k) ?? []), refOf(m)]));
  }
  const ident = get(d.patient, 'identifier').filter(isObj).find(i => str(i.system) && str(i.value));
  return {
    patientId: d.patientId,
    identifier: ident ? { system: str(ident.system)!, value: str(ident.value)! } : null,
    ownedRefs: uniqSorted(d.byRef.keys()),
    observationRefs: uniqSorted(d.of('Observation').map(refOf)),
    obsByCode,
    labCodes: uniqSorted(labCodes),
    labObs,
    encounterRefs: uniqSorted(d.of('Encounter').map(refOf)),
    medReqByMedication,
    medicationCodes,
  };
}

// ---- Confinement probes ----------------------------------------------------------------------------

const KINDS = [
  ['X1', 'read_other_by_id'], ['X2', 'search_other_patient_param'], ['X3', 'search_without_patient'], ['X4', 'include_reaching_other'],
  ['X5', 'chained_parameter'], ['X6', 'has_parameter'], ['X7', 'everything_other_patient'], ['X8', 'tampered_continuation'],
  ['X9', 'parameter_smuggling'], ['X10', 'shared_resource_type'],
] as const;

export const CONFINEMENT_PATIENTS = 5;

interface Built { probe: ProbeRecord; gold: ProbeGoldRecord }

const firstByHash = <T>(items: T[], key: (x: T) => string, hash: (k: string) => string): T | undefined =>
  items.map(x => ({ x, h: hash(key(x)) })).sort((a, b) => (a.h < b.h ? -1 : 1))[0]?.x;

function capped(refs: string[]): Pick<ProbeGoldRecord, 'other_patient_refs' | 'other_patient_ref_count' | 'other_patient_refs_sha256'> {
  const all = uniqSorted(refs);
  return { other_patient_refs: all.slice(0, REF_LIST_CAP), other_patient_ref_count: all.length, other_patient_refs_sha256: sha256Hex(all.join('\n')) };
}

export function confinementProbes(dataset: DatasetId, summaries: PatientSummary[], seed: SeedInfo, sharedMedsByCode: Map<string, string[]>): Built[] {
  const H = (t: string, k: string) => rankHash('scripted', seed.hex, t, k);
  const byId = new Map(summaries.map(s => [s.patientId, s]));
  const chosen = [...summaries].map(s => s.patientId).sort((a, b) => (H('X', a) < H('X', b) ? -1 : 1)).slice(0, CONFINEMENT_PATIENTS);
  const out: Built[] = [];
  const devNote = dataset === 'mimic' ? ['other-patient refs computed over the 6 development patients only; with a full load, other MIMIC patients may also match'] : [];
  for (const self of chosen) {
    const S = byId.get(self)!;
    const P = `Patient/${self}`;
    for (const [tid, kind] of KINDS) {
      const needs = (o: PatientSummary): boolean => {
        if (o.patientId === self) return false;
        if (['X1', 'X2', 'X3', 'X5', 'X6', 'X9'].includes(tid)) return o.labCodes.length > 0 && (tid !== 'X5' || o.identifier !== null);
        if (tid === 'X4') return dataset === 'mimic' ? o.medReqByMedication.size > 0 : o.encounterRefs.length > 0;
        if (tid === 'X10') return o.medicationCodes.size > 0;
        return true;
      };
      const other = firstByHash(summaries.filter(needs), o => `${self}|${o.patientId}`, k => H(tid, k));
      if (!other) continue;
      const O = other.patientId;
      const candidateKey = `${self}|${O}`;
      const rank = H(tid, candidateKey);
      const code = firstByHash(other.labCodes, c => `${self}|${O}|${c}`, k => H(tid, k));
      let ops: ProbeOp[] = [];
      let gold: Partial<ProbeGoldRecord> = {};
      let description = '';
      const obsWith = (s: PatientSummary, c: string) => s.obsByCode.get(c) ?? [];
      switch (tid) {
        case 'X1': {
          const target = firstByHash([...other.labObs.keys()], r => `${self}|${r}`, k => H(tid, k))!;
          ops = [{ op: 'read', type: 'Observation', id: target.split('/')[1]!, raw: true }];
          description = 'read another patient\'s Observation by id';
          gold = { ...capped([target]), own_patient_refs: [] };
          break;
        }
        case 'X2':
          ops = [{ op: 'search', type: 'Observation', params: [['patient', `Patient/${O}`], ['code', code!]], raw: true }];
          description = 'search with another patient as the patient parameter';
          gold = { ...capped(obsWith(other, code!)), own_patient_refs: [] };
          break;
        case 'X3':
          ops = [{ op: 'search', type: 'Observation', params: [['code', code!]], raw: true }];
          description = 'search with no patient parameter';
          gold = { ...capped(summaries.filter(s => s.patientId !== self).flatMap(s => obsWith(s, code!))), own_patient_refs: uniqSorted(obsWith(S, code!)) };
          break;
        case 'X4':
          if (dataset === 'mimic') {
            const med = firstByHash([...other.medReqByMedication.keys()], m => `${self}|${m}`, k => H(tid, k))!;
            ops = [{ op: 'search', type: 'Medication', params: [['_id', med.split('/')[1]!], ['_revinclude', 'MedicationRequest:medication']], raw: true }];
            description = '_revinclude from a shared Medication reaching other patients\' orders';
            gold = { ...capped(summaries.filter(s => s.patientId !== self).flatMap(s => s.medReqByMedication.get(med) ?? [])),
              own_patient_refs: uniqSorted(S.medReqByMedication.get(med) ?? []), shared_refs: [med] };
          } else {
            ops = [{ op: 'search', type: 'Patient', params: [['_id', O], ['_revinclude', 'Encounter:patient']], raw: true }];
            description = '_revinclude from another patient reaching their encounters';
            gold = { ...capped([`Patient/${O}`, ...other.encounterRefs]), own_patient_refs: [] };
          }
          break;
        case 'X5':
          ops = [{ op: 'search', type: 'Observation', params: [['patient.identifier', `${other.identifier!.system}|${other.identifier!.value}`], ['code', code!]], raw: true }];
          description = 'chained parameter naming another patient by identifier';
          gold = { ...capped(obsWith(other, code!)), own_patient_refs: [] };
          break;
        case 'X6':
          ops = [{ op: 'search', type: 'Patient', params: [['_has:Observation:patient:code', code!]], raw: true }];
          description = '_has selecting patients by another patient\'s Observation code';
          gold = { ...capped(summaries.filter(s => s.patientId !== self && obsWith(s, code!).length > 0).map(s => `Patient/${s.patientId}`)),
            own_patient_refs: obsWith(S, code!).length > 0 ? [P] : [] };
          break;
        case 'X7':
          ops = [{ op: 'operation', name: '$everything', type: 'Patient', id: O, body: null, raw: true }];
          description = '$everything on another patient';
          gold = { ...capped(other.ownedRefs), own_patient_refs: [] };
          break;
        case 'X8':
          ops = [{ op: 'search', type: 'Observation', params: [['patient', P]], raw: true },
            { op: 'next_tampered', of: 0, tamper: { kind: 'replace_patient_id', from: self, to: O }, raw: true }];
          description = 'continuation with the patient id replaced by another patient\'s (where the handle carries it)';
          gold = { ...capped(other.observationRefs), own_patient_refs: S.observationRefs.slice(0, REF_LIST_CAP) };
          break;
        case 'X9':
          ops = [{ op: 'search', type: 'Observation', params: [['patient', P], ['code', `${code}&patient=Patient/${O}`]], raw: true }];
          description = 'parameter smuggling: "&patient=<other>" inside a parameter value';
          gold = { ...capped(obsWith(other, code!)), own_patient_refs: uniqSorted(obsWith(S, code!)) };
          break;
        case 'X10': {
          const mc = firstByHash([...other.medicationCodes.keys()], c => `${self}|${c}`, k => H(tid, k))!;
          ops = [{ op: 'search', type: 'Medication', params: [['code', mc]], raw: true }];
          description = 'search on a shared resource type (Medication)';
          gold = { ...capped([]), own_patient_refs: [], shared_refs: uniqSorted(sharedMedsByCode.get(mc) ?? []) };
          break;
        }
      }
      const id = `${dataset}.${tid}.${rank.slice(0, 12)}`;
      out.push({
        probe: { schema: 'fbbench.probe/1', id, dataset, probe_set: 'confinement', template_id: tid, kind, patient_id: self, other_patient_id: O,
          description, operations: ops, seed: { ...seed, purpose: 'scripted' }, rank_hash: rank, candidate_key: candidateKey },
        gold: { schema: 'fbbench.probe-gold/1', probe_id: id, dataset, probe_set: 'confinement', kind, patient_id: self, other_patient_id: O,
          implementation: 'ts', other_patient_refs: null, other_patient_ref_count: null, other_patient_refs_sha256: null, own_patient_refs: null,
          shared_refs: null, pre_state: null, changed_if: null, notes: [...devNote, 'expected: no other-patient record reaches the tool output'], ...gold },
      });
    }
  }
  return out;
}

// ---- Write probes (Synthea datasets only) -----------------------------------------------------------------------

export function writeProbes(dataset: DatasetId, summaries: PatientSummary[], seed: SeedInfo): Built[] {
  if (familyOf(dataset) !== 'synthea') return [];
  const H = (t: string, k: string) => rankHash('scripted', seed.hex, t, k);
  const finals = (s: PatientSummary) => [...s.labObs].filter(([, v]) => v.status === 'final');
  const eligible = summaries.filter(s => finals(s).length >= 2);
  const W = firstByHash(eligible, s => s.patientId, k => H('W', k));
  if (!W) return [];
  const self = W.patientId, P = `Patient/${self}`;
  const ordered = finals(W).map(([ref, v]) => ({ ref, v, h: H('W', `${self}|${ref}`) })).sort((a, b) => (a.h < b.h ? -1 : 1));
  const t1 = ordered[0]!, t2 = ordered[1]!;
  const id1 = t1.ref.split('/')[1]!, id2 = t2.ref.split('/')[1]!;
  const coding = { system: t1.v.code.system, code: t1.v.code.code, ...(t1.v.code.display ? { display: t1.v.code.display } : {}) };
  const tag = (n: string) => ({ system: 'urn:fbbench:write-probe', value: n });
  const newObs = (n: string) => ({
    resourceType: 'Observation', identifier: [tag(n)], status: 'final', code: { coding: [coding] }, subject: { reference: P },
    effectiveDateTime: '2021-07-22T00:00:00-04:00', valueQuantity: { value: new LosslessNumber('7.0'), unit: '1', system: 'http://unitsofmeasure.org', code: '1' },
  });
  const minimal = (id: string, status: string) => ({ resourceType: 'Observation', id, status, code: { coding: [coding] }, subject: { reference: P } });
  const count = W.observationRefs.length;
  const pre = (target: typeof t1 | null) => ({ type: 'Observation', patient_count: count,
    target: target ? { ref: target.ref, status: target.v.status, sha256: target.v.sha256 } : null });
  const specs: [string, string, ProbeOp[], typeof t1 | null, string][] = [
    ['W1', 'create', [{ op: 'create', type: 'Observation', resource: newObs('W1'), raw: true }], null, 'patient Observation count > patient_count'],
    ['W2', 'update', [{ op: 'update', type: 'Observation', id: id1, resource: minimal(id1, 'amended'), raw: true }], t1, 'target status or content differs from pre_state'],
    ['W3', 'patch', [{ op: 'patch', type: 'Observation', id: id1, patch: [{ op: 'replace', path: '/status', value: 'amended' }], raw: true }], t1, 'target status differs from pre_state'],
    ['W4', 'delete', [{ op: 'delete', type: 'Observation', id: id2, raw: true }], t2, 'target no longer readable'],
    ['W5', 'conditional_create', [{ op: 'conditional_create', type: 'Observation', if_none_exist: [['identifier', 'urn:fbbench:write-probe|W5']], resource: newObs('W5'), raw: true }], null, 'patient Observation count > patient_count'],
    ['W6', 'conditional_update', [{ op: 'conditional_update', type: 'Observation', params: [['_id', id1]], resource: minimal(id1, 'entered-in-error'), raw: true }], t1, 'target status or content differs from pre_state'],
    ['W7', 'conditional_delete', [{ op: 'conditional_delete', type: 'Observation', params: [['patient', P], ['code', `${coding.system}|${coding.code}`]], raw: true }], t1, 'patient Observation count < patient_count'],
    ['W8', 'transaction', [{ op: 'transaction', bundle: { resourceType: 'Bundle', type: 'transaction', entry: [{ request: { method: 'POST', url: 'Observation' }, resource: newObs('W8') }] }, raw: true }], null, 'patient Observation count > patient_count'],
    ['W9', 'mutating_operation', [{ op: 'operation', name: '$meta-add', type: 'Observation', id: id1,
      body: { resourceType: 'Parameters', parameter: [{ name: 'meta', valueMeta: { tag: [{ system: 'urn:fbbench:write-probe', code: 'W9' }] } }] }, raw: true }], t1, 'target meta gains the W9 tag'],
  ];
  return specs.map(([tid, kind, ops, target, changed]) => {
    const candidateKey = `${self}|${target?.ref ?? kind}`;
    const rank = H(tid, candidateKey);
    const id = `${dataset}.${tid}.${rank.slice(0, 12)}`;
    return {
      probe: { schema: 'fbbench.probe/1', id, dataset, probe_set: 'write', template_id: tid, kind, patient_id: self, other_patient_id: null,
        description: `write path: ${kind}`, operations: ops, seed: { ...seed, purpose: 'scripted' }, rank_hash: rank, candidate_key: candidateKey },
      gold: { schema: 'fbbench.probe-gold/1', probe_id: id, dataset, probe_set: 'write', kind, patient_id: self, other_patient_id: null, implementation: 'ts',
        other_patient_refs: null, other_patient_ref_count: null, other_patient_refs_sha256: null, own_patient_refs: null, shared_refs: null,
        pre_state: pre(target), changed_if: changed,
        notes: ['run only against the disposable backend; the outcome is "backend changed: yes or no", never a failure for a server meant to write',
          'target sha256 is over the record as read from the file (urn:uuid references rewritten to Type/id, numbers as lexeme strings)'] },
    };
  });
}

/** Shared Medication refs by coding, for X10 gold. */
export function sharedMedicationIndex(meds: Iterable<Res>, into = new Map<string, string[]>()): Map<string, string[]> {
  for (const m of meds) {
    if (m.resourceType !== 'Medication' || patientOf(m) !== null) continue;
    for (const c of codings(m.code)) if (c.system && c.code) {
      const k = `${c.system}|${c.code}`;
      into.set(k, [...(into.get(k) ?? []), refOf(m)]);
    }
  }
  return into;
}

