# Synthetic quickstart

This guide runs the `@fireboat/gateway` prototype (CLI `fireboat`) against a disposable, helper-owned HAPI FHIR server. The `fireboat-quickstart` helper prepares the checked-in synthetic Synthea seed and labelled edge fixtures, verifies scripted retrieval tasks, generates host registration forms and cleans up its instance. The gateway serves locally over MCP stdio and exposes read-only tools. Only the separate helper seeds its own fresh HAPI, using manifest-listed fixed-ID PUTs.

Use synthetic data only. This is not a production release and makes no SMART authorization, clinical deployment readiness, vendor support or general protocol compatibility claim. The verification tasks use a scripted oracle, with no model or clinical reasoning assessment. A pass demonstrates the checked retrieval behavior for that run; it says nothing about clinical reasoning or an untested host, runtime or backend.

## Prerequisites and the pinned image

- Node **24.22.0** is the recorded checkout cell and the version in `.nvmrc`. Both package manifests declare `engines.node` as `>=24`; that declaration is not evidence that every admitted runtime/platform cell passed. Use the recorded version for this recipe, with npm available.
- A reachable **local** Docker daemon, `docker` on an absolute directory in `PATH`, and **Docker Compose v2** (`docker compose`). The helper also uses `docker image inspect --platform` and `docker context inspect`. The effective endpoint (DOCKER_HOST, else DOCKER_CONTEXT, else the saved current context) must be a local `unix:///…` socket; a tcp, ssh or other remote endpoint refuses before provisioning, because its published port is on another host.
- The pinned HAPI recipe supports **linux/arm64 only today**. Other image/platform cells are unverified.
- **127.0.0.1:18080 must be free.** The exact Compose binding is `127.0.0.1:18080:8080`; the manifest target is `http://127.0.0.1:18080/fhir`. Before starting HAPI, prepare probes that address and refuses if anything accepts a connection there, so it never adopts or seeds a server already listening. A listener that appears between that probe and Compose's port binding is not detected.
- A writable local parent directory for new run directories. Use Bash or zsh for the shell examples, replacing the absolute checkout placeholder below.

Acquire the pinned image explicitly if it is not already cached:

```sh
docker pull --platform linux/arm64 hapiproject/hapi@sha256:0ff86aac4c7bd13a1ee226444a70263bb46ed1c28ef543c30a44f865b80ca04e
```

The helper never pulls or builds an image: Compose uses `--pull never`, and image/container inspection checks the pinned identities. Do not substitute a moving tag. This recipe uses HAPI 8.12.0 / FHIR R4 4.0.1 and an in-memory H2 database, with no mounts and Docker logging disabled. Stopping/removing the container discards its data.

## Build and select absolute paths

From the checkout, install its locked dependencies and build:

```sh
cd /ABSOLUTE/PATH/TO/fireboat
npm ci
npm run build
QUICKSTART_CHECKOUT="$(pwd -P)"
QUICKSTART_NODE="$(node -p 'process.execPath')"
QUICKSTART_CLI="$QUICKSTART_CHECKOUT/dist/packages/server/src/cli.js"
QUICKSTART_CONFIG="$QUICKSTART_CHECKOUT/examples/quickstart/config.json"
fireboat-quickstart() {
  "$QUICKSTART_NODE" "$QUICKSTART_CHECKOUT/dist/examples/quickstart/main.js" "$@"
}
mkdir -p "$QUICKSTART_CHECKOUT/.local/quickstart-runs"
QUICKSTART_RUN="$QUICKSTART_CHECKOUT/.local/quickstart-runs/run-001"
```

The shell function invokes the compiled helper. The compiled gateway CLI is the target of the `fireboat` bin. The separately installed, nested helper project comes with release staging; this checkout recipe does not assert that a packaged installation has been verified or that a public helper package is available.

## Install a reviewed candidate tar and its separate helper

There is no published-package assumption in this path. Use the reviewed tar, its npm pack JSON, inventory, helper lock and dependency-free `fireboat-timing.mjs` supplied beside the tar. Before installing, verify the tar with `npm run verify:package -- --tar /ABSOLUTE/candidate.tgz --pack-json /ABSOLUTE/candidate.tgz.pack.json`. The maintainer stages and packs the candidate after the checked build; each changed packaged byte requires a refreshed inventory and a new tar.

