import assert from 'node:assert/strict';
import test from 'node:test';
import { GENERATOR_PINS, pinsSha256, QUICKSTART_TARGET, sha256, validateGeneratorPins, validateSeedManifest } from '../examples/quickstart/manifest.js';

test('quickstart pins: adopted D2 identities and frozen generation inputs', () => {
  const pins = validateGeneratorPins(GENERATOR_PINS);
  assert.equal(pinsSha256(), 'cf62b40b41ae24b80f3dc3e11980f5c10725c3729cca71e49d0612648121867d');
  assert.deepEqual(pins.synthea, { tag: 'v4.0.0', commit: '0185c09ea9d10a822c6f5f3ef9bdcbcbe960c813',
    asset: 'synthea-with-dependencies.jar', bytes: 201164144,
    sha256: 'ed43c20ad40ba5c3bc724503a5af032715fe3c491620b766148e7c2361e6ecc1' });
  assert.equal(pins.java.major, 17);
  assert.equal(pins.jdk.tag, 'eclipse-temurin:17.0.20.1_1-jdk-jammy');
  assert.equal(pins.jdk.indexDigest, 'sha256:73ed442231ec66cfe48cae0b263ce619a75ab96d162ab325f38fc0a269ee3aab');
  assert.equal(pins.jdk.childDigest, 'sha256:f6838d4bc55df9a3b03783e04f1d26b3c163b96faf153e3a54468ec3fdcbd7f5');
  assert.equal(pins.hapi.indexDigest, 'sha256:0ff86aac4c7bd13a1ee226444a70263bb46ed1c28ef543c30a44f865b80ca04e');
  assert.equal(pins.generation.seed, 42); assert.equal(pins.generation.clinicianSeed, 42);
  assert.equal(pins.generation.population, 1); assert.deepEqual(pins.generation.ages, { min: 60, max: 85 });
  assert.equal(pins.generation.referenceDate, '20260101'); assert.equal(pins.generation.asOf, '2026-01-01T00:00:00Z');
  assert.equal(pins.generation.endDate, '20260101');
  assert.deepEqual(pins.generation.window, { start: '2020-01-01', endExclusive: '2026-01-01' });
  assert.equal(pins.generation.timezone, 'UTC'); assert.equal(pins.generation.locale, 'en_US.UTF-8');
  assert.equal(pins.generation.threads, 1); assert.equal(pins.generation.properties['exporter.years_of_history'], 0);
  assert.equal(pins.generation.properties['exporter.fhir.export'], true);
  assert.equal(pins.generation.properties['exporter.metadata.export'], false);
  assert.equal(pins.generation.properties['exporter.fhir.use_us_core_ig'], false);
  const seeds = [42, ...Object.values(pins.seedPools).flatMap(pools => pools.flatMap(p =>
    Array.from({ length: p.last - p.first + 1 }, (_, i) => p.first + i)))];
  assert.equal(new Set(seeds).size, seeds.length);
  assert(Object.isFrozen(pins.generation.properties));
});
test('quickstart pins: end date is required and must equal the asOf date', () => {
  const missing = structuredClone(GENERATOR_PINS);
  delete (missing.generation as Partial<typeof missing.generation>).endDate;
  assert.throws(() => validateGeneratorPins(missing), { code: 'PIN_MISSING', message: 'PIN_MISSING' });
  for (const patch of [{ endDate: '20260102' }, { endDate: '2026-01-01' }, { asOf: '2026-01-02T00:00:00Z' }, { asOf: null }]) {
    const value = { ...GENERATOR_PINS, generation: { ...GENERATOR_PINS.generation, ...patch } };
    assert.throws(() => validateGeneratorPins(value), { code: 'PIN_MISMATCH', message: 'PIN_MISMATCH' });
  }
});

