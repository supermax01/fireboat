// Fast drift checks against the approved inventories (packaging/npm-files.json and packaging/helper-files.json); they
// need no temporary folder. Without a build: the shipped documents and license files on disk, as staged (markdown links
// rewritten for the package), the generated manifest, the helper inventory's copied files, and both inventories'
// identities against package.json and examples/quickstart/package.json. With a complete, fresh build: every file staged from dist/
// (compiled modules without their source-map comments, runtime data, the quickstart helper's modules and its timing
// script), computed by the stage's own functions. When dist/ is missing, is not a complete npm run build, or is older
// than its sources, that comparison is skipped and says why, so a test run before the build still passes after an
// edit; the stage (npm run stage:package) recompiles and compares dist/ with its sources, so it still refuses a stale
// build, which these tests do not check.
// The markdown link scanner shared by the rewrite and both link checks is tested here one form at a time.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { validateExpectedInventory, type ExpectedInventory } from '../scripts/package-inventory.js';
import { helperBoundary, HELPER_ENTRIES } from '../scripts/quickstart/check-helper-boundary.js';
import { observedGraph } from '../scripts/quickstart/module-graph.js';
import { assertRepositoryLinks, assertStagedLinks, brokenMarkdownLinks, describeInventoryDrift, documentSource, DOCUMENTS, HELPER_ASSETS, LICENSES_SOURCE, markdownAnchors,
  distComparisonSkip, distInventoryDrift, fromDist, manifestBytes, PUBLIC_BLOB_BASE, PUBLIC_RAW_BASE, PUBLIC_ROOT, repositoryFiles, repositoryLinkProblems, ROOT, rootIdentity, sha256, stageCopies, stagedCopy, stagedMarkdown, StageFault,
  type RepositoryFiles } from '../scripts/stage-package.js';

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
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  const files: ExpectedInventory['files'][number][] = [];
  for (const file of approved.files) {
    // The manifest is generated from package.json and its files list, which the stage requires to name every package path.
    if (file.path === 'package.json' || file.path === 'dist/package.json') {
      const body = manifestBytes(pkg, pkg.files);
      files.push({ ...file, size: body.byteLength, sha256: sha256(body) });
      continue;
    }
    const source = sourceOf(file.path);
    if (!source) { files.push(file); continue; }
    const raw = await readFile(join(ROOT, source));
    const body = file.path.endsWith('.md') ? stagedMarkdown(file.path, source, raw, staged) : raw;
    files.push({ ...file, size: body.byteLength, sha256: sha256(body) });
  }
  // Identities come from the manifests, as prepareFiles derives them, not from the inventories themselves.
  const actual: ExpectedInventory = { ...approved, identity: rootIdentity(pkg), files };
  // The helper inventory's entries that are not built: its package.json, lock file and assets, copied as the stage copies them.
  const helperApproved = validateExpectedInventory(JSON.parse(await readFile(join(ROOT, 'packaging/helper-files.json'), 'utf8')));
  const helperPkg = JSON.parse(await readFile(join(ROOT, 'examples/quickstart/package.json'), 'utf8'));
  const helperFiles = await Promise.all((await stageCopies(ROOT, [])).filter(c => c.target.startsWith('quickstart/') && !c.source.startsWith('dist/')).map(async ({ source, target, mode }) => {
    const body = stagedCopy(source, await readFile(join(ROOT, source)));
    return { path: target.slice('quickstart/'.length), mode, size: body.byteLength, sha256: sha256(body) };
  }));
  const drift = [...describeInventoryDrift('npm-files.json', approved, actual),
    ...describeInventoryDrift('helper-files.json', { ...helperApproved, files: helperApproved.files.filter(f => !fromDist(`quickstart/${f.path}`)) },
      { ...helperApproved, identity: rootIdentity(helperPkg), files: helperFiles })];
  assert.deepEqual(drift, [], `A shipped file changed after the inventory was approved:\n${drift.join('\n')}\n` +
    'If each change is intended and reviewed, run: npm run stage:package -- --approve-inventory <absolute-new-stage>');
});

