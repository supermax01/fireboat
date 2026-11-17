// Guard: the repository is public. No tracked file may contain an AWS access-key-id-shaped literal or a long
// secret-looking AWS example value, even a fake one, so secret scanners never flag the repository. Tests that need
// such shapes build them at run time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const keyId = new RegExp(['(?:AK', '|AS)IA[A-Z0-9]{16}'].join(''));
const sessionToken = new RegExp(['IQoJb3', 'JpZ2lu|Fwo', 'GZXIvYXdz'].join('')); // split so this file does not match itself

test('no tracked file contains an AWS key-id-shaped literal or an STS session token prefix', () => {
  const files = execFileSync('git', ['ls-files'], { cwd: repo, encoding: 'utf8' }).split('\n').filter(Boolean);
  const hits: string[] = [];
  for (const f of files) {
    let text: string;
    try { text = readFileSync(join(repo, f), 'utf8'); } catch { continue; }
    if (keyId.test(text) || sessionToken.test(text)) hits.push(f);
  }
  assert.deepEqual(hits, []);
});
