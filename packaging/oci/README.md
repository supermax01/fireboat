# Local OCI subset (S10; unreleased)

The image is the synthetic-only stdio gateway. It exposes no port. Its runtime
payload is copied from the S9 packet's verified offline production installation;
there is no npm install, source compilation or lifecycle rebuild in the image.
The separately installed helper stays outside the image. No push, image tag,
Registry entry, download, signature or publication is performed by these tools.

`Dockerfile` pins the approved Node index. `build.mjs` verifies its selected
linux/arm64 child, config and every compressed layer and uncompressed diff ID
using **local `docker image save` bytes**. It checks the tar/npm inventories,
shrinkwrap and accepted installed file inventories before assembling a minimal
context. A changed file, mode, package membership, link, platform selector,
native library or install hook refuses. The Linux image copies the same portable
JavaScript bytes; the S9 tree's darwin platform label is retained as its origin,
not presented as Linux task evidence. Image file bytes are checked again inside
the actual read-only image. The original S9 packet is never modified.

Build commands use `--network none --pull=false` and the cached daemon image.
The local legacy builder is explicitly selected to avoid a registry metadata
resolver. Runtime commands use immutable local IDs and `--pull=never`. Missing
cached images fail. The output records the image manifest and config digests
separately from the local image ID; equal strings do not make them interchangeable.
The save includes an OCI layout whose selected blobs are verified. Its wrapper
`index.json` hash is recorded separately; no registry manifest is claimed.

Use Node 24.22.0. The builder needs the checkout's existing `tsx` loader to read
the existing package verifier. The installed gateway/helper never load it. No
dependency installation is part of this subset. A new output directory is
required for every build/run. On Colima, `--out` **must be beneath a directory
shared with the VM**, such as this checkout's ignored `.local/oci/`. Host
`/private/tmp` is not shared by the current VM. Evidence directories are 0700;
single test-only config/inventory/observer mounts use readable 0444 copies within
those private directories so numeric container UID 1000 can read them.

## Local build and smoke

```sh
export DOCKER_HOST=unix://<local-docker-socket>
export DOCKER_CONFIG="<docker-config-dir>"
S10_NODE=<node-24.22.0>/bin/node
S10_SCRATCH=/private/tmp/claude-501/-Users-cv-Desktop-FHIR-MCP/37c7fdb6-5845-404a-9e44-64427710c7ef/scratchpad/sol
S10_PACKET="$S10_SCRATCH/s8pack/release-packet-integrated-001"
S10_INSTALLED="$S10_SCRATCH/s8pack/offline-install-integrated-001"
S10_BUILD="$PWD/.local/oci/build-root-001"
mkdir -p "$PWD/.local/oci"
"$S10_NODE" --import tsx packaging/oci/build.mjs \
  --packet "$S10_PACKET" \
  --gateway-install "$S10_INSTALLED/gateway" \
  --out "$S10_BUILD"
```

This runs only short `--network none` containers: `fireboat --version`, a kernel
hardening probe and an installed-file inventory probe. It verifies UID/GID
1000:1000, read-only `/tmp` with EROFS, all five capability sets at zero and
NoNewPrivs=1. The image's own version label can still say `runtime=unverified`;
a smoke is not the full Linux release cell. `inventory.json`, `image-files.json`,
`image.tar`, `node-base.tar` and an augmented `s10-handoff.json` record observations.
The upstream complete `binding` is preserved unchanged. The augmented Node entry
fills only the locally observed arm64 config/layers; amd64 remains unverified.
Every deferred gate and supply-chain cell is explicitly unverified.

## Root execution after the aggregate

**Do not execute this section while the aggregate owns machine capacity and
127.0.0.1:18080.** These commands provision the helper-owned HAPI using its
installed, pinned recipe. Use a fresh run directory. They neither adopt nor
remove a pre-existing instance. Root must first finish reviewing the code and
rebuild above if any hashed recipe or input changed.

```sh
S10_HELPER="$S10_INSTALLED/helper/dist/examples/quickstart/main.js"
S10_RUN="$S10_SCRATCH/s10oci/hapi-run-root-001"
S10_GATES="$PWD/.local/oci/gates-root-001"
"$S10_NODE" "$S10_HELPER" prepare --run-dir "$S10_RUN"
"$S10_NODE" packaging/oci/run-gates.mjs \
  --build "$S10_BUILD" --packet "$S10_PACKET" \
  --helper-install "$S10_INSTALLED/helper" \
  --gateway-install "$S10_INSTALLED/gateway" \
  --prepared-run "$S10_RUN" --out "$S10_GATES"
S10_RESULT=$?
"$S10_NODE" "$S10_HELPER" down --run-dir "$S10_RUN" --volumes
test "$S10_RESULT" -eq 0
```

