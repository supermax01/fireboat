import { execFileSync } from 'node:child_process';

/** Fresh-process JSON substitution only: production lookup/config, no on-disk registry mutation. */
export function assertIneligibleCatalogueSelectionRefused(): void {
  const coreUrl = new URL('../packages/core/src/index.ts', import.meta.url).href;
  const queryUrl = new URL('../packages/core/src/query.ts', import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import { registerHooks } from 'node:module';
    import { readFileSync } from 'node:fs';
    const id = 'test-ineligible-hapi-r4';
    const hooks = registerHooks({ load(url, context, nextLoad) {
      if (!url.endsWith('/core/src/data/search-profiles.json')) return nextLoad(url, context);
      const catalogue = JSON.parse(readFileSync(new URL(url), 'utf8'));
      const qualified = catalogue.profiles.find(profile => profile.id === 'hapi-r4-labs-v1');
      catalogue.profiles.push({ ...qualified, id, eligible: false });
      catalogue.profiles.push({ ...qualified, id: id + '-unevidenced', eligible: false, evidence: null });
      return { format: 'json', source: JSON.stringify(catalogue), shortCircuit: true };
    } });
    const query = await import(${JSON.stringify(queryUrl)});
    const { FhirGateway } = await import(${JSON.stringify(coreUrl)});
    const config = searchProfile => ({ mode: 'synthetic', source: { alias: 'local', baseUrl: 'http://127.0.0.1:9/fhir', searchProfile }, patientId: 'synthetic-p', contextId: 'ctx-ineligible-catalogue' });
    assert.deepEqual(query.eligibleSearchProfileIds(), ['generic-r4', 'hapi-r4-labs-v1', 'synthetic-fixture-r4-v1']);
    assert.deepEqual(query.declaredSearchProfile(id).evidence, query.declaredSearchProfile('hapi-r4-labs-v1').evidence, 'eligibility alone differs despite valid recorded evidence');
    for (const ineligible of [id, id + '-unevidenced']) {
      assert.equal(query.declaredSearchProfile(ineligible).eligible, false, 'negative control is actually declared');
      assert.equal(query.searchProfile(ineligible), undefined, 'declared ineligible profile has no public proof');
      assert.throws(() => new FhirGateway(config(ineligible)), { code: 'INVALID_CONFIG' });
    }
    for (const eligible of query.eligibleSearchProfileIds()) new FhirGateway(config(eligible)).close();
    hooks.deregister();
  `;
  execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], { encoding: 'utf8', timeout: 15000 });
}
