import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { assembleHelperManifest, generateHelperManifest, manifestText } from '../scripts/quickstart/assemble-helper-manifest.js';
import type { ManifestInputs } from '../scripts/quickstart/assemble-helper-manifest.js';
import { HELPER_BACKEND } from '../examples/quickstart/backend.js';
import { sha256 } from '../examples/quickstart/manifest.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = ['compose.quickstart.yaml', 'scripts/quickstart/generate-synthea.mjs', 'packages/evals/fixtures/quickstart/generation.properties',
  'scripts/quickstart/transform-synthea.ts', 'packages/evals/fixtures/quickstart/natural-r4.json',
  'packages/evals/fixtures/quickstart/seed-manifest.json', 'packages/evals/fixtures/quickstart/resources.ndjson'];
test('quickstart helper manifest: generator check equals checked-in bytes exact rows artifact hashes and backend chain', async () => {
  const manifest = await generateHelperManifest(root, true);
  const [compose, generator, config, transform, natural, fixture] = await Promise.all(files.map(p => readFile(join(root, p))));
  assert.deepEqual(manifest.resources, JSON.parse(fixture!.toString()).resources);
  assert.equal(manifest.composeSha256, sha256(compose!)); assert.deepEqual(manifest.backend, HELPER_BACKEND);
  assert.deepEqual(manifest.artifacts, { generatorSha256: sha256(generator!), configSha256: sha256(config!),
    transformSha256: sha256(transform!), rawExportsSha256: sha256(JSON.stringify(JSON.parse(natural!.toString()).inputs)) });
  assert.equal(manifestText(manifest), await readFile(join(root, 'examples/quickstart/seed-manifest.json'), 'utf8'));
  assert.equal(manifest.resources.length, 282);
});
test('quickstart helper manifest: check refuses compose generator config raw input transform and output drift', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'fireboat-manifest-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const path of [...files, 'examples/quickstart/seed-manifest.json']) await cp(join(root, path), join(directory, path), { recursive: true });
  for (const path of [...files.slice(0, 4), 'examples/quickstart/seed-manifest.json']) {
    const original = await readFile(join(directory, path));
    await writeFile(join(directory, path), Buffer.concat([original, Buffer.from(' ')]));
    await assert.rejects(generateHelperManifest(directory, true), { code: 'HELPER_MANIFEST_DRIFT' });
    await writeFile(join(directory, path), original);
  }
  const path = join(directory, 'packages/evals/fixtures/quickstart/natural-r4.json'), natural = JSON.parse(await readFile(path, 'utf8'));
  natural.inputs[0].sha256 = 'a'.repeat(64); await writeFile(path, JSON.stringify(natural));
  await assert.rejects(generateHelperManifest(directory, true), { code: 'HELPER_MANIFEST_DRIFT' });
});
test('quickstart helper manifest: modified seed bytes or a copied row hash cannot redefine approved bodies', async () => {
  const bytes = await Promise.all(files.map(p => readFile(join(root, p))));
  const inputs: ManifestInputs = { compose: bytes[0]!, generator: bytes[1]!, config: bytes[2]!, transform: bytes[3]!,
    natural: bytes[4]!, fixture: bytes[5]!, resources: bytes[6]! };
  const fixture = JSON.parse(Buffer.from(inputs.fixture).toString()); fixture.resources[0].sha256 = 'e'.repeat(64);
  assert.throws(() => assembleHelperManifest({ ...inputs, fixture: Buffer.from(JSON.stringify(fixture)) }), { code: 'SEED_NOT_LISTED' });
  assert.throws(() => assembleHelperManifest({ ...inputs, resources: Buffer.from(inputs.resources).subarray(1) }), { code: 'SEED_NOT_LISTED' });
});