Run the cleanup command even if prepare or the gates fail. In a shell using
`errexit`, arrange a cleanup trap around those commands so a failure does not
bypass helper `down`. Only the installed helper cleans its own HAPI. The gate
runner never calls `prepare`, compose up/down, a network/volume prune or a broad
container removal. It requires a completed receipt, checks the installed helper
assets/packet, freshly verifies the exact HAPI image/ownership/loopback port and
joins **that** container's network namespace. Every S10-created container has a
fresh name and run label, which are re-inspected before removing its full ID.
The runner always attempts cleanup, including failures. It checks HAPI is still
owned and running after its own cleanup. It leaves host evidence directories.

The gate runner checks the live UID/read-only/capability/no-new-privileges state
and matching namespace, rejects external and hostname source configs before
transport, verifies that an active ambient proxy receives a positive control
but zero gateway requests, verifies a redirect target receives zero requests,
and checks SDK cancellation, upstream socket closure and continued responsiveness.
The cancellation session raises the gateway's ordinary upstream timeout to 30 s.
Its hanging request must first stay open, uncancelled, for a 4 s control hold,
then close within a measured 4 s of the abort, so the ordinary timeout cannot
satisfy the gate.
Negative egress here means the **gateway's literal-loopback policy**, not an OS
firewall or permission for arbitrary network calls. All negative fixtures listen
only on literal loopback inside the helper's namespace and publish no port.

Doctor runs attached to the actual image entrypoint. The installed helper's
`verify()` runs all three tasks × three arms × both eras (18 runs; three
independent tasks) with its own unchanged call-by-call oracle. Clean sessions use
the image entrypoint over attached Docker stdio. Observed sessions use a
read-only test bridge to spawn the identical image CLI with the installed
helper's exact request observer. MCP stdout frames stay byte-identical. Its
private fd-3 setup/barriers are transported over a distinct stderr control
channel; gateway diagnostics are discarded. No HTTP client in the host SDK
adapter is permitted. The helper checks clean/observed discovery equivalence,
raw result members, accounting, response bindings and independently observed
request work. Every session is inspected for hardening. The lifecycle gate
records every session's exit status and requires each opened session to have
exited with code 0 and no signal within 1 s of stdin closure. A crash, signal,
nonzero container exit or hang fails it even though cleanup still removes it.
The bridge and fixtures are test mounts, absent from image layers.

`gates.json` binds the original packet, augmented handoff and exact image, with
per-gate statuses. The helper retains 0600 raw task evidence under its private
run directory; no payload or patient identifier is printed to ordinary logs.
Image SBOM (including OS/base components), vulnerability scan/tool/database date,
signature and provenance verification, any registry digest, linux/amd64,
native-Linux-host/Docker Desktop and other runtime/platform cells stay
**unverified**. The copied gateway production inventory/S9 SBOM is not a full
image SBOM. No S10 runtime pass completes these supply-chain/release gates.

## Compose topology

`compose.yaml` is an overlay on the **original helper-owned** compose file, not
a replacement that creates HAPI. Root may review its resolved configuration
with `docker compose config`. After a successful helper prepare, use
`--project-name` from that run's receipt and both compose files, followed by
`run --no-deps --rm gateway`. Supply `FIREBOAT_OCI_IMAGE` as the verified local
image ID and `FIREBOAT_OCI_CONFIG` as a VM-visible 0444 copy of the accepted
container config beneath a private host directory. Never run `up` with the
overlay or ask compose to recreate HAPI. The helper recipe alone publishes
`127.0.0.1:18080:8080`; the gateway has no ports and uses
`network_mode: service:hapi`. Docker CLI gates use the equivalent full-ID
`--network container:<verified-helper-container>` mode.

## Listener-free checks

```sh
"$S10_NODE" node_modules/typescript/bin/tsc --noEmit
"$S10_NODE" --import tsx --test tests/oci-recipe.test.ts
"$S10_NODE" --import tsx --test tests/oci-inventory.test.ts
"$S10_NODE" --import tsx --test tests/oci-runner.test.ts
```

Run each test file separately. These tests perform no Docker call, listen, task
session, installation or network operation. Proposed mutation entries and two
reproduced single-file kills belong in the S10 scratch handoff; root alone
integrates them into `scripts/mutation-guards.mjs`.
