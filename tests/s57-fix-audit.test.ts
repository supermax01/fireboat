import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('S57fix S57-R06 comparison records every reviewed difference and its authority', () => {
  const report = readFileSync('docs/evidence/s5-eval-comparison.md', 'utf8');
  for (const letter of 'abcdefgh') {
    const rows = report.split('\n').filter(row => row.startsWith(`| S57-R06(${letter}):`));
    assert.equal(rows.length, 1, `one disposition for reviewed difference ${letter}`);
    const cells = rows[0]!.split('|');
    assert.match(cells[2]!, /M3b|Root|root review/);
    assert.ok(cells[3]!.trim().length > 20, 'a source-backed disposition, not an empty authority cell');
  }
  assert.match(report, /No authority for that expectation change/);
  assert.match(report, /No authority for the input change/);
});