The gateway tar includes helper material under `quickstart/`, with its own manifest and lock. Create and enter a **new gateway installation directory**, then run `npm install --offline --omit=dev --ignore-scripts --no-audit --no-fund --bin-links=false /ABSOLUTE/candidate.tgz`. Copy its complete `node_modules/@fireboat/gateway/quickstart/` subtree to a **different new helper directory**, compare its lock with the supplied helper lock, then enter that helper directory and run `npm ci --offline --omit=dev --ignore-scripts --no-audit --no-fund --bin-links=false`. Offline mode requires the pinned dependencies already in npm's cache; failure does not authorize a download. Do not install the helper dependencies into the gateway tree.

Select absolute paths from these two installations, then run the same prepare/configs/verify/down commands below from an unrelated directory:

```sh
QUICKSTART_NODE="$(node -p 'process.execPath')"
QUICKSTART_GATEWAY=/ABSOLUTE/NEW/gateway/node_modules/@fireboat/gateway
QUICKSTART_HELPER=/ABSOLUTE/NEW/helper
QUICKSTART_CLI="$QUICKSTART_GATEWAY/dist/packages/server/src/cli.js"
QUICKSTART_CONFIG="$QUICKSTART_HELPER/examples/quickstart/config.json"
QUICKSTART_RUN=/ABSOLUTE/NEW/run-001
fireboat-quickstart() {
  "$QUICKSTART_NODE" "$QUICKSTART_HELPER/dist/examples/quickstart/main.js" "$@"
}
unset NODE_PATH NODE_OPTIONS
cd /ABSOLUTE/UNRELATED/directory
"$QUICKSTART_NODE" "$QUICKSTART_CLI" --version
```

These are the installed bin targets; no npm bin symlink, source checkout, tsx or ambient Node loader is needed. Make the run's parent directory first. For a packaged reset, choose another new absolute run path instead of the checkout-based reset path later in this guide.

The explicit maintainer integration command is `npm run test:package-installed`. It requires absolute environment inputs:

| Variable | Required input |
| --- | --- |
| FIREBOAT_PACKAGE_TAR | Actual packed candidate tar. |
| FIREBOAT_PACKAGE_PACK_JSON | Its npm pack JSON; defaults to the tar path plus `.pack.json`. |
| FIREBOAT_PACKAGE_HELPER_LOCK | Reviewed helper lock; must equal the lock inside the tar. |
| FIREBOAT_PACKAGE_RUN_DIR | A completed prepare run on the helper-owned HAPI at the pinned target, with private receipt, attempt and setup packet. |
| FIREBOAT_PACKAGE_SCRATCH | A nonexistent absolute directory outside the checkout; the harness creates and preserves it. |
| FIREBOAT_PACKAGE_TIMING | Standalone timing wrapper available before either install; must equal the tar's copy. |
| FIREBOAT_PACKAGE_CACHE | Optional cache source, default `~/.npm`; its content cache is copied into scratch before offline installs. |
| FIREBOAT_PACKAGE_EXPECTED | Optional inventory path, default the checkout's reviewed `packaging/npm-files.json`. |

Run through npm so it supplies its absolute npm CLI path. Absent inputs fail with zero skips. The command reads the supplied tar once into a private snapshot in the scratch directory, verifies/extracts that snapshot and installs the gateway from it, creates independent fresh gateway/helper trees, verifies both installed dependency graphs, and invokes the installed helper's verify with the installed gateway. Before success it compares every installed gateway file's path, mode, size and hash with the verified inventory and requires npm's recorded install integrity to be the snapshot's SHA-512, so a tar replaced at the supplied path during the run cannot be attributed to the verified hash. It requires exactly the three tasks across both eras and all three arms (18 task-arm runs), including the clean/observed controls. Runtime refusal, missing/altered assets and import failure, stdout framing, EOF/signals and era mismatch, private seam refusal, and helper usage/missing-run/missing-asset negatives are separate guard results. Passing those guards cannot certify onboarding when a task fails. The drain's existing `labs-exact-membership` check uses the common `resourceIdSet` oracle to reject missing, extra or duplicated identities across pages.

