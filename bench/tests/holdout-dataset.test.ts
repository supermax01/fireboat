// The Synthea test holdout as a dataset: it shares every Synthea rule with synthea-dev (one table per family), while the
// lists that commands iterate over for "every dataset" stay the development datasets. Synthetic records only.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import test from 'node:test';
import { assertDevelopmentPatient, datasetOfQuestion } from '../agent/io.js';
import { DEV_SEED, seedFor, seedNote, toQuestion } from '../gold/generate.js';
import { confinementProbes, summarize, writeProbes } from '../gold/probes.js';
import { PatientData, SharedData, syntheaSource } from '../gold/reader.js';
import type { Ctx } from '../gold/rules.js';
import { makeCandidate } from '../gold/select.js';
import { DECIMAL_BASES, GROUPS, groupOf, STRATA, STRATA_GROUPS, TEMPLATES } from '../gold/templates.js';
import { datasetArg, devDatasetArg, loadDatasetArg } from '../lib/cli.js';
import { stringifyLossless } from '../lib/json.js';
import {
  ALL_DATASETS, byFamily, DATASETS, familyOf, HOLDOUT_DATASETS, isDevDataset, isSyntheaDataset, knownPatient, LOAD_DATASETS, LOCAL_CONFIG, results,
  type DatasetId,
} from '../lib/paths.js';
import type { Res } from '../gold/fhir.js';
import type { LaunchContext } from '../lib/types.js';
import { DATASET_LABELS, datasetLines, DEVIATIONS, seedText } from '../run/report.js';
import { scoredDatasets } from '../run/score.js';
import { ARMS, PATIENT_IDENTIFIER_SYSTEMS, SHARED_IDENTIFIER_SYSTEMS, SHARED_PROFILES, TUNED_SHARED_IDENTIFIER_SYSTEMS } from '../servers/arms.js';

const CS = 'http://example.org/fhir/cs'; // synthetic code system

test('dataset lists: DATASETS stays the development datasets; --dataset accepts the holdout, bench:convert does not', () => {
  assert.deepEqual(DATASETS, ['mimic', 'synthea-dev']);
  assert.deepEqual(HOLDOUT_DATASETS, ['synthea-holdout']);
  assert.deepEqual(ALL_DATASETS, ['mimic', 'synthea-dev', 'synthea-holdout']);
  assert.deepEqual(LOAD_DATASETS, ALL_DATASETS);
  assert.equal(datasetArg('synthea-holdout'), 'synthea-holdout');
  assert.equal(loadDatasetArg('synthea-holdout'), 'synthea-holdout');
  assert.equal(devDatasetArg('synthea-dev'), 'synthea-dev');
  assert.throws(() => devDatasetArg('synthea-holdout'), /--dataset must be one of mimic, synthea-dev/);
  assert.throws(() => datasetArg('synthea'), /--dataset must be one of/);
  assert.deepEqual(ALL_DATASETS.map(familyOf), ['mimic', 'synthea', 'synthea']);
  assert.deepEqual(ALL_DATASETS.map(isSyntheaDataset), [false, true, true]);
  assert.deepEqual(ALL_DATASETS.map(isDevDataset), [true, true, false]);
  const t = byFamily({ mimic: ['m'], synthea: ['s'] });
  assert.deepEqual(Object.keys(t), ALL_DATASETS);
  assert.equal(t['synthea-holdout'], t['synthea-dev']);
});

test('question rules: the holdout gets the Synthea tables themselves (groups, strata, decimal bases)', () => {
  assert.equal(GROUPS['synthea-holdout'], GROUPS['synthea-dev']);
  assert.notEqual(GROUPS['synthea-holdout'], GROUPS.mimic);
  assert.equal(DECIMAL_BASES['synthea-holdout'], DECIMAL_BASES['synthea-dev']);
  for (const s of STRATA) assert.equal(STRATA_GROUPS[s]['synthea-holdout'], STRATA_GROUPS[s]['synthea-dev'], s);
  for (const id of [...GROUPS['synthea-dev'].flatMap(g => g.templates), ...STRATA.flatMap(s => STRATA_GROUPS[s]['synthea-dev'].flatMap(g => g.templates))]) {
    assert.equal(groupOf('synthea-holdout', id), groupOf('synthea-dev', id), id);
  }
});

