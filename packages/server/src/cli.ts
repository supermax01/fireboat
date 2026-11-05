#!/usr/bin/env node
// Small bootstrap: no SDK, core, configuration, or runtime JSON imports.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readReleaseMetadata, versionLine } from './release.js';
import { checkRuntime, checkRuntimeAssets, HELP, startupMessage } from './startup.js';

export async function bootstrap(argv: string[]): Promise<number> {
  try {
    if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write(HELP); return 0; }
    const release = readReleaseMetadata();
    if (argv.includes('--version')) { process.stdout.write(`${versionLine(release)}\n`); return 0; }
    checkRuntime(release);
    checkRuntimeAssets(release);
    const { main } = await import('./main.js');
    return await main(argv, release);
  } catch (error) { process.stderr.write(startupMessage(error)); return 2; }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try { return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}
if (isMainModule()) {
  void bootstrap(process.argv.slice(2)).then(code => { if (code !== 0) process.exit(code); });
}