The standalone wrapper starts before installation and records `prerequisites`, `gateway-install`, `helper-install`, `configuration`, `startup`, `doctor`, `verification` and `cleanup` on one monotonic clock. These startup/cleanup stages measure gateway-child probes and harness cleanup. **The supplied run's earlier HAPI startup, seeding and later HAPI cleanup are unverified by this command.** Keep their separate prerequisite/cold-acquisition measurements; use the same standalone wrapper around prepare (which includes startup/seeding) and down when collecting those stages. It does not infer a ten-minute or unaided-human result. Stage failures remain in the timing packet; they do not turn later stages into a green skip. Private results remain in the supplied scratch directory and the helper's verification directory. The integration harness preserves the HAPI and prepared run for ownership-aware cleanup with the installed helper.

On 2026-10-24, the slice's offline macOS arm64 / Node 24.22.0 / npm 11.19.1 rehearsal packed and independently verified a scratch stage, installed the real tar and helper lock into separate fresh directories, and verified both installed dependency graphs. The installed CLI version, host-form generation, helper usage/missing-run/missing-asset paths and all six guard groups passed. The installed helper's verifier and SDK client passed all 18 task-arm runs and both clean/observed controls against the existing e2e test's seed-backed stub on an ephemeral loopback port. That rehearsal injected the stub target through the verifier's test adapter; the public helper CLI and explicit integration command have no target override. The installed integration command's absent-input case exited 1 with zero skips.

| Cell or claim | This slice's evidence |
| --- | --- |
| macOS arm64, Node 24.22.0, cached installs and seed-backed stub | Offline rehearsal passed as described above. |
| macOS arm64, Node 24.22.0, public installed helper verify on helper-owned HAPI | Passed 2026-10-25: `PACKAGE_INSTALLED_OK runs=18 guards=6`, last on tree `31aa6a2` with tar `415d0a2f…9a21` ([evidence](evidence/live-quickstart-installed-s10-2026-10-25.md)). |
| Linux x64 or arm64, Node 24.22.0 | **Unverified**; no Linux execution or container run in this slice. |
| Node 24.21.0 or 26.10.0 on any platform | **Unverified**; simulated runtime/feature refusals do not test these actual runtimes. |
| Cold acquisition, HAPI startup/seeding/cleanup timing, unaided human or ten-minute onboarding | **Unverified**. |

The checked-in [operator config](../examples/quickstart/config.json) selects synthetic mode, the manifest's exact target and its one natural Patient. It leaves gateway output and limits at their defaults. Do not use `examples/hapi.config.json` for this seed: its patient context differs. The [host example](../examples/quickstart/host-config.example.json) contains deliberately unusable absolute placeholders; generate forms for your actual paths below.

## Prepare once

The run directory must not exist; its parent must exist. All helper path flags require absolute paths. There is no public `up` command: prepare includes startup.

```sh
fireboat-quickstart prepare --run-dir "$QUICKSTART_RUN"
```

Prepare validates the manifest, Compose bytes and listed seed bodies, creates a private receipt and unique Compose project, refuses an occupied 127.0.0.1:18080 or a non-local Docker endpoint, then starts only its HAPI service. It checks container ownership and port association, pinned backend identity and metadata, and empty counts for Patient, Observation and every seeded resource type before any PUT. It records the seed attempt before writing, rechecks the instance before seeding, then reads back the listed resources and counts through a separate setup oracle. Every helper GET sends `Cache-Control: no-cache`, so HAPI's reuse of cached identical searches (60 seconds by default) cannot answer the oracle's counts with the pre-seed zeros. The oracle compares approved stored values, numeric lexemes and references, and records the observed versions. Only a completed check produces the setup packet and complete receipt.

The success line has exactly this field order (hashes are lowercase SHA-256 hex):

```text
PREPARE_OK resources=<count> types=<count> manifest=<sha256> receipt=<sha256> packet=<sha256>
```

A partial, failed or completed run is never reseeded. Keep a failed run for diagnosis and cleanup; use the reset procedure below.

## Verify the scripted tasks

```sh
fireboat-quickstart verify --run-dir "$QUICKSTART_RUN" --node "$QUICKSTART_NODE" --cli "$QUICKSTART_CLI" --config "$QUICKSTART_CONFIG"
```

