import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

// A fresh loader substitutes only the profile catalogue, never the selection implementation.
// This is a synthetic positive control for the production closed-profile path, not qualification
// of a shipped profile. It neither registers candidates nor changes the parent process catalogue.
test('S4-F9 production closed-profile selection binds software version and FHIR identity', () => {
  const queryUrl = new URL('../packages/core/src/query.ts', import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import { registerHooks } from 'node:module';
    import { readFileSync } from 'node:fs';
    const hooks = registerHooks({ load(url, context, nextLoad) {
      if (!url.endsWith('/core/src/data/search-profiles.json')) return nextLoad(url, context);
      const catalogue = JSON.parse(readFileSync(new URL(url), 'utf8'));
      const profile = catalogue.profiles.find(p => p.id === 'synthetic-fixture-r4-v1');
      profile.eligible = true;
      // S6: a shipped eligible claiming profile must record the capability revision it was proved on (registry invariant).
      profile.evidence = { report_sha256: 'a'.repeat(64), recorded_at: 'SYNTHETIC TEST ONLY', capability_revision: 'SYNTHETIC-REV' };
      return { format: 'json', source: JSON.stringify(catalogue), shortCircuit: true };
    } });
    const query = await import(${JSON.stringify(queryUrl)});
    const id = 'synthetic-fixture-r4-v1';
    const profile = query.searchProfile(id);
    assert.ok(query.isProvingSearchProfile(profile), 'positive control: closed lookup really proves');
    const bound = { software: profile.source.software, softwareVersion: profile.source.software_version, fhirVersion: profile.source.fhir_version, revision: 'SYNTHETIC-REV' };
    assert.ok(query.isProvingSearchProfile(query.profileForSource(id, bound)), 'exact binding accepted');
    for (const key of ['software', 'softwareVersion', 'fhirVersion', 'revision']) {
      assert.equal(query.profileForSource(id, { ...bound, [key]: 'SYNTHETIC-MISMATCH' }), undefined, key + ' mismatch');
      const missing = { ...bound }; delete missing[key];
      assert.equal(query.profileForSource(id, missing), undefined, key + ' missing');
    }
    hooks.deregister();
  `;
  execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], { encoding: 'utf8', timeout: 15000 });
  assert.ok(true, 'ordinary selection accepted exact identity and refused each missing/mismatched identity');
});