test('pin-only: package approved dist bytes', async t => {
  const dist = join(ROOT, 'dist'), built = existsSync(dist);
  const complete = built && existsSync(join(dist, 'packages/server/src/generated/release.json'));
  const helperPkg = JSON.parse(await readFile(join(ROOT, 'examples/quickstart/package.json'), 'utf8'));
  const copies = complete
    ? (await stageCopies(ROOT, (await helperBoundary(observedGraph(dist, Object.keys(HELPER_ENTRIES)), p => readFile(join(dist, p), 'utf8'), Object.keys(helperPkg.dependencies))).modules))
      .filter(copy => copy.source.startsWith('dist/'))
    : [];
  // A compiled file older than its TypeScript source (or a copied data file older than the original) means dist/ is stale.
  const stale = copies.map(({ source }) => source).filter(source => {
    const original = source.slice('dist/'.length).replace(/\.js$/, '.ts');
    return existsSync(join(ROOT, original)) && statSync(join(ROOT, original)).mtimeMs > statSync(join(ROOT, source)).mtimeMs;
  });
  const skip = distComparisonSkip({ built, complete, stale });
  if (skip) { t.skip(skip); return; }
  const files = await Promise.all(copies.map(async ({ source, target, mode }) => {
    // As prepareFiles does: a dist entry must be a regular file, never a symbolic link.
    const info = await lstat(join(ROOT, source));
    assert.ok(info.isFile() && !info.isSymbolicLink(), `${source} is not a regular file`);
    const body = stagedCopy(source, await readFile(join(ROOT, source)));
    return { path: target, mode, size: body.byteLength, sha256: sha256(body) };
  }));
  const drift = distInventoryDrift(files, validateExpectedInventory(JSON.parse(await readFile(join(ROOT, 'packaging/npm-files.json'), 'utf8'))),
    validateExpectedInventory(JSON.parse(await readFile(join(ROOT, 'packaging/helper-files.json'), 'utf8'))));
  // The identities are compared by the no-build test above; here only the dist entries are.
  assert.deepEqual(drift, [], `A file staged from dist/ differs from the approved inventory:\n${drift.join('\n')}\n` +
    'If each change is intended, re-approve with: npm run stage:package -- --approve-inventory <absolute-new-stage>');
});

test('package inventory: the dist comparison skips an absent, incomplete or stale dist/ and says why', () => {
  assert.match(distComparisonSkip({ built: false, complete: false, stale: [] })!, /^dist\/ is not built: run npm run build/);
  assert.match(distComparisonSkip({ built: true, complete: false, stale: [] })!, /^dist\/ is not a complete npm run build: run npm run build/);
  assert.equal(distComparisonSkip({ built: true, complete: true, stale: ['dist/a.js', 'dist/b.js', 'dist/c.js', 'dist/d.js'] }),
    'dist/ is older than its sources (dist/a.js, dist/b.js, dist/c.js, ...): run npm run build to compare the approved dist hashes');
  assert.equal(distComparisonSkip({ built: true, complete: true, stale: [] }), undefined);
});