Verify parses `attempt.json` as a closed receipt in phase `seeding`, with null attempt/packet hashes, otherwise identical to the complete receipt. Manifest, receipt and instance Compose hashes must agree. Every packet numeric inventory must equal the approved body's inventory, in pointer order and exact lexemes; empty, invented, duplicate or reordered inventories refuse. Server-owned root `meta.versionId`, `meta.lastUpdated` and `meta.source` may change during setup; their permitted string values add no numeric inventory. Stored response hashes remain setup observations, not a substitute for the setup oracle's body comparison.

The operator config must name synthetic mode, this target and the natural patient. Verify validates the admitted config fields and limits and requires the default `full-text-v1` delivery profile. It takes the exclusive `verify.lock` for this run and creates a fresh `verify-<unique>/` directory (0700) for every invocation. The base snapshot serves the gateway's metadata-only `--doctor` and ordinary task sessions; the TTL and control sessions have separate derived snapshots. Doctor must exit successfully with `doctor: ready` and the expected gateway/runtime/source identity lines before tasks run.

The report binds the CLI file and its installed package artifact: sorted file/hash rows over the package's `dist/` runtime tree, root JavaScript/JSON/runtime metadata files, and installed production dependencies. Source test launches bind `packages/` instead of `dist/`. Reads are bounded to 8,192 rows, 8 MiB per file and 64 MiB total, with interior symlinks refused. The artifact is hashed before doctor and after the last session; a change refuses verification. This detects local launch drift during that interval and does not authenticate files against an operator who can rewrite the code and evidence.

The three tasks run in each of the `fhir`, `compact` and `selected` arms in both `modern` and `legacy` protocol eras: **3 tasks × 3 arms × 2 eras = 18 task-arm runs**, comprising only three independent tasks.

| Scripted task | What is checked |
| --- | --- |
| `package-latest-hba1c` | Support and typed code/date discovery; system-qualified HbA1c code, explicit date window and requested descending clinical-date sort; exact seeded membership and cited values, units, comparators, dates, statuses, coding and observed versions. Ordering remains explicitly unverified when the adapter has not verified it. |
| `package-status-sensitive` | Corrected and entered-in-error lab meaning/citations; uniform unavailable responses for wrong-patient and absent controls; document metadata with its inline payload withheld and omissions reported. |
| `package-drain-reproject` | Exact lab membership while draining; request-observer counts showing local remainder before upstream continuation; retained inspect/project/page views, omitted fields, partial coverage, slices and expected expiry under a derived task config. |

Before task predicates, an independent helper validator checks each actual tool/input/action against schema 0.3, the bound source alias, manifest backend FHIR version, patient-bound context mode and any configured context handle. The two requested metadata shapes, SDK server-identity metadata, repair controls and omission manifests are closed so misplaced resource bodies cannot bypass provenance. Every delivered resource needs distinct, complete, valid indexed provenance; pagination/counts must match the tool and requested page size, and includes stay zero. Errors carry no resource bodies and use the gateway's fixed safe messages. Full-text delivery has exactly one text block whose text equals the raw `structuredContent` JSON member, including numeric spellings; contradictory visible text fails even when decoded structured facts are correct. Raw/decoded agreement, measured bytes, identity consistency, query-chain resolution and exact expected outcomes remain independent guards.

