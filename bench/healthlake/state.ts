// What bench:healthlake created in AWS, and how to delete all of it. The resource manifest
// (RESULTS/healthlake/<dataset>/aws-resources.json, git-ignored: it holds the account's ARNs) is written before every
// create call and after every state change, so `teardown --yes-delete` can delete everything even after a crash.
// The REST load creates no S3 bucket, IAM role or KMS key: a data store is the only kind of resource this tooling
// creates. teardownSteps() refuses a manifest naming any other kind, so nothing is ever left out silently.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RESULTS, type DatasetId } from '../lib/paths.js';
import { writeJsonAtomic } from '../infra/manifest.js';
import { AWS_PROFILE, AWS_REGION } from './aws.js';

export const healthlakeDir = (d: DatasetId) => join(RESULTS, 'healthlake', d);
export const resourcesPath = (d: DatasetId) => join(healthlakeDir(d), 'aws-resources.json');

/** The only datasets this backend holds (synthetic holdout; never MIMIC). */
export const HEALTHLAKE_DATASETS: readonly DatasetId[] = ['synthea-holdout'];

/** Every kind of AWS resource bench:healthlake can create. teardownSteps() must cover each one. */
export const CREATED_KINDS = ['healthlake-datastore'] as const;
export type CreatedKind = (typeof CREATED_KINDS)[number];

export type DatastoreStatus = 'REQUESTED' | 'CREATING' | 'ACTIVE' | 'DELETING' | 'DELETED' | 'CREATE_FAILED' | 'UPDATING' | 'UPDATE_FAILED' | 'NOT_FOUND';

export interface CreatedResource {
  kind: CreatedKind | string;
  name: string;
  client_token: string;
  id: string | null;
  arn: string | null;
  endpoint: string | null;
  status: DatastoreStatus;
  requested_at: string;
  created_at: string | null;
  active_at: string | null;
  delete_requested_at: string | null;
  deleted_at: string | null;
  status_checked_at: string | null;
}

export interface ResourceManifest {
  schema: 'fbbench.healthlake-aws/1';
  dataset: DatasetId;
  region: typeof AWS_REGION;
  profile: typeof AWS_PROFILE;
  resources: CreatedResource[];
  history: { at: string; action: string; detail: string }[];
}

export function emptyManifest(dataset: DatasetId): ResourceManifest {
  return { schema: 'fbbench.healthlake-aws/1', dataset, region: AWS_REGION, profile: AWS_PROFILE, resources: [], history: [] };
}

export function readManifest(dataset: DatasetId): ResourceManifest {
  const p = resourcesPath(dataset);
  if (!existsSync(p)) return emptyManifest(dataset);
  const m = JSON.parse(readFileSync(p, 'utf8')) as ResourceManifest; // our own file
  if (m.schema !== 'fbbench.healthlake-aws/1' || m.dataset !== dataset || m.region !== AWS_REGION) throw new Error(`unexpected ${p}`);
  return m;
}

export async function saveManifest(m: ResourceManifest): Promise<void> {
  mkdirSync(healthlakeDir(m.dataset), { recursive: true });
  await writeJsonAtomic(resourcesPath(m.dataset), m);
}

export const isGone = (r: CreatedResource) => r.status === 'DELETED' || r.status === 'NOT_FOUND';
/** Resources that still cost money or may exist: everything not confirmed deleted. */
export const liveResources = (m: ResourceManifest) => m.resources.filter(r => !isGone(r));

/** The data store the benchmark uses: the single live, ACTIVE one. */
export function activeDatastore(m: ResourceManifest): CreatedResource & { id: string; endpoint: string } {
  const live = liveResources(m).filter(r => r.kind === 'healthlake-datastore');
  if (live.length !== 1) throw new Error(`expected one live data store in ${resourcesPath(m.dataset)}, found ${live.length}${live.length === 0 ? ' (run bench:healthlake -- create --yes-create)' : ''}`);
  const r = live[0]!;
  if (r.status !== 'ACTIVE' || !r.id || !r.endpoint) throw new Error(`data store ${r.id ?? r.name} is ${r.status}, not ACTIVE (bench:healthlake -- status)`);
  return r as CreatedResource & { id: string; endpoint: string };
}

export type TeardownStep =
  | { kind: 'healthlake-datastore'; action: 'delete'; id: string; argv: string[] }
  | { kind: 'healthlake-datastore'; action: 'lookup-then-delete'; name: string; client_token: string };

/**
 * One step per resource not confirmed deleted. A data store whose create call never returned an id is looked up by its
 * unique name first. Throws on a kind this tooling does not know how to delete, so teardown is never partial in silence.
 */
export function teardownSteps(m: ResourceManifest): TeardownStep[] {
  const steps: TeardownStep[] = [];
  for (const r of liveResources(m)) {
    if (!(CREATED_KINDS as readonly string[]).includes(r.kind)) throw new Error(`teardown does not know resource kind ${r.kind} (${r.name}); delete it by hand and fix the tooling`);
    if (r.id) steps.push({ kind: 'healthlake-datastore', action: 'delete', id: r.id, argv: ['healthlake', 'delete-fhir-datastore', '--datastore-id', r.id] });
    else steps.push({ kind: 'healthlake-datastore', action: 'lookup-then-delete', name: r.name, client_token: r.client_token });
  }
  return steps;
}

export const note = (m: ResourceManifest, action: string, detail: string) => { m.history.push({ at: new Date().toISOString(), action, detail }); };
