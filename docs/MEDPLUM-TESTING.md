# Authenticated synthetic Medplum integration

> **Updated for M3a.** The current script also seeds three same-patient decoys, each excluded by exactly one code or date predicate, and reads each decoy directly as a positive control. The linked M2 run predates those assertions; the updated scenario must pass the pinned Medplum CI job at the new revision before it is claimed.


This repository includes an isolated self-hosted Medplum R4 stack. Medplum, PostgreSQL and Redis images are pinned by immutable multi-platform digests in [compose.medplum.yaml](../compose.medplum.yaml). Only Medplum is exposed to the host, on `127.0.0.1:18103`. PostgreSQL and Redis have no published host ports.

With Docker and Node 24 available:

```sh
npm ci
docker compose -f compose.medplum.yaml up -d
npm run test:medplum
docker compose -f compose.medplum.yaml down --volumes
```

The integration script waits up to four minutes for startup and base-schema seeding. Using intentionally public bootstrap fixture credentials, it creates a disposable ordinary project and a separate client application, then seeds two synthetic patients, observations and an attachment. The gateway receives only the ordinary project client's credentials through a temporary environment variable; the bootstrap token is never configured in the gateway. The script checks that unauthenticated reads fail, the ordinary client can read its project's resources, repeated date filters and paging work, the configured patient's observations are returned, another patient's read is denied, and attachment content or protected storage links are withheld. It restores the environment and closes the gateway on completion. Teardown removes the database volume and test resources.

The `medplum-r4` CI job runs the same commands on an Ubuntu runner. [The source revision and passing run](M2-STATUS.md) record three pages, three authorized observations, authentication and denial/withholding checks. Inspect the job at the exact commit being evaluated; a local unit test or a prior run does not establish integration success for changed code.

## Optional MCP host configuration

[examples/medplum.config.json](../examples/medplum.config.json) is a template. Replace the client and patient placeholders with an independently provisioned synthetic project client and synthetic patient on your local instance. Supply that client's secret through `FHIR_MCP_MEDPLUM_CLIENT_SECRET` in the MCP process environment. Do not put secrets in the JSON configuration or tool arguments. The automated test's generated client credentials are deliberately not printed or exported for reuse.

Check the edited configuration before connecting an MCP host:

```sh
npm run build
node dist/packages/server/src/cli.js --doctor --config examples/medplum.config.json
```

The gateway still confines both FHIR and token endpoints to literal loopback addresses and one trusted patient. This outbound OAuth `client_credentials` adapter is distinct from SMART user launch/PKCE, SMART private-key backend services, inbound MCP authorization, or a production permission policy. It does not turn the project's broad client membership into a production read-only credential. The gateway exposes only read tools and adds patient confinement; a future production deployment also needs an appropriate backend access policy.

All Compose credentials are public synthetic fixtures. Use this stack only for the disposable integration tests described here. It is not a deployment template for patient data.
