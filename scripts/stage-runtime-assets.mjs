#!/usr/bin/env node
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUNTIME_ASSETS } from '../dist/packages/server/src/release.js';

// Preserve source bytes: tsc reformats imported JSON and omits the two dormant registry files.
const root = new URL('../', import.meta.url);
for (const relative of Object.values(RUNTIME_ASSETS)) {
  const target = new URL(`dist/${relative}`, root);
  await mkdir(dirname(fileURLToPath(target)), { recursive: true });
  await copyFile(new URL(relative, root), target);
}