test('package inventory: files staged from dist/ are compared with both approved inventories', () => {
  const file = (path: string, hash: string, mode = 0o644) => ({ path, size: 1, mode, sha256: hash });
  const identity = { name: 'x', version: '1', bin: {} } as unknown as ExpectedInventory['identity'];
  const npm: ExpectedInventory = { schema: 1, identity, files: [file('README.md', 'r'), file('package.json', 'p'), file('dist/package.json', 'p'), file('dist/a.js', '1'),
    file('quickstart/dist/b.js', '2'), file('quickstart/fireboat-timing.mjs', '3', 0o755), file('quickstart/package.json', 'q')] } as ExpectedInventory;
  const helper: ExpectedInventory = { schema: 1, identity, files: [file('dist/b.js', '2'), file('fireboat-timing.mjs', '3', 0o755), file('package.json', 'q')] } as ExpectedInventory;
  const fresh = [file('dist/a.js', '1'), file('quickstart/dist/b.js', '2'), file('quickstart/fireboat-timing.mjs', '3', 0o755)];
  // Fresh and matching: no drift; documents, manifests and the helper's own package.json are not dist files.
  assert.deepEqual(distInventoryDrift(fresh, npm, helper), []);
  // Fresh and drifted: each inventory names its changed, added and removed dist paths.
  assert.deepEqual(distInventoryDrift([file('dist/a.js', '9'), file('quickstart/dist/b.js', '8'), file('dist/new.js', '7')], npm, helper), [
    'npm-files.json: changed dist/a.js', 'npm-files.json: added dist/new.js', 'npm-files.json: changed quickstart/dist/b.js', 'npm-files.json: removed quickstart/fireboat-timing.mjs',
    'helper-files.json: changed dist/b.js', 'helper-files.json: removed fireboat-timing.mjs']);
  assert.deepEqual(distInventoryDrift([...fresh.slice(0, 2), file('quickstart/fireboat-timing.mjs', '3')], npm, helper),
    ['npm-files.json: changed quickstart/fireboat-timing.mjs', 'helper-files.json: changed fireboat-timing.mjs']);
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

// The link scanner, one form at a time. `stage` rewrites like the stage does; `broken` is the package-side check and
// `untracked` the repository-side check, which runs on the document before the rewrite.
const stage = (text: string, from = 'README.md'): string => stagedMarkdown(from, from, Buffer.from(text), PACKAGE).toString();
const broken = (text: string, path = 'README.md'): string[] => brokenMarkdownLinks(path, Buffer.from(text), PACKAGE).map(line => line.slice(path.length + 2));
const REPOSITORY_TEXTS: Record<string, string> = {
  'docs/TESTING.md': '# Testing\n\n## Results on this tree\n\n## Results on this tree\n\nResults\n-------\n\n<a id="kept-anchor"></a>\n\n```\n# not a heading\n```\n',
  'docs/LIMITS.md': '# Size and time limits\n\n## The `max_bytes` ceiling: 65,536 bytes\n\n### **Bold** _and_ [linked](x.md) words\n',
};
const REPOSITORY: RepositoryFiles = {
  tracked: new Set(['README.md', 'AGENTS.md', 'docs/TESTING.md', 'docs/LIMITS.md', 'docs/a b.md', 'bench/README.md', 'packages/core/src/index.ts', 'docs/assets/logo.svg']),
  read: path => REPOSITORY_TEXTS[path] ?? '',
};
const untracked = (text: string, path = 'README.md'): string[] => repositoryLinkProblems(path, path, Buffer.from(text), REPOSITORY).map(line => line.slice(path.length + 2));
const BLOB = PUBLIC_BLOB_BASE, RAW = PUBLIC_RAW_BASE;

test('package links: a fence closes only on its own character, at least as long as it opened', () => {
  const wrapped = '````md\n```\n[inside](docs/NOPE.md)\n```\n````\n[after](AGENTS.md)';
  assert.equal(stage(wrapped), `\`\`\`\`md\n\`\`\`\n[inside](docs/NOPE.md)\n\`\`\`\n\`\`\`\`\n[after](${BLOB}AGENTS.md)`);
  assert.deepEqual(broken(wrapped), ['AGENTS.md']);
  const mixed = '```\n~~~\n[inside](docs/NOPE.md)\n```\n[after](docs/NOPE.md)';
  assert.equal(stage(mixed), `\`\`\`\n~~~\n[inside](docs/NOPE.md)\n\`\`\`\n[after](${BLOB}docs/NOPE.md)`);
  assert.deepEqual(broken(mixed), ['docs/NOPE.md']);
  // A closing fence is no longer than nothing but the fence character: "``` x" and "``" do not close.
  assert.deepEqual(broken('```\n``` x\n``\n[inside](docs/NOPE.md)\n```\n[after](docs/NOPE.md)'), ['docs/NOPE.md']);
  // An unclosed fence runs to the end of the document, as a renderer shows it.
  assert.deepEqual(broken('[before](docs/NOPE.md)\n~~~~\n~~~\n[inside](docs/NOPE.md)'), ['docs/NOPE.md']);
});

test('package links: a fence inside a list item or block quote is code, and ends with its container', () => {
  const listed = '- step\n\n    ```sh\n    [inside](docs/NOPE.md)\n    ```\n\n  [after](docs/NOPE.md)';
  assert.equal(stage(listed), `- step\n\n    \`\`\`sh\n    [inside](docs/NOPE.md)\n    \`\`\`\n\n  [after](${BLOB}docs/NOPE.md)`);
  assert.deepEqual(broken(listed), ['docs/NOPE.md']);
  assert.deepEqual(broken('1. one\n   ```\n   [inside](docs/NOPE.md)\n   ```\n2. two [after](docs/NOPE.md)'), ['docs/NOPE.md']);
  assert.deepEqual(broken('> ```\n> [inside](docs/NOPE.md)\n> ```\n> [after](docs/NOPE.md)'), ['docs/NOPE.md']);
  // The container ending ends the fence: the block quote stops, or the list item's content is no longer indented.
  assert.deepEqual(broken('> ```\n> [inside](docs/NOPE.md)\n[after](docs/NOPE.md)'), ['docs/NOPE.md']);
  assert.deepEqual(broken('- ```\n  [inside](docs/NOPE.md)\n[after](docs/NOPE.md)'), ['docs/NOPE.md']);
  // Four spaces outside a list is not a fence, so what follows is still prose and still checked; a list ends at a
  // line indented less than its content, after which four spaces are no longer inside it.
  assert.deepEqual(broken('para\n\n    ```\n[after](docs/NOPE.md)'), ['docs/NOPE.md']);
  assert.deepEqual(broken('- item\n\npara\n\n    ```\n[after](docs/NOPE.md)'), ['docs/NOPE.md']);
  assert.deepEqual(broken('- item\n\npara\n\n```\n[inside](docs/NOPE.md)\n```\n[after](AGENTS.md)'), ['AGENTS.md']);
  // After the list has ended, four-space-indented code is not a fence (and, like all indented code, is still checked).
  assert.deepEqual(broken('- item\n\npara\n\n    ```\n    [inside](docs/NOPE.md)'), ['docs/NOPE.md']);
});

test('package links: a link written inside a code span is text, but a link whose text holds code is a link', () => {
  const text = 'Write `[x](docs/NOPE.md)` or ``a ` [y](docs/NOPE.md)`` literally; see [`.nvmrc`](.nvmrc) and \\`[z](AGENTS.md)\\`.';
  assert.equal(stage(text), `Write \`[x](docs/NOPE.md)\` or \`\`a \` [y](docs/NOPE.md)\`\` literally; see [\`.nvmrc\`](${BLOB}.nvmrc) and \\\`[z](${BLOB}AGENTS.md)\\\`.`);
  assert.deepEqual(broken(text), ['.nvmrc', 'AGENTS.md']);
  // A code span can wrap within a paragraph; an unmatched backtick is literal.
  assert.deepEqual(broken('`wrapped\n[x](docs/NOPE.md)` and a lone ` then [y](AGENTS.md)'), ['AGENTS.md']);
});

test('package links: links, definitions and HTML attributes wrapped across lines are found', () => {
  const text = '[two\nlines](AGENTS.md) [next](\n  docs/NOPE.md "title")\n\n> [quoted\n> text](docs/NOPE.md)\n\n[id]:\n  docs/NOPE.md\n\n<img\n  alt="x"\n  src=\n  "docs/NOPE.svg">';
  assert.equal(stage(text), `[two\nlines](${BLOB}AGENTS.md) [next](\n  ${BLOB}docs/NOPE.md "title")\n\n> [quoted\n> text](${BLOB}docs/NOPE.md)\n\n[id]:\n  ${BLOB}docs/NOPE.md\n\n<img\n  alt="x"\n  src=\n  "${RAW}docs/NOPE.svg">`);
  assert.deepEqual(broken(text), ['AGENTS.md', 'docs/NOPE.md', 'docs/NOPE.md', 'docs/NOPE.md', 'docs/NOPE.svg']);
  // Link text never spans a blank line.
  assert.deepEqual(broken('[not\n\nlinked](docs/NOPE.md)'), []);
});

test('package links: angle-bracket and parenthesised destinations are read whole', () => {
  const text = '[a](<docs/a b.md>) [b](docs/a(1).md) [c](<docs/LIMITS.md#bytes> "t") [d](docs/x\\(y.md)';
  assert.equal(stage(text), `[a](<${BLOB}docs/a%20b.md>) [b](${BLOB}docs/a%281%29.md) [c](<docs/LIMITS.md#bytes> "t") [d](${BLOB}docs/x%28y.md)`);
  assert.deepEqual(broken(text), ['docs/a b.md', 'docs/a(1).md', 'docs/x\\(y.md']);
  assert.deepEqual(untracked('[a](<docs/a b.md>) [b](docs/a(1).md)'), ['docs/a(1).md']);
  // A rewritten path is percent-encoded: a decoded `#` or `%` must not turn into a fragment or an escape.
  assert.equal(stage('[a](docs/a%23b.md) [b](docs/100%25.md) [c](docs/caf%C3%A9.md)'), `[a](${BLOB}docs/a%23b.md) [b](${BLOB}docs/100%25.md) [c](${BLOB}docs/caf%C3%A9.md)`);
});

test('package links: reference definitions in block quotes and list items are found, and a reference image uses the raw host', () => {
  const text = '> [quoted]: docs/NOPE.md\n\n- [listed]: AGENTS.md\n  1. [nested]: <docs/LIMITS.md>\n\n![logo][] ![alt][Logo] [page][logo]\n\n[logo]: docs/assets/logo.svg\n[plain]: docs/assets/logo.svg';
  assert.equal(stage(text), `> [quoted]: ${BLOB}docs/NOPE.md\n\n- [listed]: ${BLOB}AGENTS.md\n  1. [nested]: <docs/LIMITS.md>\n\n![logo][] ![alt][Logo] [page][logo]\n\n[logo]: ${RAW}docs/assets/logo.svg\n[plain]: ${BLOB}docs/assets/logo.svg`);
  assert.deepEqual(broken(text), ['docs/NOPE.md', 'AGENTS.md', 'docs/assets/logo.svg', 'docs/assets/logo.svg']);
  // A shortcut reference image, and a definition label wrapped like the reference's.
  assert.equal(stage('![Logo Mark]\n\n[logo  mark]: docs/assets/logo.svg'), `![Logo Mark]\n\n[logo  mark]: ${RAW}docs/assets/logo.svg`);
});

test('package links: HTML URL attributes are found whatever their case, spacing or quoting', () => {
  const text = '<IMG SRC="docs/a.svg"> <img src = \'docs/b.svg\'> <img src=docs/c.svg> <video poster="docs/d.png" src="docs/e.mp4"></video>\n' +
    '<object data="docs/f.svg"></object> <svg><image xlink:href="docs/g.svg"/></svg> <A HREF=AGENTS.md>x</A> <q cite="docs/h.md">q</q>\n' +
    '<picture><source srcset="docs/i.svg 1x, docs/j.svg 2x"></picture> <img data-src="docs/k.svg" alt="src=docs/l.svg">';
  assert.equal(stage(text), `<IMG SRC="${RAW}docs/a.svg"> <img src = '${RAW}docs/b.svg'> <img src=${RAW}docs/c.svg> <video poster="${RAW}docs/d.png" src="${RAW}docs/e.mp4"></video>\n` +
    `<object data="${RAW}docs/f.svg"></object> <svg><image xlink:href="${RAW}docs/g.svg"/></svg> <A HREF=${BLOB}AGENTS.md>x</A> <q cite="${BLOB}docs/h.md">q</q>\n` +
    `<picture><source srcset="${RAW}docs/i.svg 1x, ${RAW}docs/j.svg 2x"></picture> <img data-src="docs/k.svg" alt="src=docs/l.svg">`);
  assert.deepEqual(broken(text), ['docs/a.svg', 'docs/b.svg', 'docs/c.svg', 'docs/d.png', 'docs/e.mp4', 'docs/f.svg', 'docs/g.svg', 'AGENTS.md', 'docs/h.md', 'docs/i.svg', 'docs/j.svg']);
  // An HTML tag written inside a code span is text.
  assert.deepEqual(broken('Use `<img src="docs/NOPE.svg">` here.'), []);
});

test('package links: a target starting at the repository root is refused, never resolved', () => {
  assert.equal(stage('[x](/docs/LIMITS.md) ![y](/docs/assets/logo.svg)'), '[x](/docs/LIMITS.md) ![y](/docs/assets/logo.svg)');
  assert.deepEqual(broken('[x](/docs/LIMITS.md) ![y](/docs/assets/logo.svg) <a href="/README.md">z</a>'), ['/docs/LIMITS.md', '/docs/assets/logo.svg', '/README.md']);
  assert.deepEqual(broken('[x](/docs/LIMITS.md)', 'docs/QUICKSTART.md'), ['/docs/LIMITS.md']);
  // Protocol-relative and absolute URLs are external, not root-relative.
  assert.deepEqual(broken('[x](//example.org/a.md) [y](https://example.org/a.md)'), []);
});

test('package links: percent-encoded targets are decoded before the package lookup', () => {
  assert.equal(stage('[x](LIMITS%2Emd#bytes) [y](a%20b.md) [z](%2E%2E/README.md)', 'docs/QUICKSTART.md'),
    `[x](LIMITS.md#bytes) [y](${BLOB}docs/a%20b.md) [z](../README.md)`);
  assert.deepEqual(broken('[x](docs/LIMITS%2Emd) [y](SECURITY%2Emd#top)'), []);
  assert.deepEqual(untracked('[y](docs/a%20b.md)'), []);
  // A target that cannot be decoded is left as written and refused, never guessed.
  assert.equal(stage('[x](docs/LIMITS%E0%A4.md)'), '[x](docs/LIMITS%E0%A4.md)');
  assert.deepEqual(broken('[x](docs/LIMITS%E0%A4.md)'), ['docs/LIMITS%E0%A4.md']);
});

test('package links: a target rewritten to the public repository must be tracked in this repository', () => {
  assert.deepEqual(untracked('[ok](docs/TESTING.md) [folder](bench/) [code](packages/core/src/index.ts#L1) [web](https://example.org/x) [typo](docs/NOPE.md) [gone](missing/) [up](../outside.md)'),
    ['docs/NOPE.md', 'missing/']);
  assert.deepEqual(untracked('[readme](../README.md) [nope](../NOPE.md)', 'docs/QUICKSTART.md'), ['../NOPE.md']);
  // The stage refuses with the document and target named, and nothing else.
  assert.throws(() => assertRepositoryLinks([{ path: 'README.md', source: 'README.md', body: Buffer.from('[a](AGENTS.md)') },
    { path: 'SECURITY.md', source: '.github/SECURITY.md', body: Buffer.from('[b](../docs/NOPE.md)') }], REPOSITORY),
  (error: unknown) => error instanceof StageFault && error.code === 'STAGE_DOCUMENT_LINK' && isDeepStrictEqual(error.detail, ['SECURITY.md: ../docs/NOPE.md']));
  assert.doesNotThrow(() => assertRepositoryLinks([{ path: 'README.md', source: 'README.md', body: Buffer.from('[a](AGENTS.md) [t](docs/TESTING.md#results)') }], REPOSITORY));
});

test('package links: an anchor into a markdown file or the document itself must name a heading or HTML id', () => {
  assert.deepEqual([...markdownAnchors(REPOSITORY_TEXTS['docs/TESTING.md']!)], ['testing', 'results-on-this-tree', 'results-on-this-tree-1', 'results', 'kept-anchor']);
  assert.deepEqual([...markdownAnchors(REPOSITORY_TEXTS['docs/LIMITS.md']!)], ['size-and-time-limits', 'the-max_bytes-ceiling-65536-bytes', 'bold-and-linked-words']);
  assert.deepEqual(untracked('[a](docs/TESTING.md#results-on-this-tree-1) [b](docs/TESTING.md#kept-anchor) [c](docs/LIMITS.md#the-max_bytes-ceiling-65536-bytes) ' +
    '[d](docs/TESTING.md#Results) [e](packages/core/src/index.ts#L10) [f](docs/TESTING.md#results-on-this-tree-2) [g](docs/TESTING.md#not-a-heading) [h](docs/LIMITS.md#bold-and-linked-words)'),
  ['docs/TESTING.md#results-on-this-tree-2', 'docs/TESTING.md#not-a-heading']);
  // Anchors within the document itself, including percent-encoded ones and the top of the page.
  assert.deepEqual(untracked('# Café notes\n\n## Questions?\n\n[a](#questions) [b](#caf%C3%A9-notes) [c](#top) [d](#) [e](#answers) [f](README.md#questions)'), ['#answers']);
});

test('package links: a footnote is not a link definition, but a link inside one is a link', () => {
  const text = 'Text.[^1] More.[^docs]\n\n[^1]: Some text here.\n[^docs]: docs are tracked; see [the limits](docs/LIMITS.md) and [x](docs/NOPE.md).\n\n![^2]\n';
  assert.equal(stage(text), `Text.[^1] More.[^docs]\n\n[^1]: Some text here.\n[^docs]: docs are tracked; see [the limits](docs/LIMITS.md) and [x](${BLOB}docs/NOPE.md).\n\n![^2]\n`);
  assert.deepEqual(broken(text), ['docs/NOPE.md']);
  assert.deepEqual(untracked(text), ['docs/NOPE.md']);
});

test('package links: a query is kept on the rewritten link and left out of the lookup', () => {
  const text = '[a](docs/TESTING.md?plain=1#results) ![b](docs/assets/logo.svg?raw=true) [c](docs/LIMITS.md?plain=1#size-and-time-limits) [d](docs/NOPE.md?plain=1)';
  assert.equal(stage(text), `[a](${BLOB}docs/TESTING.md?plain=1#results) ![b](${RAW}docs/assets/logo.svg?raw=true) [c](docs/LIMITS.md?plain=1#size-and-time-limits) [d](${BLOB}docs/NOPE.md?plain=1)`);
  assert.deepEqual(broken(text), ['docs/TESTING.md?plain=1#results', 'docs/assets/logo.svg?raw=true', 'docs/NOPE.md?plain=1']);
  assert.deepEqual(untracked(text), ['docs/NOPE.md?plain=1']);
});

test('package links: a link to the repository root points at the public repository', () => {
  assert.equal(stage('[folder](./) [up](../) [readme](../#readme)', 'docs/QUICKSTART.md'), `[folder](${BLOB}docs/) [up](${PUBLIC_ROOT}) [readme](${PUBLIC_ROOT}#readme)`);
  assert.equal(stage('[home](./) [top](./#readme) [q](.?tab=1)'), `[home](${PUBLIC_ROOT}) [top](${PUBLIC_ROOT}#readme) [q](${PUBLIC_ROOT}?tab=1)`);
  assert.deepEqual(untracked('[home](./) [top](./#readme)'), []);
  assert.deepEqual(untracked('[up](../)', 'docs/QUICKSTART.md'), []);
  assert.deepEqual(brokenMarkdownLinks('README.md', Buffer.from(stage('[home](./)')), PACKAGE), []);
});

test('package links: a link to the folder a shipped document sits in stays inside the package', () => {
  const notices = (text: string) => stagedMarkdown('licenses/SEED_NOTICES.md', 'packaging/licenses/SEED_NOTICES.md', Buffer.from(text), PACKAGE).toString();
  assert.equal(notices('[here](./) [same](../licenses/) [dot](.) [dependency](dependencies/zod/LICENSE)'), '[here](./) [same](./) [dot](.) [dependency](dependencies/zod/LICENSE)');
  assert.deepEqual(brokenMarkdownLinks('licenses/SEED_NOTICES.md', Buffer.from(notices('[here](./) [same](../licenses/) [dot](.)')), PACKAGE), []);
});

test('package links: a heading anchor ignores link destinations, including code in the text and parentheses in the destination', () => {
  assert.deepEqual([...markdownAnchors('## The [`fhir_search`](x.md) tool\n\n## See [spec](docs/a(1).md)\n\n## ![Logo](a.svg) [and][ref] \\[not a link](x)\n\n## Code `[x](y)` kept')],
    ['the-fhir_search-tool', 'see-spec', 'logo-and-not-a-linkx', 'code-xy-kept']);
  assert.deepEqual(untracked('## The [`fhir_search`](docs/LIMITS.md) tool\n\n[a](#the-fhir_search-tool) [b](#the-fhir_searchdocslimitsmd-tool)'), ['#the-fhir_searchdocslimitsmd-tool']);
});

test('package links: a target starting at a root after decoding, or holding an encoded slash, is refused', () => {
  assert.equal(stage('[a](%2Fdocs/LIMITS.md) [b](docs%2FLIMITS.md) [c](docs/a%2fb.md)'), '[a](%2Fdocs/LIMITS.md) [b](docs%2FLIMITS.md) [c](docs/a%2fb.md)');
  assert.deepEqual(broken('[a](%2Fdocs/LIMITS.md) [b](docs%2FLIMITS.md) [c](docs/a%2fb.md)'), ['%2Fdocs/LIMITS.md', 'docs%2FLIMITS.md', 'docs/a%2fb.md']);
});

test('package links: a rewritten target is escaped for the syntax around it, and HTML URLs lose surrounding space', () => {
  const text = '[a](docs/NOPE.md#a\\)b) [b](<docs/a b.md#x y>) <a href=\'docs/it%27s.md\'>x</a> <img src=docs/u%3Db.svg> <a href="docs/q.md#&quot;x">y</a> <a href="  AGENTS.md  ">z</a>';
  assert.equal(stage(text), `[a](${BLOB}docs/NOPE.md#a%29b) [b](<${BLOB}docs/a%20b.md#x%20y>) <a href='${BLOB}docs/it%27s.md'>x</a> <img src=${RAW}docs/u%3Db.svg> <a href="${BLOB}docs/q.md#&quot;x">y</a> <a href="  ${BLOB}AGENTS.md  ">z</a>`);
  // Every rewritten target is read back whole by the same scanner.
  assert.deepEqual(broken(stage(text)), []);
  assert.deepEqual(broken('<a href="  AGENTS.md  ">x</a> <a href="   ">y</a>'), ['AGENTS.md']);
});

test('package links: srcset candidates are read as HTML reads them, data: URLs and block quotes included', () => {
  const text = '<img srcset="data:image/png;base64,AAAA 1x, docs/a.svg 2x,docs/b.svg,, docs/c.svg 3x">\n> <img srcset="docs/d.svg 1x,\n> docs/e.svg 2x">';
  assert.equal(stage(text), `<img srcset="data:image/png;base64,AAAA 1x, ${RAW}docs/a.svg 2x,${RAW}docs/b.svg,, ${RAW}docs/c.svg 3x">\n> <img srcset="${RAW}docs/d.svg 1x,\n> ${RAW}docs/e.svg 2x">`);
  assert.deepEqual(broken(text), ['docs/a.svg', 'docs/b.svg', 'docs/c.svg', 'docs/d.svg', 'docs/e.svg']);
  // A rewritten candidate may not carry a comma, which would split it.
  assert.equal(stage('<img srcset="docs/a,b.svg 1x">'), `<img srcset="${RAW}docs/a%2Cb.svg 1x">`);
});

test('package links: a file linked as a folder is refused', () => {
  assert.deepEqual(broken('[a](docs/LIMITS.md/) [b](licenses/dependencies/) [c](SECURITY.md/#top)'), ['docs/LIMITS.md/', 'SECURITY.md/#top']);
  assert.deepEqual(untracked('[a](docs/LIMITS.md/) [b](docs/assets/logo.svg/) [c](bench/) [d](docs/)'), ['docs/LIMITS.md/', 'docs/assets/logo.svg/']);
});

/** A scratch git repository holding `files`, committed; deleted by the caller. */
function scratchRepository(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'fireboat-links-'));
  const git = (...args: string[]) => {
    const run = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    assert.equal(run.status, 0, run.stderr);
  };
  git('init', '-q');
  for (const [path, text] of Object.entries(files)) { mkdirSync(join(dir, path, '..'), { recursive: true }); writeFileSync(join(dir, path), text); }
  git('add', '-A');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'files');
  return dir;
}

