// Fast drift check: the approved npm inventory must match the shipped documents and license files on disk, as staged
// (markdown links rewritten for the package). It needs no build. Files that come out of dist/ are covered by the stage
// itself (npm run stage:package).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { validateExpectedInventory, type ExpectedInventory } from '../scripts/package-inventory.js';
import { assertStagedLinks, brokenMarkdownLinks, describeInventoryDrift, documentSource, DOCUMENTS, HELPER_ASSETS, LICENSES_SOURCE, PUBLIC_BLOB_BASE, PUBLIC_RAW_BASE, ROOT, sha256,
  stagedMarkdown, StageFault } from '../scripts/stage-package.js';

/** Where a staged path is copied from, or undefined for build outputs and the generated manifest. */
const sourceOf = (path: string): string | undefined =>
  DOCUMENTS.includes(path) ? documentSource(path) : path.startsWith('licenses/') ? `${LICENSES_SOURCE}/${path.slice(9)}`
    : path === 'npm-shrinkwrap.json' ? 'packaging/npm-shrinkwrap.json'
      : path === 'quickstart/package.json' || path === 'quickstart/package-lock.json' ? `examples/quickstart/${path.slice(11)}`
        : path === 'quickstart/fireboat-timing.mjs' ? undefined
          : HELPER_ASSETS.some(p => `quickstart/${p}` === path) ? path.slice(11) : undefined;