test('arm configurations: every per-dataset list is the Synthea one, so fireboat configs equal synthea-dev\'s', () => {
  for (const table of [PATIENT_IDENTIFIER_SYSTEMS, SHARED_IDENTIFIER_SYSTEMS, TUNED_SHARED_IDENTIFIER_SYSTEMS, SHARED_PROFILES]) {
    assert.equal(table['synthea-holdout'], table['synthea-dev']);
  }
  const config = (arm: 'FB0' | 'FB' | 'FBd' | 'FBt', dataset: DatasetId) => {
    const ctx: LaunchContext = { arm, dataset, patientId: 'p', slot: 6, cell: 'default', fhirBaseUrl: 'http://127.0.0.1:18216/fhir', runDir: '/nonexistent/run', runTmp: '/nonexistent/tmp' };
    return ARMS[arm].command!(ctx).files['fireboat.json'];
  };
  // FB0 builds a fixed early commit that a fresh copy of the repository does not contain; it is then unavailable and has
  // no command. FBd uses the same default ('none') lists, and FB, FBd and FBt must always be buildable here.
  for (const arm of ['FB', 'FBd', 'FBt'] as const) assert.equal(ARMS[arm].status, 'active', arm);
  for (const arm of (['FB0', 'FB', 'FBd', 'FBt'] as const).filter(a => ARMS[a].status === 'active')) {
    assert.ok(config(arm, 'synthea-dev'), arm);
    assert.equal(config(arm, 'synthea-holdout'), config(arm, 'synthea-dev'), arm);
  }
});

function patient(id: string, labs: number): Ctx {
  const data = new PatientData('synthea-holdout', id, `${id}.json`);
  data.add({ resourceType: 'Patient', id, birthDate: '1970-01-01', gender: 'female', identifier: [{ system: 'urn:example:mrn', value: `mrn-${id}` }] });
  for (let i = 0; i < labs; i++) {
    data.add({
      resourceType: 'Observation', id: `${id}-o${i}`, status: 'final', subject: { reference: `Patient/${id}` },
      category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'laboratory' }] }],
      code: { coding: [{ system: CS, code: `lab-${i}`, display: `Lab ${i}` }] }, effectiveDateTime: `2020-01-0${i + 1}T00:00:00Z`,
    });
  }
  data.add({ resourceType: 'Encounter', id: `${id}-e0`, status: 'finished', subject: { reference: `Patient/${id}` } });
  data.add({ resourceType: 'MedicationRequest', id: `${id}-m0`, status: 'active', subject: { reference: `Patient/${id}` },
    medicationCodeableConcept: { coding: [{ system: CS, code: 'drug-1', display: 'Drug 1' }] }, authoredOn: '2020-01-01T00:00:00Z' });
  return { data, shared: new SharedData() };
}

test('probes and proposals: the holdout builds what synthea-dev builds from the same records, under its own ids', () => {
  const ctxs = [patient('p1', 3), patient('p2', 3), patient('p3', 2)];
  const asDev = (v: unknown) => stringifyLossless(v).replaceAll('synthea-holdout', 'synthea-dev');
  const build = (d: DatasetId) => {
    const summaries = ctxs.map(c => summarize(c, d));
    return [...confinementProbes(d, summaries, DEV_SEED, new Map()), ...writeProbes(d, summaries, DEV_SEED)];
  };
  const held = build('synthea-holdout');
  assert.ok(held.some(b => b.probe.probe_set === 'write'), 'write probes are built for the holdout');
  assert.ok(held.every(b => b.probe.id.startsWith('synthea-holdout.') && b.probe.dataset === 'synthea-holdout' && b.gold.dataset === 'synthea-holdout'));
  assert.equal(asDev(held), stringifyLossless(build('synthea-dev')));
  assert.equal(writeProbes('mimic', ctxs.map(c => summarize(c, 'mimic')), DEV_SEED).length, 0);
  for (const id of GROUPS['synthea-dev'].flatMap(g => g.templates)) {
    const t = TEMPLATES.get(id)!;
    for (const c of ctxs) assert.equal(stringifyLossless(t.propose(c, 'synthea-holdout')), stringifyLossless(t.propose(c, 'synthea-dev')), id);
  }
  const o1 = TEMPLATES.get('O1')!.propose(ctxs[0]!, 'synthea-holdout')[0]!;
  const q = toQuestion('synthea-holdout', makeCandidate('saq', DEV_SEED.hex, 'O1', 'p1', o1), 'concept');
  assert.ok(q.id.startsWith('synthea-holdout.O1.'));
  assert.equal(q.group, 'Medications');
  assert.equal(datasetOfQuestion(q.id), 'synthea-holdout');
  assert.throws(() => assertDevelopmentPatient('synthea-holdout', 'p1'), /not used by the agent smoke test/);
});

