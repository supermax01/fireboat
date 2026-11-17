// Fast drift check: the approved npm inventory must match the shipped documents and license files on disk.
// It needs no build. Files that come out of dist/ are covered by the stage itself (npm run stage:package).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { validateExpectedInventory, type ExpectedInventory } from '../scripts/package-inventory.js';
import { describeInventoryDrift, documentSource, DOCUMENTS, HELPER_ASSETS, LICENSES_SOURCE, ROOT, sha256 } from '../scripts/stage-package.js';

/** Where a staged path is copied from, or undefined for build outputs and the generated manifest. */
const sourceOf = (path: string): string | undefined =>
  DOCUMENTS.includes(path) ? documentSource(path) : path.startsWith('licenses/') ? `${LICENSES_SOURCE}/${path.slice(9)}`
    : path === 'npm-shrinkwrap.json' ? 'packaging/npm-shrinkwrap.json'
      : path === 'quickstart/package.json' || path === 'quickstart/package-lock.json' ? `examples/quickstart/${path.slice(11)}`
        : path === 'quickstart/fireboat-timing.mjs' ? undefined
          : HELPER_ASSETS.some(p => `quickstart/${p}` === path) ? path.slice(11) : undefined;

test('pin-only: package shipped documents and license inventory', async () => {
  const approved = validateExpectedInventory(JSON.parse(await readFile(join(ROOT, 'packaging/npm-files.json'), 'utf8')));
  const files: ExpectedInventory['files'][number][] = [];
  for (const file of approved.files) {
    const source = sourceOf(file.path);
    if (!source) { files.push(file); continue; }
    const body = await readFile(join(ROOT, source));
    files.push({ ...file, size: body.byteLength, sha256: sha256(body) });
  }
  const actual: ExpectedInventory = { ...approved, files };
  const drift = describeInventoryDrift('npm-files.json', approved, actual);
  assert.deepEqual(drift, [], `A shipped file changed after the inventory was approved:\n${drift.join('\n')}\n` +
    'If each change is intended and reviewed, run: npm run stage:package -- --approve-inventory <absolute-new-stage>');
});

test('package inventory: every shipped document and license file is in the approved inventory', async () => {
  const approved = validateExpectedInventory(JSON.parse(await readFile(join(ROOT, 'packaging/npm-files.json'), 'utf8')));
  const paths = new Set(approved.files.map(f => f.path));
  for (const path of DOCUMENTS) assert.ok(paths.has(path), `${path} is listed to ship but missing from packaging/npm-files.json`);
});

test('package inventory: drift report names added, removed and changed paths without contents', () => {
  const file = (path: string, hash: string) => ({ path, size: 1, mode: 0o644, sha256: hash });
  const base = { schema: 1, identity: { name: 'x', version: '1', bin: {} } } as unknown as ExpectedInventory;
  const approved = { ...base, files: [file('a', '1'), file('b', '2')] }, actual = { ...base, files: [file('b', '3'), file('c', '4')] };
  assert.deepEqual(describeInventoryDrift('inv', approved, actual), ['inv: changed b', 'inv: added c', 'inv: removed a']);
  assert.deepEqual(describeInventoryDrift('inv', approved, approved), []);
});
