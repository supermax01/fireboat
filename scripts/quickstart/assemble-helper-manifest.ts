#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HELPER_BACKEND } from '../../examples/quickstart/backend.js';
import { fault, isRecord, pinsSha256, QUICKSTART_TARGET, QuickstartFault, sha256, validateSeedManifest } from '../../examples/quickstart/manifest.js';
import type { SeedManifest } from '../../examples/quickstart/manifest.js';
import { approvedSeedPuts } from '../../examples/quickstart/setup-oracle.js';

export type ManifestInputs = Readonly<{
  compose: Uint8Array; generator: Uint8Array; config: Uint8Array; transform: Uint8Array;
  natural: Uint8Array; fixture: Uint8Array; resources: Uint8Array;
}>;
export function assembleHelperManifest(input: ManifestInputs): SeedManifest {
  let natural: unknown, fixture: unknown;
  try { natural = JSON.parse(Buffer.from(input.natural).toString('utf8')); fixture = JSON.parse(Buffer.from(input.fixture).toString('utf8')); }
  catch { throw fault('MANIFEST_INVALID'); }
  if (!isRecord(natural) || !Array.isArray(natural.inputs) || !isRecord(fixture) || !Array.isArray(fixture.resources)) throw fault('MANIFEST_INVALID');
  const manifest = validateSeedManifest({ schema: 1, target: QUICKSTART_TARGET, pinsSha256: pinsSha256(), composeSha256: sha256(input.compose),
    artifacts: { generatorSha256: sha256(input.generator), configSha256: sha256(input.config),
      rawExportsSha256: sha256(JSON.stringify(natural.inputs)), transformSha256: sha256(input.transform) },
    backend: HELPER_BACKEND, resources: fixture.resources });
  approvedSeedPuts(manifest, input.resources);
  return manifest;
}
export const manifestText = (manifest: SeedManifest): string => `${JSON.stringify(manifest, null, 2)}\n`;
export async function generateHelperManifest(root: string, check: boolean): Promise<SeedManifest> {
  const paths = ['compose.quickstart.yaml', 'scripts/quickstart/generate-synthea.mjs', 'packages/evals/fixtures/quickstart/generation.properties',
    'scripts/quickstart/transform-synthea.ts', 'packages/evals/fixtures/quickstart/natural-r4.json',
    'packages/evals/fixtures/quickstart/seed-manifest.json', 'packages/evals/fixtures/quickstart/resources.ndjson'];
  const [compose, generator, config, transform, natural, fixture, resources] = await Promise.all(paths.map(p => readFile(resolve(root, p))));
  const manifest = assembleHelperManifest({ compose: compose!, generator: generator!, config: config!, transform: transform!,
    natural: natural!, fixture: fixture!, resources: resources! });
  const expected = manifestText(manifest), destination = resolve(root, 'examples/quickstart/seed-manifest.json');
  if (check) {
    let actual: string | undefined;
    try { actual = await readFile(destination, 'utf8'); } catch { /* missing is drift */ }
    if (actual !== expected) throw fault('HELPER_MANIFEST_DRIFT');
  } else await writeFile(destination, expected);
  return manifest;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.slice(2).some(a => a !== '--check') || process.argv.slice(2).length > 1) throw fault('CLI_USAGE');
    const manifest = await generateHelperManifest(fileURLToPath(new URL('../../', import.meta.url)), process.argv.includes('--check'));
    process.stdout.write(`HELPER_MANIFEST_OK resources=${manifest.resources.length} sha256=${sha256(manifestText(manifest))}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof QuickstartFault ? error.code : 'HELPER_FAILED'}\n`);
    process.exitCode = 1;
  }
}
