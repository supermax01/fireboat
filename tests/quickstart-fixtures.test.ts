import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseFhirJson } from '../packages/core/src/decimal.js';
import { SEED_LIMITS, resourceId, resourceType } from '../examples/quickstart/manifest.js';
import { mergeEdges, restrictedTerminology, validateSeed } from '../scripts/quickstart/edges.js';
import { GENERATOR_PINS } from '../examples/quickstart/manifest.js';
import { QUICKSTART_SELECTION, type SeedManifest } from '../scripts/quickstart/transform-synthea.js';
import { replaceEncounterTerminology, SYNTHETIC_ENCOUNTER_CODINGS, TERMINOLOGY_SCHEMA, TERMINOLOGY_SCRIPT, TERMINOLOGY_SCRIPT_SHA256, type TerminologyManifest } from '../scripts/quickstart/terminology.js';

type Rec = Record<string, unknown>;
const { generationProperties } = await import(new URL('../scripts/quickstart/generate-synthea.mjs', import.meta.url).href) as { generationProperties(pins: unknown): string };
const fixture = (name: string) => readFileSync(new URL(`../packages/evals/fixtures/quickstart/${name}`, import.meta.url));
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const merged = { ndjson: fixture('resources.ndjson').toString('utf8'), manifest: JSON.parse(fixture('seed-manifest.json').toString('utf8')) as SeedManifest & { edges: { sha256: string; count: number } } };
const natural = JSON.parse(fixture('natural-r4.json').toString('utf8')) as SeedManifest;
const scrubbed = JSON.parse(fixture('natural-terminology.json').toString('utf8')) as TerminologyManifest;
const lines = merged.ndjson.trimEnd().split('\n');

test('quickstart fixtures: the frozen generation properties are the pinned generator\'s', () => {
  assert.equal(fixture('generation.properties').toString('utf8'), generationProperties(GENERATOR_PINS));
});

test('pin-only: quickstart approved terminology script and seed digests', () => {
  assert.equal(natural.ndjson_sha256, 'fbdd9f8f5db89efc73a95c0822e8e323460db0b3a6257a02da36ca430d039b27', 'the transform record is unchanged');
  assert.equal(scrubbed.ndjson_sha256, '56b3e91e7cf1d37f2d147c5606deaa78b5d27dfc60ffe47325ce7edf414e7107');
  // The record binds the bytes of the step that wrote it: an edit to terminology.ts must be followed by regenerating the seed through the CLIs.
  const scriptSha256 = hash(readFileSync(new URL(`../${TERMINOLOGY_SCRIPT}`, import.meta.url)));
  assert.equal(scriptSha256, TERMINOLOGY_SCRIPT_SHA256);
  assert.deepEqual(scrubbed.terminology, { schema: TERMINOLOGY_SCHEMA, script: TERMINOLOGY_SCRIPT, script_sha256: scriptSha256, input_ndjson_sha256: natural.ndjson_sha256, replaced_codings: 7, replaced_texts: 5 });
  assert.equal(merged.manifest.ndjson_sha256, '86883afccbe8db29c0df714e8f314c8007b5b0d4d99bab452e8016c7dd942939');
});

test('quickstart fixtures: the terminology step\'s output is the merged seed\'s natural prefix and the edges rebuild the merged files byte for byte', () => {
  const naturalNdjson = lines.slice(0, scrubbed.resources.length).map(line => `${line}\n`).join('');
  validateSeed({ ndjson: naturalNdjson, manifest: scrubbed });
  assert.deepEqual(natural.selection, QUICKSTART_SELECTION);
  const rebuilt = mergeEdges({ ndjson: naturalNdjson, manifest: scrubbed }, fixture('edges.json'));
  assert.equal(rebuilt.ndjson, merged.ndjson);
  assert.equal(`${JSON.stringify(rebuilt.manifest, null, 2)}\n`, fixture('seed-manifest.json').toString('utf8'));
  assert.deepEqual(merged.manifest.edges, { sha256: hash(fixture('edges.json')), count: 5 });
  assert.deepEqual((merged.manifest as unknown as TerminologyManifest).terminology, scrubbed.terminology, 'the merged manifest carries the step record');
});

