import assert from 'node:assert/strict';
import type { GatewayConfig } from '../packages/core/src/index.js';
import { declaredSearchProfile } from '../packages/core/src/query.js';
import { EVAL_PATIENT_ID, EVAL_SOURCE_ALIAS } from '../packages/evals/src/fixture.js';
import { HAPI_BASE_URL, HAPI_IMAGE_DIGEST, externalCorpus, externalTaskHash } from '../packages/evals/src/external.js';

export const HAPI_PROFILE = 'hapi-r4-labs-v1';
export const HAPI_RECORDED_EVIDENCE = {
  report_sha256: 'f9f95bde48dd2d29716b89089a54779fb8d4700dbb04e30cfcbfda293996d51e',
  recorded_at: '2026-10-23T21:20:40.922Z',
  capability_revision: '0835b8480514fb73',
  tasks_sha256: '8a649af6fda16c203f6e9bb62fcdf3cc7c9236655f1feb98bb0ff236dbf771ff',
};
export const HAPI_WINDOW_PARAMS = [
  { name: 'code', value: 'http://loinc.org|4548-4' },
  { name: 'date', value: 'ge2020-01-01' },
  { name: 'date', value: 'lt2026-01-01' },
];

export function assertHapiProfilePins(): void {
  const profile = declaredSearchProfile(HAPI_PROFILE)!;
  assert.equal(profile.eligible, true);
  assert.deepEqual(profile.evidence, HAPI_RECORDED_EVIDENCE);
  assert.deepEqual(profile.source, {
    kind: 'external', software: 'HAPI FHIR Server', software_version: '8.12.0', fhir_version: '4.0.1',
    image_digest: 'sha256:0ff86aac4c7bd13a1ee226444a70263bb46ed1c28ef543c30a44f865b80ca04e',
    corpus_sha256: 'bbd21aa1ede24de3c3cd59f8db5991e11b343b31f3700a6bdae3bf3e916e1404',
  });
  assert.equal(profile.source.image_digest, HAPI_IMAGE_DIGEST);
  assert.equal(profile.source.corpus_sha256, externalCorpus().sha256);
  assert.equal(profile.evidence!.tasks_sha256, externalTaskHash());
  assert.deepEqual(profile.testedFilters, [
    { resource_type: 'Observation', parameter: 'code', variant: 'token-system-code', test_ids: ['hapi-code-membership', 'hapi-code-date-window'] },
    { resource_type: 'Observation', parameter: 'date', variant: 'effective-interval-ge-lt', test_ids: ['hapi-code-date-window', 'hapi-date-lower-discrimination', 'hapi-date-upper-discrimination'] },
  ]);
  assert.deepEqual(profile.testIds, ['hapi-code-membership', 'hapi-code-date-window', 'hapi-date-lower-discrimination', 'hapi-date-upper-discrimination']);
  assert.deepEqual(profile.testedSorts, []);
  assert.deepEqual(profile.testedContinuations, []);
}

export function publicHapiConfig(baseUrl: string): GatewayConfig {
  return { mode: 'synthetic', source: { alias: EVAL_SOURCE_ALIAS, baseUrl, searchProfile: HAPI_PROFILE }, patientId: EVAL_PATIENT_ID, contextId: 'gbackend-public-profile' };
}

/** Call before constructing any network client. An unset variable is the only skipped case. */
export function hapiIntegrationBaseUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value !== HAPI_BASE_URL) throw new Error('FHIR_MCP_HAPI_BASE_URL must equal http://127.0.0.1:18091/fhir exactly.');
  return value;
}
