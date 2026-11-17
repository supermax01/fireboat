import { createHash } from 'node:crypto';
import { declaredSearchProfile, type SearchProfile } from '../../core/src/query.js';
import { canonicalJson, evalDataText, fixtureBackendSha256, fixtureSha256, loadEvalCorpus, type GoldenResource } from './fixture.js';
import { parseM3bTaskFile } from './tasks.js';

export type ProfilePinArtifact = 'fixture' | 'backend' | 'tasks';
export interface ProfilePinResult {
  schema: 'eval-profile-pin/1';
  phase: 'profile-preflight';
  profile: string;
  artifact: ProfilePinArtifact;
  recorded: string | null;
  observed: string;
}

/** The query fragment as served, rather than a second independently loaded corpus. */
export function queryFragmentResources(): readonly GoldenResource[] {
  const corpus = loadEvalCorpus();
  return corpus.byCorpus.query!.slice(corpus.byCorpus.baseline!.length);
}

let hashes: Record<ProfilePinArtifact, string> | undefined;
export function fixtureProfileHashes(): Record<ProfilePinArtifact, string> {
  return hashes ??= {
    fixture: fixtureSha256(undefined, undefined, undefined, queryFragmentResources()),
    backend: fixtureBackendSha256(),
    tasks: createHash('sha256').update(canonicalJson(parseM3bTaskFile(evalDataText('data/m3b-query-tasks.json')))).digest('hex'),
  };
}

/** Measurement only: independent of profileDrift's decision to accept or refuse. */
export function fixtureProfilePreflight(profile = declaredSearchProfile('synthetic-fixture-r4-v1')!): ProfilePinResult[] {
  if (profile.source.kind === 'external') return [];
  const observed = fixtureProfileHashes();
  const recorded = { fixture: profile.source.fixture_sha256, backend: profile.source.backend_sha256, tasks: profile.evidence?.tasks_sha256 };
  return (['fixture', 'backend', 'tasks'] as const).map(artifact => ({
    schema: 'eval-profile-pin/1', phase: 'profile-preflight', profile: profile.id,
    artifact, recorded: recorded[artifact] ?? null, observed: observed[artifact],
  }));
}

export function profilePinMessage(artifact: ProfilePinArtifact, recorded: string | undefined, observed: string): string {
  const labels = { fixture: ['fixture_sha256', 'served fixture'], backend: ['backend_sha256', 'executing backend module'], tasks: ['evidence.tasks_sha256', 'query task corpus'] };
  return `${labels[artifact][0]} ${recorded ?? 'unset'} differs from the ${labels[artifact][1]} ${observed}`;
}

export class ProfilePinDriftError extends Error {
  readonly code = 'EVAL_PROFILE_PIN_DRIFT';
  constructor(readonly preflight: ProfilePinResult) { super(JSON.stringify(preflight)); }
}

export function profileRefusal(profile: SearchProfile, drift: string): Error {
  const pin = fixtureProfilePreflight(profile).find(row => row.recorded !== row.observed
    && profilePinMessage(row.artifact, row.recorded ?? undefined, row.observed) === drift);
  return pin ? new ProfilePinDriftError(pin)
    : new Error(`search profile ${profile.id} is stale and cannot prove execution here: ${drift}`);
}