test('quickstart fixtures: the terminology step changed only Encounter codings of the transform\'s rows, and the checked-in seed is its fixed point', () => {
  const { terminology, resources: rows, ndjson_sha256: _scrubbedHash, ...rest } = scrubbed;
  const { resources: naturalRows, ndjson_sha256: _naturalHash, ...naturalRest } = natural;
  assert.deepEqual(rest, naturalRest, 'inputs, selection, patient, counts and tallies are the transform\'s');
  assert.equal(terminology.input_ndjson_sha256, natural.ndjson_sha256);
  assert.equal(rows.length, naturalRows.length);
  const bodies = lines.slice(0, rows.length).map(line => parseFhirJson(line) as Rec);
  const changed: string[] = [];
  rows.forEach((row, i) => {
    const before = naturalRows[i]!;
    assert.deepEqual([row.type, row.id, row.origin], [before.type, before.id, before.origin], 'same rows in the same order');
    if (row.sha256 !== before.sha256 || row.bytes !== before.bytes) changed.push(`${row.type}/${row.id}`);
  });
  const encounters = bodies.filter(r => r.resourceType === 'Encounter');
  assert.deepEqual(changed, encounters.map(r => `Encounter/${r.id as string}`), 'only the five Encounter rows changed');
  assert.equal(encounters.length, 5);
  const systems = Object.values(SYNTHETIC_ENCOUNTER_CODINGS).map(c => c.system);
  for (const encounter of encounters) for (const field of ['type', 'reasonCode'] as const) {
    for (const concept of (encounter[field] ?? []) as Rec[]) {
      const codings = concept.coding as Rec[];
      assert.ok(Array.isArray(codings) && codings.length > 0, 'no concept is left empty');
      for (const coding of codings) assert.equal(coding.system, SYNTHETIC_ENCOUNTER_CODINGS[field].system);
      if ('text' in concept) assert.equal(concept.text, codings[0]!.display);
    }
  }
  assert.deepEqual(encounters.flatMap(r => ((r.type ?? []) as Rec[]).flatMap(c => (c.coding as Rec[]).map(x => x.code))),
    ['encounter-type-1', 'encounter-type-2', 'encounter-type-3', 'encounter-type-1', 'encounter-type-1'], 'a repeated source code keeps one synthetic code');
  assert.deepEqual(encounters.flatMap(r => ((r.reasonCode ?? []) as Rec[]).flatMap(c => (c.coding as Rec[]).map(x => x.code))), ['encounter-reason-1', 'encounter-reason-2']);
  assert.ok(systems.every(system => system.startsWith('http://example.invalid/')));
  const references = merged.ndjson.match(/"reference":"Encounter\/[^"]+"/g) ?? [];
  assert.equal(references.length, 267, 'every reference to the Encounters is kept');
  assert.ok(references.every(r => encounters.some(e => r === `"reference":"Encounter/${e.id as string}"`)));
  const fixed = replaceEncounterTerminology(bodies);
  assert.deepEqual([fixed.replacedCodings, fixed.replacedTexts], [0, 0]);
  assert.ok(fixed.resources.every((r, i) => r === bodies[i]), 'the step is a fixed point on its own output');
});

const ROOT = fileURLToPath(new URL('../', import.meta.url));
/**
 * The files git would track in this checkout: tracked, or new and not ignored. Outside a git checkout (the mutation
 * gate's tree copies have no .git) the same set is found by walking the tree with the .gitignore rules mirrored,
 * leaving out the temporary directory (the gate points TMPDIR at a `.mutation-tmp-*` folder inside its copy, where
 * other tests write while this one walks). Symbolic links are skipped (the shared skills link points inside the tree).
 */
function projectFiles(): string[] {
  let topLevel: string | undefined;
  try { topLevel = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { /* not a git checkout */ }
  const regular = (path: string) => { try { return lstatSync(join(ROOT, path)).isFile(); } catch { return false; } };
  if (topLevel && realpathSync(topLevel) === realpathSync(ROOT)) {
    const listed = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return [...new Set(listed.split('\0'))].filter(path => path && regular(path)).sort();
  }
  const ignoredTop = new Set(['dist', 'coverage', '.local', 'artifacts', 'mutation-results', '.claude', '.codex', '.muse', '.t3', '.cursor', '.idea', '.vscode']);
  const ignoredFile = (name: string) => (name.startsWith('.env') && name !== '.env.example') || name.endsWith('.log') || name.endsWith('.tsbuildinfo')
    || name === '.DS_Store' || name.endsWith('.local.md');
  const temp = realpathSync(tmpdir());
  const walk = (dir: string): string[] => readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap(entry => {
    const path = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink() || entry.name === 'node_modules' || entry.name === '.git' || (!dir && (ignoredTop.has(entry.name) || entry.name.startsWith('.mutation-tmp-')))) return [];
    if (entry.isDirectory()) return realpathSync(join(ROOT, path)) === temp ? [] : walk(path);
    return entry.isFile() && !ignoredFile(entry.name) ? [path] : [];
  });
  return walk('').sort();
}
/** Only detectors, historical notices and HL7 specification metadata may mention the removed terminology. */
const NAMES_SNOMED_CT = new Set([
  'scripts/quickstart/edges.ts', 'scripts/quickstart/terminology.ts', 'scripts/mutation-guards.mjs',
  'tests/quickstart-edges.test.ts', 'tests/quickstart-terminology.test.ts', 'tests/quickstart-fixtures.test.ts',
  'licenses/SEED_NOTICES.md', 'THIRD_PARTY_NOTICES.md',
  'packages/core/src/generated/r4-index.json',
]);

