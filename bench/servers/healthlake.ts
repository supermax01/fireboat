// HealthLake arms (synthea-holdout only; the data store is made and deleted with bench:healthlake):
//   FBh   fireboat at FB_COMMIT (servers/arms.ts; HEAD of this checkout by default) with FB's operator configuration, against the data store through
//         recording proxy (1825s) -> loopback SigV4 signing proxy (1827s, bench/healthlake/proxy.ts) -> HealthLake.
//   FBdh  the same with fireboat's default privacy configuration (as FBd).
//   AH    the AWS HealthLake MCP server 0.0.21 (awslabs.healthlake-mcp-server, wheel sha256-pinned) with --readonly.
//         It signs its own requests and connects only to healthlake.us-east-2.amazonaws.com (its host is not
//         configurable), so it runs outside the loopback egress sandbox and outside the recording proxy: its upstream
//         requests are not in the proxy log. Its credentials come from the local AWS CLI: a per-run AWS config file names
//         profile `fireboat` with credential_process = `aws configure export-credentials --profile fireboat --format process`
//         (no key is ever written; boto3 runs the CLI and refreshes). Writes are never sent to AH (no blocking proxy
//         stands between it and AWS): its probe adapter refuses every write, and --readonly lists none.
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { slotPorts, type DatasetId } from '../lib/paths.js';
import type { ArmId } from '../lib/types.js';
import { AWS_PROFILE, AWS_REGION, awsBin } from '../healthlake/aws.js';
import { HEALTHLAKE_DATASETS, activeDatastore, readManifest } from '../healthlake/state.js';

export const HEALTHLAKE_ARMS: readonly ArmId[] = ['FBh', 'FBdh', 'AH'];
export const isHealthLakeArm = (arm: ArmId): boolean => HEALTHLAKE_ARMS.includes(arm);
/** Arms that connect to AWS themselves (no egress sandbox, no recording proxy). */
export const AWS_DIRECT_ARMS: readonly ArmId[] = ['AH'];
export const isAwsDirectArm = (arm: ArmId): boolean => AWS_DIRECT_ARMS.includes(arm);
export const isHealthLakeDataset = (d: DatasetId): boolean => HEALTHLAKE_DATASETS.includes(d);

/** What the fireboat arms are configured with: the slot's recording proxy, whose upstream is the signing proxy. */
export const healthlakeProxyPort = (slot: number) => slotPorts(slot).healthlakeProxy;
export const healthlakeProxyBase = (slot: number) => `http://127.0.0.1:${healthlakeProxyPort(slot)}/fhir`;
export const signingProxyPort = (slot: number) => slotPorts(slot).signingProxy;

/** The live data store's id for a dataset (AH passes it as datastore_id). Throws when none is ACTIVE in the manifest. */
export const datastoreIdFor = (d: DatasetId): string => activeDatastore(readManifest(d)).id;

/** AH's AWS config: profile fireboat whose credentials come from the local AWS CLI. No credential is written. */
export function ahAwsConfig(aws = awsBin(), home = homedir()): string {
  for (const p of [aws, home]) if (/[\s"'\\]/.test(p)) throw new Error(`path with whitespace or quotes cannot go into credential_process: ${p}`);
  const path = [dirname(aws), '/usr/bin', '/bin'].join(':');
  return [
    `[profile ${AWS_PROFILE}]`,
    `region = ${AWS_REGION}`,
    `credential_process = /usr/bin/env -i HOME=${home} PATH=${path} LANG=C.UTF-8 ${aws} configure export-credentials --profile ${AWS_PROFILE} --format process`,
    '',
  ].join('\n');
}

export const AH_CONFIG_FILE = 'aws/config';

/** AH's environment beyond the base (PATH, HOME=runDir, LANG, TMPDIR): profile, region and the per-run config only. */
export function ahEnv(runDir: string): Record<string, string> {
  return {
    AWS_PROFILE,
    AWS_REGION,
    AWS_DEFAULT_REGION: AWS_REGION,
    AWS_CONFIG_FILE: join(runDir, AH_CONFIG_FILE),
    AWS_SHARED_CREDENTIALS_FILE: join(runDir, 'aws/credentials-none'), // never created: no static keys anywhere
    AWS_EC2_METADATA_DISABLED: 'true',
    MCP_LOG_LEVEL: 'WARNING',
  };
}