The effective per-call ceiling is `min(output.max_bytes, limits.maxBytes)`, with the gateway defaults when omitted ([core allowance](../packages/core/src/index.ts#L628), defaults at lines 312–313). The measured result must fit, and reported `budget.byte_limit` must equal that trusted ceiling. An admitted operator ceiling of 32,768 bytes is supported even for the drain's 65,536-byte request. Retained reads use the first response's handle. Checks bind slice identity/order, omission indexes and details, offsets, project/page controls and pagination to that issuing response; project/page provenance must preserve its retrieval timestamps, and compared fields must retain their raw numeric tokens. Both typed parameter-discovery responses must name `Observation` and the requested row.

For each era, one additional clean gateway session runs without the request-observer preload and one observed control session makes the same support-discovery call. A shared explicit control context avoids unrelated random handles. Their validated structured results are compared with the envelope request ID and discovery timestamps removed and elapsed timing normalized. The original byte accounting is checked against each raw result, then recomputed for the normalized full-text result so differing timestamp/timing widths do not cause a false difference. Other structured fields are compared. A difference fails the task runs and is recorded in `controls`. These four control sessions are separate from the 18 task-arm runs. The helper's SDK client retrieves all evidence through gateway stdio; the observer counts work in instrumented gateway children. No model call is involved.

The report can pass while carrying these limitations:

| Limitation | Meaning |
| --- | --- |
| `LATEST_UNVERIFIED` | The requested sort was not reported as verified by the adapter. Matching seeded facts or apparently descending dates do not prove the latest result. |
| `FILTER_UNVERIFIED` | Gateway coverage reports unverified filter execution. Matching the scripted expected set does not establish that the backend executed all filters. |
| `CONTINUATION_UNVERIFIED` | At least one response reports an unverified upstream continuation. Exhausting the scripted pages does not upgrade the product's query-completeness evidence. |

A completed verification prints one of these shapes. The limitations field is the sorted, deduplicated comma-separated list across runs, or `none`. Counts describe task-arm runs, not individual oracle checks.

```text
VERIFY_OK runs=<count> passed=<count> failed=<count> limitations=<codes-or-none> evidence=<sha256>
VERIFY_FAILED runs=<count> passed=<count> failed=<count> limitations=<codes-or-none> evidence=<sha256>
```

A normal completed verification has 18 runs; success means all 18 passed. A failed task report exits 1. An earlier setup, doctor or client fault can stop verification before a report is written. See [LIMITS.md](LIMITS.md) for gateway byte, request and retention bounds: an output allowance is not a promise that an entire resource fits.

## Review and register a host

Generate to a new file; the output destination must not already exist:

```sh
fireboat-quickstart configs --node "$QUICKSTART_NODE" --cli "$QUICKSTART_CLI" --config "$QUICKSTART_CONFIG" --out "$QUICKSTART_RUN/host-configs.json"
```

```text
CONFIGS_OK forms=4 sha256=<sha256>
```

The file contains four forms from the same absolute Node/CLI/config tuple, a Claude Code argv vector and a safely quoted POSIX registration command. Review the paths and command before placement or execution. Configs writes review material only; it does not inspect path existence, edit settings, register a server, restart a host or connect.

| Form in the output | Operator action after review |
| --- | --- |
| `claudeDesktop` | Place the `mcpServers.fireboat` entry in Claude Desktop settings, restart, then connect. |
| `cursor` | Place the `mcpServers.fireboat` entry in Cursor MCP settings, restart, then connect. |
| `vsCode` | Place the `servers.fireboat` entry (including `type: stdio`) in VS Code `mcp.json`, restart the server, then connect. |
| `claudeCode` | Review `argv`, `command` and `entry`; run the supplied registration command, restart, then connect. |

All four generated forms are **unverified per host/version/protocol-era cell** and specify guidance for the default full-text delivery. Generating a form or passing scripted SDK tasks does not verify a named host. These are local stdio forms; no host container launch form is generated.

## Private run files and cleanup

The run directory has mode **0700**. Files the helper writes have mode **0600**; existing run receipts and private input files must retain those modes. The operator's original config and CLI are read without changing their modes. Files can be incomplete or absent after failure.

| File in the run directory | Purpose |
| --- | --- |
| `receipt.json` | Run phase, manifest/Compose hashes and receipt-bound container ownership. |
| `compose.yaml`, `compose.env` | Exact Compose recipe and per-run ownership labels. |
| `attempt.json` | Persisted seed attempt, bound by the receipt; prevents treating partial setup as a fresh run. |
| `setup-packet.json` | Approved stored targets, observed versions, response hashes and numeric lexemes; bound to the attempt and instance. |
| `verify-<unique>/verify-gateway.config.json` | The operator config snapshot used for doctor and ordinary task sessions. |
| `verify-<unique>/verify-package-drain-reproject.config.json` | Derived config for the task's explicit retention TTL. |
| `verify-<unique>/verify-evidence.ndjson` | Complete raw JSON-RPC response frames (`rawFrame`), every sent/received frame since the previous call including initialization (`frames`), lossless result-member `rawText`, correlated request IDs, outcomes, work counters and result/frame byte counts. `kind` distinguishes task, clean-control and observed-control records. These contain synthetic resource records. |
| `verify-<unique>/verify-control.config.json` | Derived config with one explicit context shared by the clean/observed controls. |
| `verify-<unique>/verify-report.json` | Fixed task/check statuses, limitations, evidence hash, `verificationId`, per-era `controls` statuses/result hashes, and launch identity. `launch` includes `cliSha256`, `artifactSha256`, `artifactFiles` (regular package files; the 8,192-entry bound also counts dependency-resolution rows), base `configSha256` and `configs` with the name/hash of every base or derived config actually launched. |
| `host-configs.json` | Optional review material, at the output path chosen in this guide. |
| `verify.lock` | Exclusive verification lock; removed on normal completion or a handled failure. An interrupted process may leave it for investigation. |
| `writer.lock` | Temporary exclusive writer lock during prepare/down; removed on normal completion. |

Find a verification by its report's `verificationId` in the run directory; earlier verification directories are preserved. Treat the evidence as local synthetic records, not ordinary log output. The helper's summary lines carry fixed statuses, counts and hashes; do not copy raw evidence into ordinary logs. Keep it private when reviewing or sharing it.

To stop and remove this receipt's container:

```sh
fireboat-quickstart down --run-dir "$QUICKSTART_RUN"
```

```text
DOWN_OK actions=<count> receipt=<sha256>
```

Down revalidates the exact receipt-named container/image/ownership before cleanup and at destructive boundaries. After removing the container it removes the run's own Compose default network: it lists only networks labelled with this run's unique project, then removes one only by its exact inspected ID after checking its name, project and network labels, local bridge driver, the network ID recorded on the owned container and that no endpoint remains attached. An absent network is skipped; any mismatch stops cleanup. `--volumes` additionally permits removal of receipt-owned volumes after identity checks; today's in-memory, mount-free recipe has none. It does not prune Docker generally, remove unrelated resources or delete the run directory/evidence. A receipt already marked down cannot be cleaned up a second time.

For a reset, use this sequence instead of the preceding down command, and choose a new directory name each time:

```sh
fireboat-quickstart down --run-dir "$QUICKSTART_RUN" --volumes
QUICKSTART_RUN="$QUICKSTART_CHECKOUT/.local/quickstart-runs/run-002"
fireboat-quickstart prepare --run-dir "$QUICKSTART_RUN"
```

Run verify again for the new receipt, then restart/reconnect gateway sessions and any host registrations using them. Previous retained handles/cursors belong to old sessions. An existing run directory, including a failed one, is never a reseeding destination. When Compose's `up` fails, exceeds its deadline or overflows its output bound, prepare still asks Compose for the project's container and records its exact ID, so down can validate and remove it. If prepare failed before a container was recorded (including when that discovery also fails), down cannot manufacture a cleanup target; preserve the evidence and investigate the failure before starting anew.

## Troubleshooting fixed fault codes

Commands exit 0 on success, 2 for invalid command usage, and 1 for other helper faults or a failed verification report. Faults print a single fixed code to stderr. Unexpected exceptions, including lower-level SDK client faults, become `HELPER_FAILED`. Some pin/schema and manifest-assembly codes below originate in checkout validation tooling rather than the four helper commands.

| Fault code | Cause | Remedy |
| --- | --- | --- |
| `CLI_USAGE` | Unknown command, missing/duplicate/unknown flag, missing value or non-absolute path. | Use exactly the flags shown above; give every path flag an absolute value. |
| `PIN_MISSING` | A required generator pin/input is absent. | Restore the reviewed pin file and required fields; do not guess a replacement. |
| `PIN_UNSTABLE` | The Synthea pin is not a stable version tag. | Restore the adopted stable tag and matching commit/hash. |
| `PIN_INVALID` | Pin structure or an extra/changed field is invalid. | Restore the closed reviewed pin structure. |
| `PIN_MISMATCH` | Pin bytes/values or the fixed generation dates disagree with adopted inputs. | Restore matching reviewed pins and generation inputs; do not bypass the hash check. |
| `MANIFEST_INVALID` | The seed manifest cannot be parsed or fails its closed schema, target, pins or bounds. | Restore the manifest from the matching checkout/build. |
| `HELPER_ASSET_MISMATCH` | Compose bytes do not match the manifest's hash. | Restore the matching Compose recipe and manifest together. |
| `HELPER_MANIFEST_DRIFT` | The checkout manifest-assembly check differs from the checked-in manifest. | Have the maintainer regenerate and review it from the approved inputs. |
| `TARGET_MISMATCH` | The seeding target differs from the literal manifest loopback/port/path. | Use the unmodified quickstart target and assets. |
| `INSTANCE_FOREIGN` | Observed instance ownership/provenance or a reinspection fails. | Stop setup; inspect the receipt and Docker state. Never adopt or reseed an unrelated listener. |
| `BACKEND_MISMATCH` | Pinned backend identity or HAPI software/FHIR metadata disagrees. | Cache the exact pinned image and restore the recipe; clean up the owned failed run before a new prepare. |
| `TARGET_NOT_FRESH` | Pre-seed state is not established, or any required seeded-type count is not zero. | Clean up the owned instance and prepare a new run; do not seed existing data. |
| `SEED_NOT_LISTED` | A seed/read target, body, count type or resource set differs from the manifest allowlist. | Restore matching seed bytes and manifest; do not add arbitrary writes. |
| `SEED_ALREADY_ATTEMPTED` | The run directory exists or the seeding client has already claimed an attempt. | Clean up as applicable and use a new run directory; never retry seeding in place. |
| `PROXY_REFUSED` | Proxy-related environment or Node options activate the helper's refusal. | Remove proxy variables/options for this local helper invocation, then use a new run if prepare created one. |
| `REDIRECT_REFUSED` | The seeding endpoint returned a redirect. | Restore direct access to the pinned local HAPI; redirects are never followed. |
| `HTTP_FAILED` | A bounded seed/setup HTTP request failed or its response stream broke. | Check the owned container and local connection; preserve a partial run and reset before another prepare. |
| `HTTP_STATUS` | Seed/setup HTTP returned an unsuccessful status. | Inspect the owned backend and setup evidence; repair the cause, then reset a failed prepare. |
| `HTTP_LIMIT` | Response encoding/length, response size, request budget or client limit is refused. | Use the approved small assets and direct endpoint; investigate unexpected responses instead of raising bounds. |
| `HTTP_TIMEOUT` | A seed/setup request exceeded its deadline. | Check local Docker/backend health; reset a failed prepare before trying anew. |
| `HTTP_RESPONSE_INVALID` | Seed/setup JSON or an exact integer count response is invalid. | Restore the pinned backend and recipe; do not infer freshness from malformed counts. |
| `DOCKER_MISSING` | No executable Docker binary resolves from an absolute PATH entry, or execution cannot find it. | Put the Docker CLI in an absolute PATH directory and check the daemon. |
| `DOCKER_FAILED` | A Docker/Compose command failed, including a missing cached image, daemon issue or occupied port. | Check Docker/Compose, explicitly acquire the pinned image and free the port; clean up any receipt-recorded container. |
| `DOCKER_TIMEOUT` | A Docker command exceeded its deadline. | Check Docker responsiveness; run down for the receipt's recorded container, or preserve a run without one for investigation. |
| `DOCKER_LIMIT` | Docker output exceeded the helper's bound. | Investigate unexpected Docker output; retain the fixed bounds and approved recipe, and run down for any recorded container. |
| `DOCKER_ENDPOINT_REFUSED` | DOCKER_HOST, DOCKER_CONTEXT or the saved current Docker context resolves to a non-local (for example tcp or ssh) endpoint. | Select the local daemon's unix socket context for this helper; a remote daemon's published port is not this host's seed target. |
| `PORT_IN_USE` | Something already accepts connections at 127.0.0.1:18080, or the pre-start probe could not establish that the port is free. | Stop the existing listener (or clean up the run that owns it with down), then prepare a new run; never seed an existing server. |
| `DOCKER_EVIDENCE_INVALID` | Docker inspection output, image/platform, container settings or port association failed validation. | Use the supported pinned linux/arm64 recipe; inspect the owned run without weakening ownership checks. |
| `RUN_LOCKED` | An exclusive writer or verification lock exists. | Let the active prepare/down/verify finish; investigate an interrupted writer before recovery. Never remove a lock to reseed. |
| `RUN_INVALID` | A run directory/receipt/private file has invalid type, mode, content or bounds. | Check the selected run and its 0700 directory/0600 files; preserve evidence and do not fabricate a receipt. |
| `RUN_IO` | Private directory/lock creation or an atomic file write failed. | Check the parent directory, permissions and free space; retain failed-run evidence. |
| `SETUP_ORACLE_FAILED` | Stored resource identity, approved values/lexemes/references or final counts fail the setup oracle. | Preserve the failed run for diagnosis; clean up and start a new run after fixing the cause. |
| `READINESS_FAILED` | HAPI did not become ready within the bounded metadata polls/deadline. | Check local Docker resources and the pinned image; clean up the owned failed run before a new prepare. |
| `LAUNCH_NOT_ABSOLUTE` | Host form generation received a relative Node/CLI/config path. | Supply all three absolute paths. CLI path-flag validation can reject these earlier as `CLI_USAGE`. |
| `LAUNCH_INVALID` | The launch tuple is malformed, or the configs output destination cannot be reserved exclusively. | Check tuple values and the output parent; choose a new, nonexistent output file. |
| `CLEANUP_FOREIGN` | Cleanup cannot bind the receipt to the exact instance, or the run is already down/has no container target. | Check the run receipt and actual Docker identity; leave unrelated resources alone and investigate changed state. |
| `CLEANUP_FAILED` | An action failed after cleanup ownership checks. | Preserve the receipt and inspect which owned actions completed before further recovery. |
| `VERIFY_RUN_INVALID` | Prepare is incomplete, assets differ, or the attempt/setup packet has invalid shape, hashes, Compose identity or numeric inventories. | Select a completed matching run; reset incomplete setup instead of editing hashes or receipts. |
| `VERIFY_CONFIG_INVALID` | Operator config is unreadable/invalid, uses an unsupported delivery profile, names the wrong mode/target/alias/patient, or a launched snapshot changes. | Use the matching checked-in quickstart config and an absolute path. |
| `VERIFY_DOCTOR` | The CLI/artifact closure is unreadable, oversized or changes during verification; doctor fails; or its ready/identity lines are invalid. | Build the matching gateway, check Node/CLI/config paths and backend readiness; run its doctor to diagnose. |
| `VERIFY_HANDLE_MISSING` | A scripted later step has no retained handle from its earlier step. | Review private evidence and gateway/task consistency; rebuild matching code before rerunning verify. |
| `VERIFY_DRAIN_LIMIT` | A task continuation drain exceeds its bounded page count. | Inspect continuation evidence and the seeded backend; do not remove the drain bound. |
| `HELPER_FAILED` | An unexpected helper, process, filesystem or lower-level client error escaped the fixed quickstart faults. | Check the build, paths, Node version and private run evidence; resolve the cause before rerunning the applicable command. |

The helper boundary check combines Node-observed static/executed module resolution with an isolated nested-layout bin launch and a separate admitted-source-form check. Helper and pure shared modules refuse builtin-module loaders, `createRequire`, `require`, dynamic import, `import.meta.resolve`, evaluation/Function construction, `process.binding`/`dlopen`, and imports of `node:module`, `node:vm` or `node:worker_threads`. The pinned TypeScript parser inspects every syntax node, including functions after templates/regexes, and folds constant strings (including template expressions) independently of whether they execute. It uses one virtual file with no libraries or module resolution and closes its local compiler IPC session after inspection; it writes no files and executes no source. Only `import.meta.url` is admitted; aliases of the whole metadata object and optional/computed resolver forms refuse. This is a restriction on reviewed source and observed resolution, not a JavaScript sandbox or a proof against arbitrary obfuscation.

The seed transformer now refuses single-token provider names/displays/aliases instead of trying to distinguish them from common prose. Every admitted removed provider name is matched as a bounded value everywhere in the output. Supported names must contain multiple words; unsupported contact/name forms refuse. The pinned natural and merged seed bytes and fixture manifests are unchanged. The helper manifest's `artifacts.transformSha256` is regenerated from the reviewed transformer source; prepare/verify must use the matching helper manifest.
