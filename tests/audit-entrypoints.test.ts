import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isMainModule } from '../scripts/is-main.mjs';

test('F-13: every listed gate executes through a symlinked absolute directory path', t => {
  const dir = mkdtempSync(join(tmpdir(), 'entry-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const link = join(dir, 'repo'); symlinkSync(resolve('.'), link, 'dir');
  // Usage failures and read-only checks: no Docker, approvals, publication or seed generation.
  const cases: [string, string[], number | number[], RegExp][] = [
    ['scripts/mutation-guards.mjs', ['--invalid'], 2, /unknown or repeated option --invalid/],
    ['scripts/emit-m3b-contract.mjs', ['--check'], [0, 1], /emit-m3b-contract: (?:in sync|docs\/contracts\/m3b-tools.json is out of sync)/],
    ['scripts/stage-package.ts', [], 1, /STAGE_USAGE/],
    ['scripts/verify-package.ts', [], 1, /VERIFY_USAGE/],
    ['scripts/release-licenses.mjs', ['--invalid'], 1, /LICENSE_USAGE/],
    ['scripts/check-dist-identity.mjs', [], [0, 1], /check-dist-identity:/],
    ['scripts/package-quickstart.ts', [], 1, /PACKAGE_WORKER_FAILED/],
    ['scripts/qualify-hapi-search-profile.ts', [], 0, /SKIPPED: set FHIR_MCP_HAPI_BASE_URL/],
    ['scripts/quickstart/assemble-helper-manifest.ts', ['--invalid'], 1, /CLI_USAGE/],
    ['scripts/quickstart/edges.ts', [], 1, /quickstart-edges: USAGE/],
    ['scripts/quickstart/transform-synthea.ts', [], 1, /transform-synthea: USAGE/],
    ['scripts/quickstart/check-helper-boundary.ts', [], [0, 1], /check-helper-boundary:/],
    ['scripts/quickstart/generate-synthea.mjs', [], 1, /GENERATION_ARGUMENTS/],
    ['tests/isolation/aggregate.ts', [], 1, /selection-empty/],
  ];
  for (const [script, args, status, message] of cases) {
    const env: NodeJS.ProcessEnv = { ...process.env, B2_CASE_IDS: '', B2_RUN_ID: 'audit-entry-no-run' };
    delete env.FHIR_MCP_HAPI_BASE_URL;
    const result = spawnSync(process.execPath, ['--import', 'tsx', join(link, script), ...args], { env, encoding: 'utf8', timeout: 30_000 });
    assert.ok((Array.isArray(status) ? status : [status]).includes(result.status!), script + '\n' + result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, message, script);
  }
});

test('F-13: entry detection does not execute imports, absent entries or unreadable paths', () => {
  assert.equal(isMainModule(import.meta.url, '/missing-audit-entry'), false);
  assert.equal(isMainModule(import.meta.url, resolve('scripts/is-main.mjs')), false);
});