test('quickstart fixtures: no project file outside the allowlist (the detector, its tests, the notices, the docs) carries SNOMED CT content', () => {
  const files = projectFiles();
  for (const expected of ['packages/evals/src/fixture.ts', 'packages/evals/src/tasks.ts', 'packages/evals/fixtures/quickstart/resources.ndjson',
    'packages/evals/fixtures/m3b-projection/lab-fidelity.json', 'tests/delivery-profiles.test.ts', 'examples/quickstart/seed-manifest.json'])
    assert.ok(files.includes(expected), `${expected} is scanned`);
  const hits = files.filter(path => restrictedTerminology(readFileSync(join(ROOT, path), 'latin1')));
  assert.deepEqual(hits.filter(path => !NAMES_SNOMED_CT.has(path)), [], 'only the allowlisted files may name SNOMED CT');
  assert.deepEqual([...NAMES_SNOMED_CT].filter(path => !hits.includes(path)).sort(), [], 'every allowlisted file still needs its entry');
});

test('quickstart fixtures: every seed row fits the helper\'s manifest rules and the seed holds one natural patient and HbA1c', () => {
  const rows = merged.manifest.resources;
  assert.equal(rows.length, 282);
  assert.ok(rows.length <= SEED_LIMITS.resources && new Set(rows.map(r => r.type)).size <= SEED_LIMITS.types);
  assert.ok(rows.reduce((n, r) => n + r.bytes, 0) <= SEED_LIMITS.totalBytes);
  for (const r of rows) assert.ok(resourceType(r.type) && resourceId(r.id) && r.bytes >= 1 && r.bytes <= SEED_LIMITS.bodyBytes && /^[a-f0-9]{64}$/.test(r.sha256), `${r.type}/${r.id}`);
  assert.equal(new Set(rows.map(r => `${r.type}/${r.id}`)).size, rows.length);
  const resources = lines.map(line => parseFhirJson(line) as Rec);
  const patients = resources.filter(r => r.resourceType === 'Patient');
  assert.deepEqual(patients.map(r => r.id), [merged.manifest.patient.split('/')[1], 'qs-edge-other-patient']);
  const hba1c = resources.filter(r => r.resourceType === 'Observation' && JSON.stringify(r.code).includes('"4548-4"'));
  assert.deepEqual(hba1c.map(r => `${String(r.id).startsWith('qs-edge') ? r.id : 'natural'}:${r.status}`).sort(),
    ['natural:final', 'qs-edge-hba1c-corrected:corrected', 'qs-edge-hba1c-entered-in-error:entered-in-error', 'qs-edge-other-hba1c:final']);
  assert.deepEqual(natural.dropped_patient_identifiers, { SS: 1, DL: 1, PPN: 1 });
  assert.deepEqual(natural.providers, { sanitized: 4, npi_identifiers_dropped: 2 });
});

test('quickstart fixtures: the seed itself carries no government-identifier namespace, provider contact data or real facility names', () => {
  const resources = lines.map(line => parseFhirJson(line) as Rec);
  const text = merged.ndjson.toLowerCase();
  for (const namespace of ['us-ssn', 'us-npi', 'passport-usa', 'urn:oid:2.16.840.1.113883.4.3.'])
    assert.ok(!text.includes(namespace), namespace);
  for (const r of resources.filter(r => ['Organization', 'Location', 'Practitioner', 'PractitionerRole'].includes(r.resourceType as string))) {
    for (const key of ['telecom', 'address', 'position', 'alias', 'contact', 'photo', 'qualification']) assert.ok(!(key in r), `${r.resourceType as string}.${key}`);
    if (r.resourceType === 'Organization' || r.resourceType === 'Location') assert.match(r.name as string, /^Synthetic (?:organization|location) \d+$/);
  }
  const displays: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) node.forEach(visit);
    else if (node && typeof node === 'object') {
      const r = node as Rec;
      if (typeof r.reference === 'string' && /^(?:Organization|Location)\//.test(r.reference) && 'display' in r) displays.push(r.reference);
      Object.values(r).forEach(visit);
    }
  };
  resources.forEach(visit);
  assert.deepEqual(displays, [], 'no reference repeats an organisation or location name');
  const patient = resources.find(r => r.resourceType === 'Patient' && r.id !== 'qs-edge-other-patient')!;
  assert.ok(!(Array.isArray(patient.identifier) && patient.identifier.some(i => /SS|DL|PPN/.test(JSON.stringify((i as Rec).type ?? '')))));
});