test('quickstart pins: missing JAR hash JDK child and clock refuse', () => {
  for (const path of [['synthea', 'sha256'], ['jdk', 'childDigest'], ['generation', 'referenceDate']]) {
    const value = structuredClone(GENERATOR_PINS) as unknown as Record<string, Record<string, unknown>>;
    delete value[path[0]!]![path[1]!];
    assert.throws(() => validateGeneratorPins(value), { code: 'PIN_MISSING' });
  }
});
test('quickstart pins: moving tags and missing commit refuse', () => {
  for (const tag of ['master-branch-latest', 'latest', 'v4.0.0-rc.1']) {
    const value = structuredClone(GENERATOR_PINS); value.synthea.tag = tag;
    assert.throws(() => validateGeneratorPins(value), { code: 'PIN_UNSTABLE' });
  }
  const value = structuredClone(GENERATOR_PINS);
  delete (value.synthea as Partial<typeof value.synthea>).commit;
  assert.throws(() => validateGeneratorPins(value), { code: 'PIN_MISSING' });
});
test('quickstart pins: altered hashes images seeds settings and extra keys refuse', () => {
  const edits = [
    (p: typeof GENERATOR_PINS) => { p.synthea.sha256 = 'a'.repeat(64); },
    (p: typeof GENERATOR_PINS) => { p.java.major = 21; },
    (p: typeof GENERATOR_PINS) => { p.hapi.indexDigest = `sha256:${'b'.repeat(64)}`; },
    (p: typeof GENERATOR_PINS) => { p.generation.seed = 43; },
    (p: typeof GENERATOR_PINS) => { p.generation.properties['exporter.fhir.export'] = false; }
  ];
  for (const edit of edits) { const value = structuredClone(GENERATOR_PINS); edit(value); assert.throws(() => validateGeneratorPins(value), { code: 'PIN_MISMATCH' }); }
  assert.throws(() => validateGeneratorPins({ ...GENERATOR_PINS, download: true }), { code: 'PIN_INVALID' });
});

test('quickstart manifest: closed bounded fixed-id resources and artifact hashes', () => {
  const body = '{"resourceType":"Patient","id":"synthetic"}';
  const manifest = { schema: 1, target: QUICKSTART_TARGET, pinsSha256: pinsSha256(), composeSha256: sha256('synthetic compose'),
    artifacts: { generatorSha256: sha256('generator'), configSha256: sha256('config'), rawExportsSha256: sha256('raw'), transformSha256: sha256('transform') },
    backend: { imageIndexDigest: GENERATOR_PINS.hapi.indexDigest, imageManifestDigest: `sha256:${'1'.repeat(64)}`,
      imageConfigDigest: `sha256:${'2'.repeat(64)}`, softwareName: 'HAPI FHIR Server', softwareVersion: '8.12.0', fhirVersion: '4.0.1' },
    resources: [{ type: 'Patient', id: 'synthetic', bytes: Buffer.byteLength(body), sha256: sha256(body), origin: 'natural' }] };
  const valid = validateSeedManifest(manifest); assert(Object.isFrozen(valid.resources));
  const bad: unknown[] = [null, { ...manifest, extra: true }, { ...manifest, pinsSha256: 'unverified' },
    { ...manifest, target: { ...manifest.target, origin: 'http://127.0.0.1:18091' } },
    { ...manifest, resources: [] }, { ...manifest, resources: [...manifest.resources, ...manifest.resources] },
    { ...manifest, resources: [{ ...manifest.resources[0], id: '../escape' }] },
    { ...manifest, resources: [{ ...manifest.resources[0], bytes: 1_048_577 }] },
    { ...manifest, resources: [{ ...manifest.resources[0], sha256: 'bad' }] },
    { ...manifest, backend: { ...manifest.backend, imageIndexDigest: `sha256:${'3'.repeat(64)}` } },
    { ...manifest, artifacts: { ...manifest.artifacts, rawExportsSha256: null } }];
  for (const value of bad) assert.throws(() => validateSeedManifest(value), { code: 'MANIFEST_INVALID' });
});
