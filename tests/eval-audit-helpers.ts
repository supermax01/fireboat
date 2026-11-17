import assert from 'node:assert/strict';
import { cpSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export function roundedGatewayCopy(parent: string): string {
  const copy = join(parent, 'rounded-gateway');
  cpSync('packages', join(copy, 'packages'), { recursive: true });
  cpSync('package.json', join(copy, 'package.json'));
  cpSync('scripts/is-main.mjs', join(copy, 'scripts/is-main.mjs'));
  symlinkSync(join(process.cwd(), 'node_modules'), join(copy, 'node_modules'), 'dir');
  const file = join(copy, 'packages/core/src/decimal.ts');
  const source = readFileSync(file, 'utf8');
  const anchor = 'return JSON.stringify(value) === source ? value : new FhirDecimal(source);';
  // A mutation worker may already carry this exact decimal-reader fault.
  if (source.includes(anchor)) writeFileSync(file, source.replace(anchor, 'return value;'));
  return copy;
}