test('bench:score visits the holdout only for campaigns that ran it', () => {
  const inputs = { questions: 'q', probes: null, gold: 'g', probe_gold: null, converted_manifest: null };
  assert.deepEqual(scoredDatasets({ datasets: { mimic: inputs } }), ['mimic', 'synthea-dev']);
  assert.deepEqual(scoredDatasets({ datasets: { 'synthea-holdout': inputs } }), ['mimic', 'synthea-dev', 'synthea-holdout']);
  assert.deepEqual(scoredDatasets({ datasets: {}, strata: { 'synthea-holdout': { dir: '/x', questions: null, gold: null } } }), ['mimic', 'synthea-dev', 'synthea-holdout']);
});

test('report: each dataset is labelled with the seed its questions were drawn with; no fixed development wording', () => {
  const drand = { kind: 'drand', hex: 'c4c93bc7fad19f355c6f53a6a67575fdeda9d6c88df7f8eb6ba31c9e0ca4ba51', round: '6644725' };
  assert.deepEqual(datasetLines([
    { dataset: 'mimic', seed: seedText(DEV_SEED) }, { dataset: 'synthea-dev', seed: seedText(DEV_SEED) }, { dataset: 'synthea-holdout', seed: seedText(drand) },
  ]), [
    '- mimic: MIMIC-IV demo; fireboat was developed against this data. Questions drawn with the development seed (64 zeros).',
    '- synthea-dev: development data. Questions drawn with the development seed (64 zeros).',
    `- synthea-holdout: ${DATASET_LABELS['synthea-holdout']}. Questions drawn with the drand round 6644725 randomness ${drand.hex}.`,
  ]);
  assert.equal(DATASET_LABELS['synthea-holdout'], 'fresh held-out Synthea sample (99 patients drawn by drand round 6644725, not used in development)');
  assert.equal(seedText(undefined), 'not recorded');
  assert.ok(!DEVIATIONS.some(d => /Development data only|development seed/.test(d)));
});

const convertManifest = join(results.manifests, 'convert-synthea-holdout.json');
test('holdout source (when converted): the 99 converted bundles in name order, the known patient first', { skip: !existsSync(convertManifest) || !existsSync(LOCAL_CONFIG) }, () => {
  const src = syntheaSource('synthea-holdout');
  const m = JSON.parse(readFileSync(convertManifest, 'utf8')) as { inputs: { files: { name: string; sha256: string }[] } }; // our own file
  assert.equal(src.files.length, m.inputs.files.length);
  const names = src.files.map(f => basename(f));
  assert.deepEqual(names, [...names].sort());
  for (const f of m.inputs.files) assert.equal(src.sums.get(f.name.normalize('NFC')), f.sha256, f.name);
  assert.ok(names[0]!.includes(knownPatient('synthea-holdout')), 'known_patient.synthea-holdout is the first bundle in name order');
  assert.ok(!syntheaSource('synthea-dev').files.some(f => names.includes(basename(f))), 'disjoint from the development bundles');
});

test('seeds: development datasets keep the development seed; the holdout uses the drand round that drew it', { skip: !existsSync(convertManifest) }, () => {
  assert.equal(seedFor('mimic'), DEV_SEED);
  assert.equal(seedFor('synthea-dev'), DEV_SEED);
  const s = seedFor('synthea-holdout');
  assert.deepEqual(s, {
    kind: 'drand', hex: 'c4c93bc7fad19f355c6f53a6a67575fdeda9d6c88df7f8eb6ba31c9e0ca4ba51', purpose: 'saq', round: '6644725',
    chain_hash: '8990e7a9aaed2ffed73dbd7092123d6f289930540d7651336225dc172e51b2ce',
  });
  assert.match(seedNote(s), /^drand round 6644725 /);
  assert.match(seedNote(DEV_SEED), /^development seed/);
  const qs = existsSync(results.questions('synthea-holdout')) ? readFileSync(results.questions('synthea-holdout'), 'utf8').split('\n').filter(Boolean) : [];
  for (const l of qs) assert.deepEqual((JSON.parse(l) as { seed: unknown }).seed, s); // our own file
});
