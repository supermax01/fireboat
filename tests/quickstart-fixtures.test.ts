import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseFhirJson } from '../packages/core/src/decimal.js';
import { SEED_LIMITS, resourceId, resourceType } from '../examples/quickstart/manifest.js';
import { mergeEdges, validateSeed } from '../scripts/quickstart/edges.js';
import { GENERATOR_PINS } from '../examples/quickstart/manifest.js';
import { QUICKSTART_SELECTION, type SeedManifest } from '../scripts/quickstart/transform-synthea.js';

type Rec = Record<string, unknown>;
const { generationProperties } = await import(new URL('../scripts/quickstart/generate-synthea.mjs', import.meta.url).href) as { generationProperties(pins: unknown): string };
const fixture = (name: string) => readFileSync(new URL(`../packages/evals/fixtures/quickstart/${name}`, import.meta.url));
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const merged = { ndjson: fixture('resources.ndjson').toString('utf8'), manifest: JSON.parse(fixture('seed-manifest.json').toString('utf8')) as SeedManifest & { edges: { sha256: string; count: number } } };
const natural = JSON.parse(fixture('natural-r4.json').toString('utf8')) as SeedManifest;
const lines = merged.ndjson.trimEnd().split('\n');

test('quickstart fixtures: the frozen generation properties are the pinned generator\'s', () => {
  assert.equal(fixture('generation.properties').toString('utf8'), generationProperties(GENERATOR_PINS));
});

test('quickstart fixtures: the natural seed is the merged seed\'s natural prefix and the edges rebuild the merged files byte for byte', () => {
  const naturalNdjson = lines.slice(0, natural.resources.length).map(line => `${line}\n`).join('');
  validateSeed({ ndjson: naturalNdjson, manifest: natural });
  assert.equal(natural.ndjson_sha256, 'fbdd9f8f5db89efc73a95c0822e8e323460db0b3a6257a02da36ca430d039b27');
  assert.deepEqual(natural.selection, QUICKSTART_SELECTION);
  const rebuilt = mergeEdges({ ndjson: naturalNdjson, manifest: natural }, fixture('edges.json'));
  assert.equal(rebuilt.ndjson, merged.ndjson);
  assert.equal(`${JSON.stringify(rebuilt.manifest, null, 2)}\n`, fixture('seed-manifest.json').toString('utf8'));
  assert.equal(merged.manifest.ndjson_sha256, '5209c70f591f0b78654d1f0c42c4c9c6e691d795cec3bade843f061f37126b7b');
  assert.deepEqual(merged.manifest.edges, { sha256: hash(fixture('edges.json')), count: 5 });
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
