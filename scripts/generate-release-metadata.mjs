#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { sourceReleaseMetadata } from '../dist/packages/server/src/release.js';

const root = new URL('../', import.meta.url);
const target = new URL('dist/packages/server/src/generated/', root);
await mkdir(target, { recursive: true });
await writeFile(new URL('release.json', target), `${JSON.stringify(sourceReleaseMetadata(root), null, 2)}\n`);
