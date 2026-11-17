import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import test from 'node:test';
import valid from './fixtures/package-inventory/valid.json' with { type: 'json' };
import invalid from './fixtures/package-inventory/invalid.json' with { type: 'json' };
import { inspectNpmPack, inspectTar, validateExpectedInventory, verifyPackInventory } from '../scripts/package-inventory.js';

const identity = valid.identity;
const bodies: Record<string, Buffer> = {
  'package.json': Buffer.from(`${JSON.stringify(identity)}\n`),
  'dist/cli.js': Buffer.from('#!/usr/bin/env node\nprocess.exitCode = 0;\n'),
  'docs/support.json': Buffer.from('{"synthetic":true}\n')
};
type Entry = { path: string; body: Buffer; mode?: number; type?: string; link?: string; prefix?: string; size?: number };
const entries = (): Entry[] => valid.files.map(f => ({ path: `package/${f.path}`, body: bodies[f.path]!, mode: f.mode }));
const npmPack = () => [{ id: `${identity.name}@${identity.version}`, name: identity.name, version: identity.version,
  files: valid.files.map(({ path, size, mode }) => ({ path, size, mode })) }];
const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
function checksum(header: Buffer): void {
  header.fill(32, 148, 156);
  header.write(`${header.reduce((a, b) => a + b, 0).toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
}
function tar(files: Entry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const f of files) {
    const header = Buffer.alloc(512);
    const octal = (start: number, width: number, value: number): void => { header.write(`${value.toString(8).padStart(width - 1, '0')}\0`, start, width, 'ascii'); };
    header.write(f.path, 0, 100); octal(100, 8, f.mode ?? 0o644); octal(108, 8, 0); octal(116, 8, 0);
    octal(124, 12, f.size ?? f.body.length); octal(136, 12, 0);
    header.write(f.type ?? '0', 156, 1); header.write(f.link ?? '', 157, 100);
    header.write('ustar\0', 257, 6); header.write('00', 263, 2); header.write(f.prefix ?? '', 345, 155);
    checksum(header); blocks.push(header, f.body, Buffer.alloc((512 - f.body.length % 512) % 512));
  }
  blocks.push(Buffer.alloc(1024)); return Buffer.concat(blocks);
}

test('package inventory: independent npm and tar inventories validate synthetic bodies modes and hashes', () => {
  assert.deepEqual(validateExpectedInventory(valid), valid);
  assert.throws(() => validateExpectedInventory(invalid), { code: 'PACK_EXPECTATION_INVALID' });
  const result = verifyPackInventory({ expected: valid, npmPack: npmPack(), tar: tar(entries()) });
  assert.equal(result.files.length, 3); assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(verifyPackInventory({ expected: valid, npmPack: npmPack(), tar: gzipSync(tar(entries())) }), result);
  assert.deepEqual(inspectTar(tar(entries())).map(f => f.sha256), valid.files.map(f => f.sha256));
});
test('package inventory: unexpected approved-boundary file is refused', () => {
  const pack = npmPack(), extra = { path: 'docs/unreviewed.txt', size: 1, mode: 0o644 };
  pack[0]!.files.push(extra);
  assert.throws(() => verifyPackInventory({ expected: valid, npmPack: pack,
    tar: tar([...entries(), { path: `package/${extra.path}`, body: Buffer.from('x') }]) }), { code: 'PACK_UNEXPECTED' });
});
test('package inventory: each required file missing from both inventories is refused', () => {
  for (const path of ['docs/support.json', 'dist/cli.js', 'package.json']) {
    const pack = npmPack(); pack[0]!.files = pack[0]!.files.filter(f => f.path !== path);
    assert.throws(() => verifyPackInventory({ expected: valid, npmPack: pack,
      tar: tar(entries().filter(f => f.path !== `package/${path}`)) }), { code: 'PACK_MISSING' });
  }
});
test('package inventory: npm list and tar mode size or membership disagreement refuses', () => {
  for (const change of ['mode', 'size', 'path'] as const) {
    const pack = npmPack();
    if (change === 'mode') pack[0]!.files[1]!.mode = 0o644;
    if (change === 'size') pack[0]!.files[1]!.size++;
    const actual = entries(); if (change === 'path') actual.pop();
    assert.throws(() => verifyPackInventory({ expected: valid, npmPack: pack, tar: tar(actual) }), { code: 'PACK_LIST_MISMATCH' });
  }
});
test('package inventory: substituted body size or mode fails approved-file comparison', () => {
  const changed = entries(); changed[1]!.body = Buffer.from(changed[1]!.body); changed[1]!.body[20] = 88;
  assert.throws(() => verifyPackInventory({ expected: valid, npmPack: npmPack(), tar: tar(changed) }), { code: 'PACK_FILE_MISMATCH' });
  for (const field of ['mode', 'size'] as const) {
    const actual = entries(), pack = npmPack();
    if (field === 'mode') { actual[1]!.mode = 0o644; pack[0]!.files[1]!.mode = 0o644; }
    else { actual[1]!.body = Buffer.from('x'); pack[0]!.files[1]!.size = 1; }
    assert.throws(() => verifyPackInventory({ expected: valid, npmPack: pack, tar: tar(actual) }), { code: 'PACK_FILE_MISMATCH' });
  }
});
test('package inventory: npm and tar package identity and bin must match approval', () => {
  const pack = npmPack(); pack[0]!.name = '@synthetic/other';
  assert.throws(() => verifyPackInventory({ expected: valid, npmPack: pack, tar: tar(entries()) }), { code: 'PACK_IDENTITY_MISMATCH' });
  for (const identityChange of [{ name: '@synthetic/other' }, { version: '9.0.0' }, { bin: { other: 'dist/cli.js' } }]) {
    const actual = entries(), approved = structuredClone(valid), listing = npmPack();
    actual[0]!.body = Buffer.from(`${JSON.stringify({ ...identity, ...identityChange })}\n`);
    approved.files[0]!.sha256 = sha256(actual[0]!.body); approved.files[0]!.size = listing[0]!.files[0]!.size = actual[0]!.body.length;
    assert.throws(() => verifyPackInventory({ expected: approved, npmPack: listing, tar: tar(actual) }), { code: 'PACK_IDENTITY_MISMATCH' });
  }
});
test('package inventory: unsafe paths links PAX types and duplicate headers refuse before any bodies return', () => {
  for (const path of ['/absolute', '../parent', 'package/../parent', 'package/a/../../parent', 'package/a\\b',
    'package//x', 'package/./x', 'package/.env', 'package/node_modules/x', 'package/tests/x', 'package/research/x',
    'package/dist/cli.ts', 'package/dist/cli.js.map', 'package/server.json'])
    assert.throws(() => inspectTar(tar([{ path, body: Buffer.from('x') }])), { code: 'TAR_ENTRY_UNSAFE' });
  for (const type of ['1', '2', '3', '4', '5', '6', 'x', 'g', 'L', 'K'])
    assert.throws(() => inspectTar(tar([{ path: 'package/safe', type, body: Buffer.from('x') }])), { code: 'TAR_ENTRY_UNSAFE' });
  assert.throws(() => inspectTar(tar([{ path: 'package/safe', link: '../escape', body: Buffer.from('x') }])), { code: 'TAR_ENTRY_UNSAFE' });
  assert.throws(() => inspectTar(tar([{ path: 'safe', prefix: 'package/..', body: Buffer.from('x') }])), { code: 'TAR_ENTRY_UNSAFE' });
  assert.throws(() => inspectTar(tar([entries()[0]!, entries()[0]!])), { code: 'TAR_ENTRY_UNSAFE' });
  for (const mode of [0o777, 0o4755, 0o664]) assert.throws(() => inspectTar(tar([{ path: 'package/safe', mode, body: Buffer.from('x') }])), { code: 'TAR_ENTRY_UNSAFE' });
  assert.throws(() => inspectTar(tar([{ path: 'package/safe', size: 33_554_433, body: Buffer.alloc(0) }])), { code: 'TAR_ENTRY_UNSAFE' });
});
test('package inventory: malformed truncated checksums numbers padding and terminators fail closed', () => {
  const clean = tar(entries());
  const checksumBad = Buffer.from(clean); checksumBad[0] = 120;
  const numberBad = Buffer.from(clean); numberBad[124] = 0x80; checksum(numberBad.subarray(0, 512));
  const paddingBad = Buffer.from(clean); paddingBad[512 + bodies['package.json']!.length] = 1;
  const trailerBad = Buffer.from(clean); trailerBad[trailerBad.length - 1] = 1;
  for (const bad of [checksumBad, numberBad, paddingBad, trailerBad, clean.subarray(0, clean.length - 512), clean.subarray(0, 777)])
    assert.throws(() => inspectTar(bad), { code: 'TAR_INVALID' });
  assert.throws(() => inspectTar(Buffer.from([0x1f, 0x8b, 0])), { code: 'TAR_LIMIT' });
});
test('package inventory: npm duplicates unsafe boundaries and malformed inventories refuse independently', () => {
  const duplicate = npmPack(); duplicate[0]!.files.push(duplicate[0]!.files[0]!);
  assert.throws(() => inspectNpmPack(duplicate, identity), { code: 'PACK_NPM_INVALID' });
  for (const path of ['../escape', '/absolute', 'a\\b', 'node_modules/x', '.local/x', 'research/x', 'dist/x.ts', 'dist/x.map']) {
    const pack = npmPack(); pack[0]!.files[0]!.path = path;
    assert.throws(() => inspectNpmPack(pack, identity), { code: 'PACK_NPM_INVALID' });
  }
});
