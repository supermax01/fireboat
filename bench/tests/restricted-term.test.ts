// fireboat's own suite fails if any non-ignored file matches its restricted-terminology pattern. Mirror it for bench/.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';
import { CODE_BENCH, REPO } from '../lib/paths.js';

// Read the pattern from fireboat's source instead of restating it here (restating it would itself be a hit).
function restrictedPattern(): RegExp {
  const source = readFileSync(join(REPO, 'scripts/quickstart/edges.ts'), 'utf8');
  const m = /const RESTRICTED_TEXT = \/(.+)\/([a-z]*);/.exec(source);
  assert.ok(m, 'RESTRICTED_TEXT not found in scripts/quickstart/edges.ts');
  return new RegExp(m[1]!, m[2]);
}

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    if (e.name === 'node_modules' || e.name === '.local' || e.isSymbolicLink()) return [];
    const p = join(dir, e.name);
    return e.isDirectory() ? files(p) : e.isFile() ? [p] : [];
  });
}

test('no file in bench/ matches fireboat\'s restricted-terminology pattern', () => {
  const pattern = restrictedPattern();
  const hits = files(CODE_BENCH).filter(p => pattern.test(readFileSync(p, 'latin1'))).map(p => relative(REPO, p));
  assert.deepEqual(hits, []);
});
