import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalDependencyTree, dependencyTreeHash, verifyDependencyTree } from '../scripts/package-tree.js';
import type { TreeContext } from '../scripts/package-tree.js';

const integrity = (n: number): string => `sha512-${Buffer.alloc(64, n).toString('base64')}`;
const context: TreeContext = { platform: { os: 'darwin', arch: 'arm64' }, optional: [] };
function tree() {
  return { name: '@synthetic/leaf', version: '0.0.0-test', path: '/old/install', dependencies: {
    zeta: { version: '3.0.0', integrity: integrity(3) },
    alpha: { version: '1.0.0', integrity: integrity(1), path: '/old/install/node_modules/alpha', resolved: 'https://registry.npmjs.org/alpha',
      dependencies: { beta: { version: '2.0.0', integrity: integrity(2) } } }
  } };
}
test('package tree: relocation ordering and irrelevant npm metadata canonicalize identically', () => {
  const first = tree(), relocated = tree();
  relocated.path = '/unrelated/install'; relocated.dependencies.alpha.path = '/unrelated/install/node_modules/alpha';
  relocated.dependencies = { alpha: relocated.dependencies.alpha, zeta: relocated.dependencies.zeta };
  relocated.dependencies.alpha.resolved = 'https://registry.npmjs.org/alpha/-/alpha-1.0.0.tgz';
  const hash = dependencyTreeHash(first, context);
  assert.equal(dependencyTreeHash(relocated, context), hash); assert.equal(verifyDependencyTree(relocated, context, hash), hash);
  const canonical = JSON.stringify(canonicalDependencyTree(first, context));
  assert(!canonical.includes('/old/install')); assert(!canonical.includes('https:'));
});
test('package tree: changed transitive version or observed integrity fails approval', () => {
  const approved = dependencyTreeHash(tree(), context);
  for (const field of ['version', 'integrity'] as const) {
    const actual = tree(); actual.dependencies.alpha.dependencies.beta[field] = field === 'version' ? '2.0.1' : integrity(9);
    assert.throws(() => verifyDependencyTree(actual, context, approved), { code: 'TREE_MISMATCH' });
  }
  const missing = tree() as unknown as { dependencies: Record<string, unknown> }; delete missing.dependencies.zeta;
  assert.throws(() => verifyDependencyTree(missing, context, approved), { code: 'TREE_MISMATCH' });
  const extra = tree(); Object.assign(extra.dependencies, { extra: { version: '1.0.0', integrity: integrity(9) } });
  assert.throws(() => verifyDependencyTree(extra, context, approved), { code: 'TREE_MISMATCH' });
});
test('package tree: missing extraneous invalid linked dev and problem edges refuse', () => {
  for (const flag of ['missing', 'extraneous', 'invalid', 'link', 'dev', 'error']) {
    const actual = tree(); Object.assign(actual.dependencies.alpha.dependencies.beta, { [flag]: true });
    assert.throws(() => dependencyTreeHash(actual, context), { code: 'TREE_PROBLEM' });
  }
  assert.throws(() => dependencyTreeHash({ ...tree(), problems: ['private arbitrary error'] }, context), { code: 'TREE_PROBLEM', message: 'TREE_PROBLEM' });
  const noIntegrity = tree(); delete (noIntegrity.dependencies.zeta as Partial<typeof noIntegrity.dependencies.zeta>).integrity;
  assert.throws(() => dependencyTreeHash(noIntegrity, context), { code: 'TREE_INTEGRITY_MISSING' });
});
test('package tree: platform and optional selection are explicit independent hash inputs', () => {
  const absent: TreeContext = { platform: { os: 'darwin', arch: 'arm64' }, optional: [
    { name: 'native', version: '1.0.0', os: ['linux'], cpu: ['arm64'], selected: false }
  ] };
  const selected: TreeContext = { platform: { os: 'linux', arch: 'arm64' }, optional: [ { ...absent.optional[0]!, selected: true } ] };
  const actual = tree(); Object.assign(actual.dependencies, { native: { version: '1.0.0', integrity: integrity(4), optional: true } });
  assert.notEqual(dependencyTreeHash(tree(), absent), dependencyTreeHash(actual, selected));
  assert.notEqual(dependencyTreeHash(tree(), context), dependencyTreeHash(tree(), { ...context, platform: { os: 'linux', arch: 'arm64' } }));
  assert.throws(() => dependencyTreeHash(actual, absent), { code: 'TREE_OPTIONAL_MISMATCH' });
  assert.throws(() => dependencyTreeHash(tree(), selected), { code: 'TREE_OPTIONAL_MISMATCH' });
  assert.throws(() => dependencyTreeHash(actual, { ...selected, platform: { os: 'darwin', arch: 'arm64' } }), { code: 'TREE_OPTIONAL_MISMATCH' });
});
test('package tree: cycles depth invalid names and unobserved optional integrities fail closed', () => {
  const cyclic = tree(); Object.assign(cyclic.dependencies.alpha.dependencies, { cycle: cyclic });
  assert.throws(() => dependencyTreeHash(cyclic, context), { code: 'TREE_INVALID' });
  assert.throws(() => dependencyTreeHash({ name: '../unsafe', version: '1.0.0' }, context), { code: 'TREE_INVALID' });
  const badIntegrity = tree(); badIntegrity.dependencies.zeta.integrity = 'sha512-bad';
  assert.throws(() => dependencyTreeHash(badIntegrity, context), { code: 'TREE_INTEGRITY_MISSING' });
  const deep: Record<string, unknown> = { name: 'root', version: '1.0.0' }; let cursor = deep;
  for (let i = 0; i < 66; i++) {
    const child: Record<string, unknown> = { version: '1.0.0', integrity: integrity(1) };
    cursor.dependencies = { child }; cursor = child;
  }
  assert.throws(() => dependencyTreeHash(deep, context), { code: 'TREE_LIMIT' });
  assert.throws(() => dependencyTreeHash(tree(), { ...context, optional: [
    { name: 'native', version: '1.0.0', os: ['linux'], cpu: ['arm64'], selected: false },
    { name: 'native', version: '1.0.0', os: ['linux'], cpu: ['arm64'], selected: false }
  ] }), { code: 'TREE_OPTIONAL_MISMATCH' });
});