test('package links: tracked files come from the top level of a git checkout, and only those still on disk count', () => {
  const repo = scratchRepository({ 'README.md': '# Readme\n', 'docs/kept.md': 'x', 'docs/gone.md': 'y', 'nested/inner/file.md': 'z' });
  const outside = mkdtempSync(join(tmpdir(), 'fireboat-links-'));
  try {
    rmSync(join(repo, 'docs/gone.md'));
    writeFileSync(join(repo, 'untracked.md'), 'u');
    const files = repositoryFiles(repo);
    assert.deepEqual([...files.tracked].sort(), ['README.md', 'docs/kept.md', 'nested/inner/file.md']);
    assert.equal(files.read('README.md'), '# Readme\n');
    // A folder inside a checkout (a copy or export without its own .git), or a folder in no checkout, is refused as such.
    const refusesCheckout = (error: unknown) => error instanceof StageFault && error.code === 'STAGE_NEEDS_GIT_CHECKOUT';
    assert.throws(() => repositoryFiles(join(repo, 'nested')), refusesCheckout);
    assert.throws(() => repositoryFiles(join(repo, 'nested/inner')), refusesCheckout);
    assert.throws(() => repositoryFiles(outside), refusesCheckout);
    // A checkout whose index git cannot read is refused rather than read as tracking nothing.
    writeFileSync(join(repo, '.git/index'), 'not an index');
    assert.throws(() => repositoryFiles(repo), (error: unknown) => error instanceof StageFault && error.code === 'STAGE_TRACKED_FILES');
  } finally {
    rmSync(repo, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true });
  }
});

test('package links: every shipped markdown document links only to tracked files, with anchors that exist', async t => {
  if (!existsSync(join(ROOT, '.git'))) { t.skip('not a git checkout: tracked files are unknown'); return; }
  const approved = validateExpectedInventory(JSON.parse(await readFile(join(ROOT, 'packaging/npm-files.json'), 'utf8')));
  const repository = repositoryFiles(ROOT);
  for (const path of approved.files.map(f => f.path).filter(p => p.endsWith('.md'))) {
    const source = sourceOf(path)!;
    assert.deepEqual(repositoryLinkProblems(path, source, await readFile(join(ROOT, source)), repository), [], path);
  }
});
