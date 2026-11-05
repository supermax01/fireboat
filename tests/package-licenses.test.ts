import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { ROOT, sha256 } from '../scripts/stage-package.js';

const licenses = await import(pathToFileURL(join(ROOT, 'scripts/release-licenses.mjs')).href);
test('package licenses: required upstream NOTICE cannot be omitted and optional project NOTICE is not invented', () => {
  const license = { source: 'LICENSE', kind: 'license', path: 'licenses/dependency/LICENSE', bytes: 7, sha256: sha256('license') };
  const notice = { source: 'NOTICE', kind: 'notice', path: 'licenses/dependency/NOTICE', bytes: 6, sha256: sha256('notice') };
  const dependency = { name: 'synthetic-package', requiredTexts: [{ source: 'LICENSE', kind: 'license' }, { source: 'NOTICE', kind: 'notice' }], texts: [license, notice] };
  licenses.validateNoticeInventory({ dependencies: [dependency] });
  assert.throws(() => licenses.validateNoticeInventory({ dependencies: [{ ...dependency, texts: [license] }] }), { code: 'NOTICE_MISSING' });
  licenses.validateNoticeInventory({ dependencies: [{ ...dependency, requiredTexts: [{ source: 'LICENSE', kind: 'license' }], texts: [license] }] });
});

test('package licenses: all 14 locked dependencies carry verbatim installed texts and correct integrity and component membership', async () => {
  const inventory = await licenses.checkReleaseLicenses(ROOT);
  assert.equal(inventory.dependencies.length, 14);
  const gateway = inventory.dependencies.filter((d: any) => d.components.includes('gateway')).map((d: any) => d.name);
  assert.deepEqual(gateway, ['@modelcontextprotocol/core', '@modelcontextprotocol/server', 'zod']);
  const client = inventory.dependencies.find((d: any) => d.name === '@modelcontextprotocol/client');
  assert.deepEqual(client.components, ['quickstart']);
  for (const dependency of inventory.dependencies) {
    assert.match(dependency.integrity, /^sha512-/);
    for (const text of dependency.texts) {
      const approved = await readFile(join(ROOT, text.path)), installed = await readFile(join(ROOT, 'node_modules', dependency.name, text.source));
      assert.deepEqual(approved, installed); assert.equal(approved.length, text.bytes); assert.equal(sha256(approved), text.sha256);
    }
  }
});

test('package licenses: a changed required license body refuses rather than copying an approval hash', async t => {
  const scratch = await mkdtemp(join(tmpdir(), 'fireboat-license-test-')); t.after(() => rm(scratch, { recursive: true, force: true }));
  // A complete synthetic installed package with its own required NOTICE, not one borrowed from a different package.
  const write = async (path: string, body: string) => { await mkdir(dirname(join(scratch, path)), { recursive: true }); await writeFile(join(scratch, path), body); };
  const rootFiles = ['packaging/npm-shrinkwrap.json', 'examples/quickstart/package-lock.json', 'examples/quickstart/seed-manifest.json', 'examples/quickstart/generator-pins.json',
    'packages/evals/fixtures/quickstart/resources.ndjson', 'licenses/SEED_NOTICES.md'];
  for (const path of rootFiles) await write(path, await readFile(join(ROOT, path), 'utf8'));
  const collected = await licenses.collectReleaseLicenses(ROOT);
  for (const dependency of collected.inventory.dependencies) {
    await write(`node_modules/${dependency.name}/package.json`, await readFile(join(ROOT, 'node_modules', dependency.name, 'package.json'), 'utf8'));
    for (const text of dependency.texts) await write(`node_modules/${dependency.name}/${text.source}`, await readFile(join(ROOT, text.path), 'utf8'));
  }
  await write('node_modules/zod/NOTICE', 'Synthetic required upstream notice\n');
  const inventory = await licenses.writeReleaseLicenses(scratch);
  await licenses.checkReleaseLicenses(scratch);
  const zod = inventory.dependencies.find((d: any) => d.name === 'zod'), notice = zod.texts.find((r: any) => r.kind === 'notice');
  await rm(join(scratch, notice.path));
  await assert.rejects(licenses.checkReleaseLicenses(scratch), { code: 'NOTICE_MISSING' });
  await write(notice.path, 'Synthetic required upstream notice\n');
  await write(zod.texts.find((r: any) => r.kind === 'license').path, 'altered');
  await assert.rejects(licenses.checkReleaseLicenses(scratch), { code: 'LICENSE_TEXT_CHANGED' });
});

test('package licenses: seed and terminology inventory stays count-only and leaves rights review explicit', async () => {
  const inventory = await licenses.checkReleaseLicenses(ROOT);
  assert.equal(inventory.seed.resources, 282); assert.equal(inventory.seed.generator.distributed, false);
  assert.equal(inventory.seed.generator.rightsReview, 'pending-owner-review');
  assert.ok(inventory.seed.terminology.some((r: any) => r.system === 'http://loinc.org'));
  for (const row of inventory.seed.terminology) {
    assert.deepEqual(Object.keys(row).sort(), ['codes', 'displays', 'rightsReview', 'system']);
    assert.ok(Number.isSafeInteger(row.codes)); assert.equal(row.rightsReview, 'pending-owner-review');
  }
  assert.equal(/patientId|resourceType|valueQuantity/.test(JSON.stringify(inventory)), false);
});
