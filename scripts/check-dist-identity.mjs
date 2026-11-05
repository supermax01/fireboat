#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

export function sameReleaseIdentity(expected, actual) { return isDeepStrictEqual(expected, actual); }
export function assertReleaseIdentity(expected, actual) {
  if (!sameReleaseIdentity(expected, actual)) throw new Error('RELEASE_IDENTITY_MISMATCH');
}

/** Exact source/lock/emitted identity, every runtime asset, and the complete CLI version line. */
export async function checkDistIdentity(root) {
  const { readReleaseMetadata, sourceReleaseMetadata, validReleaseMetadata, versionLine, RUNTIME_ASSETS, sha256 } =
    await import(pathToFileURL(join(root, 'dist/packages/server/src/release.js')).href);
  const expected = sourceReleaseMetadata(pathToFileURL(`${root}/`));
  const release = readReleaseMetadata();
  if (!validReleaseMetadata(release)) throw new Error('RELEASE_IDENTITY_MISMATCH');
  assertReleaseIdentity(expected, release);
  const json = path => JSON.parse(readFileSync(join(root, path), 'utf8'));
  const pkg = json('package.json'), emitted = json('dist/package.json'), lock = json('package-lock.json');
  const packageIdentity = value => ({ name: value.name, version: value.version, bin: value.bin, dependencies: value.dependencies });
  assertReleaseIdentity(packageIdentity(pkg), packageIdentity(emitted));
  assertReleaseIdentity({ name: pkg.name, version: pkg.version }, { name: lock.name, version: lock.version });
  assertReleaseIdentity(packageIdentity(pkg), packageIdentity(lock.packages['']));
  for (const [label, path] of Object.entries(RUNTIME_ASSETS)) {
    assertReleaseIdentity(release.assets[label], { path, sha256: sha256(readFileSync(join(root, 'dist', path))) });
  }
  const { SERVER_IDENTITY, M3B_SCHEMA_VERSION, CATALOG_V2_VERSION } = await import(pathToFileURL(join(root, 'dist/packages/core/src/index.js')).href);
  assertReleaseIdentity({ name: release.name, version: release.version, schema: release.schema, catalog: release.catalog },
    { ...SERVER_IDENTITY, schema: M3B_SCHEMA_VERSION, catalog: CATALOG_V2_VERSION });
  const output = execFileSync(process.execPath, [join(root, release.bin), '--version'], { cwd: root, encoding: 'utf8' });
  assertReleaseIdentity(`${versionLine(release)}\n`, output);
  return output.trimEnd();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(`check-dist-identity: ${await checkDistIdentity(fileURLToPath(new URL('../', import.meta.url)))}`); }
  catch { console.error('check-dist-identity: RELEASE_IDENTITY_MISMATCH'); process.exitCode = 1; }
}
