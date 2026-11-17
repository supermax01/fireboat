import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { DEV_SEED_HEX, jcsStringArray, rankHash, sha256Hex } from '../lib/hash.js';
import { LosslessNumber, parseLossless, parseNumbersAsStrings, stringifyLossless } from '../lib/json.js';
import { appendJsonl, completeLines, readJsonl, repairPartialTail } from '../lib/jsonl.js';
import { HAPI_BASE, proxyBase, slotPorts, tmpDir } from '../lib/paths.js';

const ADVERSARIAL = '{"a":12.3400,"b":[1e-3,9007199254740993,-0.0,0.10000000000000000001],"c":"7.0","d":true,"e":null}';

test('parseLossless keeps every number lexeme and round-trips compact JSON byte for byte', () => {
  const v = parseLossless(ADVERSARIAL) as Record<string, unknown>;
  assert.ok(v.a instanceof LosslessNumber);
  assert.equal((v.a as LosslessNumber).lexeme, '12.3400');
  assert.deepEqual((v.b as LosslessNumber[]).map(n => n.lexeme), ['1e-3', '9007199254740993', '-0.0', '0.10000000000000000001']);
  assert.equal(stringifyLossless(v), ADVERSARIAL);
  assert.equal(stringifyLossless(parseLossless('{ "x" : [ 1.50 ] }')), '{"x":[1.50]}');
});

test('parseNumbersAsStrings matches Python parse_float=str, parse_int=str', () => {
  assert.deepEqual(parseNumbersAsStrings(ADVERSARIAL), {
    a: '12.3400', b: ['1e-3', '9007199254740993', '-0.0', '0.10000000000000000001'], c: '7.0', d: true, e: null,
  });
});

test('jsonl append and read keep lexemes', async () => {
  await mkdir(tmpDir('bench-tests'), { recursive: true });
  const dir = await mkdtemp(join(tmpDir('bench-tests'), 'jsonl-'));
  try {
    const path = join(dir, 'x.jsonl');
    await appendJsonl(path, [parseLossless(ADVERSARIAL), { s: 'é' }]);
    assert.equal(await readFile(path, 'utf8'), `${ADVERSARIAL}\n{"s":"é"}\n`);
    const back = [];
    for await (const r of readJsonl(path)) back.push(stringifyLossless(r));
    assert.deepEqual(back, [ADVERSARIAL, '{"s":"é"}']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('rank hash follows the canonical rule and separates field boundaries', () => {
  assert.equal(jcsStringArray(['a', 'b"c']), '["a","b\\"c"]');
  const h = rankHash('saq', DEV_SEED_HEX, 'L1', 'k');
  assert.equal(h, sha256Hex(`["fbbench/1.1","saq","${DEV_SEED_HEX}","L1","k"]`));
  assert.notEqual(rankHash('saq', DEV_SEED_HEX, 'T1', '2c22'), rankHash('saq', DEV_SEED_HEX, 'T12', 'c22'));
  assert.throws(() => rankHash('saq', 'xyz', 'L1', 'k'));
  assert.throws(() => jcsStringArray(['\ud800']));
});

test('ports and endpoints are the contract values', () => {
  assert.equal(HAPI_BASE, 'http://127.0.0.1:18190/fhir');
  assert.deepEqual(slotPorts(3), { recordingProxy: 18213, canary: 18223, tokenShim: 18233, scopeProxy: 18243, healthlakeProxy: 18253, signingProxy: 18273 });
  // No two slot ports collide (the fuzz mock owns 1826s), and none is a reserved port.
  const all = [0, 1, 2, 3, 4, 5, 6, 7].flatMap(s => [...Object.values(slotPorts(s)), 18260 + s]);
  assert.equal(new Set(all).size, all.length);
  for (const reserved of [8080, 18080, 18091, 18190, 18195]) assert.ok(!all.includes(reserved));
  assert.equal(proxyBase(0), 'http://127.0.0.1:18210/fhir');
  assert.throws(() => slotPorts(8));
});

test('a partial last line is moved aside, never continued by the next append and never read', async () => {
  const dir = tmpDir('test-jsonl-partial');
  await mkdir(dir, { recursive: true });
  try {
    const p = join(dir, 'r.jsonl');
    await appendJsonl(p, [{ run_id: 'a' }]);
    await appendFile(p, '{"run_id":"b","calls":[{"x":'); // killed mid-append
    assert.deepEqual(completeLines(await readFile(p, 'utf8')), ['{"run_id":"a"}']);
    await appendJsonl(p, [{ run_id: 'c' }]);
    const back: unknown[] = [];
    for await (const r of readJsonl(p)) back.push(r);
    assert.deepEqual(back, [{ run_id: 'a' }, { run_id: 'c' }]);
    const aside = (await readdir(dir)).filter(f => f.includes('.partial-'));
    assert.equal(aside.length, 1);
    assert.equal(await readFile(join(dir, aside[0]!), 'utf8'), '{"run_id":"b","calls":[{"x":');
    assert.equal(repairPartialTail(p), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