test('pin-only: package shipped documents and license inventory', async () => {
  const approved = validateExpectedInventory(JSON.parse(await readFile(join(ROOT, 'packaging/npm-files.json'), 'utf8')));
  const staged = new Set(approved.files.map(f => f.path));
  const files: ExpectedInventory['files'][number][] = [];
  for (const file of approved.files) {
    const source = sourceOf(file.path);
    if (!source) { files.push(file); continue; }
    const raw = await readFile(join(ROOT, source));
    const body = file.path.endsWith('.md') ? stagedMarkdown(file.path, source, raw, staged) : raw;
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

/** A package holding the documents, two licence files and one quickstart asset, as package paths. */
const PACKAGE = new Set([...DOCUMENTS, 'package.json', 'licenses/SEED_NOTICES.md', 'licenses/dependencies/zod/LICENSE', 'quickstart/examples/quickstart/config.json']);

test('package stage: staged markdown links point inside the package or to the public repository, keeping anchors', () => {
  const readme = [
    '<img src="docs/assets/brand/icon.svg" width="96" alt="x">',
    '<source media="(prefers-color-scheme: dark)" srcset="docs/assets/dark.svg">',
    '![diagram](docs/assets/light.svg "Diagram")',
    '[model](docs/SECURITY-MODEL.md#residuals) [limits](docs/LIMITS.md#bytes) [policy](.github/SECURITY.md) [notices](packaging/THIRD_PARTY_NOTICES.md)',
    '[seed](packaging/licenses/SEED_NOTICES.md) [licences](packaging/licenses/dependencies/) [contract](docs/contracts/m3b-tools.json) [runtime](.nvmrc)',
    '[web](https://example.org/a.md) [here](#questions) <a href="AGENTS.md#setup">agents</a>',
    '[ref]: docs/TESTING.md#results',
    '```', '[code](docs/NOT-REWRITTEN.md)', '```',
  ].join('\n');
  assert.equal(stagedMarkdown('README.md', 'README.md', Buffer.from(readme), PACKAGE).toString(), [
    `<img src="${PUBLIC_RAW_BASE}docs/assets/brand/icon.svg" width="96" alt="x">`,
    `<source media="(prefers-color-scheme: dark)" srcset="${PUBLIC_RAW_BASE}docs/assets/dark.svg">`,
    `![diagram](${PUBLIC_RAW_BASE}docs/assets/light.svg "Diagram")`,
    `[model](${PUBLIC_BLOB_BASE}docs/SECURITY-MODEL.md#residuals) [limits](docs/LIMITS.md#bytes) [policy](SECURITY.md) [notices](THIRD_PARTY_NOTICES.md)`,
    `[seed](licenses/SEED_NOTICES.md) [licences](licenses/dependencies/) [contract](docs/contracts/m3b-tools.json) [runtime](${PUBLIC_BLOB_BASE}.nvmrc)`,
    `[web](https://example.org/a.md) [here](#questions) <a href="${PUBLIC_BLOB_BASE}AGENTS.md#setup">agents</a>`,
    `[ref]: ${PUBLIC_BLOB_BASE}docs/TESTING.md#results`,
    '```', '[code](docs/NOT-REWRITTEN.md)', '```',
  ].join('\n'));
  // A document kept in a subfolder resolves its links from there, in the repository and in the package.
  const guide = '[config](../examples/quickstart/config.json) [code](../packages/core/src/index.ts#L1) [limits](LIMITS.md) [readme](../README.md)';
  assert.equal(stagedMarkdown('docs/QUICKSTART.md', 'docs/QUICKSTART.md', Buffer.from(guide), PACKAGE).toString(),
    `[config](../quickstart/examples/quickstart/config.json) [code](${PUBLIC_BLOB_BASE}packages/core/src/index.ts#L1) [limits](LIMITS.md) [readme](../README.md)`);
  // A document staged at another path: its links are resolved from where it lives in the repository.
  assert.equal(stagedMarkdown('THIRD_PARTY_NOTICES.md', 'packaging/THIRD_PARTY_NOTICES.md', Buffer.from('[seed](licenses/SEED_NOTICES.md) [lock](npm-shrinkwrap.json)'), PACKAGE).toString(),
    `[seed](licenses/SEED_NOTICES.md) [lock](${PUBLIC_BLOB_BASE}packaging/npm-shrinkwrap.json)`);
});

test('package stage: a staged markdown link or image whose target is not in the package is refused', () => {
  const file = (path: string, text: string) => ({ path, body: Buffer.from(text) });
  assert.doesNotThrow(() => assertStagedLinks([file('README.md', '[l](docs/LIMITS.md#x) [s](SECURITY.md) [w](https://example.org) [h](#top)'),
    file('docs/QUICKSTART.md', '[r](../README.md) [c](../quickstart/examples/quickstart/config.json)'), file('licenses/SEED_NOTICES.md', '[d](dependencies/)')], PACKAGE));
  for (const [path, text, target] of [
    ['README.md', 'See the [model](docs/SECURITY-MODEL.md#residuals).', 'docs/SECURITY-MODEL.md#residuals'],
    ['README.md', '<img src="docs/assets/brand/icon.svg">', 'docs/assets/brand/icon.svg'],
    ['README.md', '<source srcset="docs/assets/dark.svg">', 'docs/assets/dark.svg'],
    ['README.md', '![d](docs/assets/light.svg)', 'docs/assets/light.svg'],
    ['README.md', '[policy](.github/SECURITY.md)', '.github/SECURITY.md'],
    ['README.md', '[ref]: AGENTS.md', 'AGENTS.md'],
    ['docs/QUICKSTART.md', '[outside](../../elsewhere.md)', '../../elsewhere.md'],
    ['docs/QUICKSTART.md', '[config](../examples/quickstart/config.json)', '../examples/quickstart/config.json'],
  ] as const) {
    assert.throws(() => assertStagedLinks([file('docs/LIMITS.md', '[ok](../README.md)'), file(path, text)], PACKAGE),
      (error: unknown) => error instanceof StageFault && error.code === 'STAGE_DOCUMENT_LINK' && error.detail.length === 1 && error.detail[0] === `${path}: ${target}`, text);
  }
});

test('package stage: every shipped markdown document, as staged, links only inside the package or to the public repository', async () => {
  const approved = validateExpectedInventory(JSON.parse(await readFile(join(ROOT, 'packaging/npm-files.json'), 'utf8')));
  const staged = new Set(approved.files.map(f => f.path));
  const documents = approved.files.map(f => f.path).filter(path => path.endsWith('.md'));
  assert.ok(documents.includes('README.md') && documents.includes('docs/QUICKSTART.md'));
  for (const path of documents) {
    const source = sourceOf(path)!;
    const raw = await readFile(join(ROOT, source));
    assert.deepEqual(brokenMarkdownLinks(path, stagedMarkdown(path, source, raw, staged), staged), [], path);
  }
  // The repository README itself links outside the package, so it cannot ship unchanged.
  assert.notDeepEqual(brokenMarkdownLinks('README.md', await readFile(join(ROOT, 'README.md')), staged), []);
});
