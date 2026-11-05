# Live quickstart, installed package and S10 runtime gates (2026-10-25)

- **What this is:** the first complete runs of the helper-owned HAPI quickstart, the installed-package rehearsal against a live HAPI, and the S10 container runtime gates. Synthetic data only, loopback only (127.0.0.1:18080), offline installs, no image pull, nothing published.
- **Machine:** darwin arm64, macOS 27.0.1, Mac15,7, 12 CPUs; Node 24.22.0, npm 11.19.1; Docker through colima (2 CPUs, 3.8 GiB VM); HAPI FHIR image `hapiproject/hapi@sha256:0ff86aac…a04e`; Docker Compose 5.6.1.
- **Not established:** any host other than the helper's scripted clients; linux/amd64; OCI supply-chain checks (full-image SBOM, scan, signature, provenance, registry digest); cold acquisition or unaided human timing; release approval (the packet stays `private-candidate`, `publishAuthorized:false`, 25 items missing).

## First attempt: SETUP_ORACLE_FAILED (04:09Z, tree 9651001)

All three runs failed at the same point: `prepare` seeded the 282 resources, read every one back identically, then the setup oracle's per-type counts came back 0 (DiagnosticReport 0 of 28, Observation 0 of 242, Patient 0 of 2). HAPI reuses the result of an identical search for 60 s by default (`X-Cache: HIT`), and prepare's pre-seed freshness counts had just asked the same questions. The reviewed seed client had sent `Cache-Control: no-cache` (`b3f4432`, review F2); the header was lost when `seed-http.ts` was rewritten in `823c870`. Fix: `3edd01e` (merged `cd0e3b3`), every bodiless helper request sends it again; the oracle is unchanged. New unit mutant `s8-seed-no-cache`, killed by named tests (diagnostic `--only`, report in `.local/rejudge-003/`).

## Checkout quickstart (tree 3edd01e, run-003)

```
PREPARE_OK resources=282 types=7 manifest=57dfb62ea88a629fbcd578d3b34cc5bfdec79085d8db86986abf3346b569a710 receipt=c5c24aa66f4c604ca345a51e759a8aacc357f097889d65e07510b249adabeea2 packet=08b81f9f6e80200ae7e869611cf6a46bb06d5fa9525bbc26cd870c817ffc7f30
VERIFY_OK runs=18 passed=18 failed=0 limitations=CONTINUATION_UNVERIFIED,FILTER_UNVERIFIED,LATEST_UNVERIFIED evidence=e889248c51bf279fc07668afc66f5e52370d5bae77472684c059402bc4b6aa48
CONFIGS_OK forms=4 sha256=f0f93365cebbae3981bfd0a1a7ab2ccb5cbbfe9c281fc96df52d09712ec1e730
DOWN_OK actions=2 receipt=7fda98bb13ec02f972f6d73213dddcc5bb3deaafea99b54c9048a9e743716bd7
```

## Re-pack (tree cd0e3b3)

The approved inventories changed in exactly two entries, both from `3edd01e`: `docs/QUICKSTART.md` (34,248 -> 34,426 bytes) and the helper's `dist/examples/quickstart/seed-http.js` in both inventories (9,236 -> 9,455 bytes); no additions, removals, mode or identity changes (99 gateway and 35 helper entries). `npm run test:package` 14/14; `verify:package` passed.

- Tar `fireboat-gateway-0.2.0-alpha.1.tgz`: 99 files, SHA-256 `1be587bdeb797d615c9a31ff505648a8b792eb52939bd63dc331fc163ff77a42`, npm integrity `sha512-lN9P9+Qy9ZCNYIIYmlmQhumiPWkGUUXSMCf5/a7ksHZwuuyuNqVYCuk0lA762p2J8rUJ5z09lw95m5GomXGMeA==`.
- Fresh offline locked gateway and helper installs (lifecycle scripts and bin links disabled): all stages passed; stub rehearsal 18/18 runs and 6/6 guard groups; installed trees verified, no symlinks.
- Release packet (`release:manifest`, revision `cd0e3b3`): 19 files, manifest SHA-256 `69057346e0d3a05328890ae56fb12fce52b1ae7ab440220f6ead0f4f3cee0a65`, CycloneDX 1.5 SBOMs, `private-candidate`.

## Installed package against live HAPI

```
PREPARE_OK resources=282 types=7 manifest=57dfb62e…a710
PACKAGE_INSTALLED_OK runs=18 guards=6 tar=1be587bdeb797d615c9a31ff505648a8b792eb52939bd63dc331fc163ff77a42
DOWN_OK actions=2
```

Timing wrapper, warm: 81.5 s in total (seeding 24.7 s, verification 55.1 s, cleanup 1.7 s), 0 errors.

## S10 OCI runtime gates

```
OCI_BUILD_OK platform=linux/arm64 local=sha256:40370ab3f2b62980c4b2ce208fff30252854de2d028f1c6d3c528abe66eb614a config=sha256:657346475539decedc2b1a2553c2f34cb89cfb13f65a4c055e53d83486909696 files=1045
PREPARE_OK resources=282 types=7
OCI_GATES_OK runs=18 image=sha256:40370ab3…614a report=e531df7265272fec3c5841b41f429ff7c1b5e2069e2cb88628763207932677d7 supply_chain=unverified
DOWN_OK actions=2
```

All nine runtime gates passed: helper namespace, negative egress, proxy, redirect, attached-stdio doctor, 18 task runs across both eras, startup/shutdown, cancellation and owned cleanup. Status: `runtime-gates-passed; supply-chain-and-other-cells-unverified`. A later review (2026-10-25) found two of these gates weaker than their names: the cancellation gate's 15 s window also accepts the ordinary 10 s upstream timeout, and the startup/shutdown gate does not check the exit status, so a crash after stdin closes would also pass. Both gates are being tightened; until they are re-run, the cancellation and clean-shutdown results are not established. The image built from the pre-fix tar earlier the same morning had manifest `54f51348…e675`, matching the digest recorded for the earlier network-less build. Both builds ran with Docker's build cache enabled, so this shows matching output, not an independent cache-free reproduction; reproducibility is not claimed. The new digest reflects the fixed helper.

Raw run directories, logs and reports stay outside git (the session scratch `pack-002/`, `s10oci/.local/oci/{build,gates}-root-002/`, `qs-live/.local/quickstart-runs/run-003/`).

## Re-run after the external review fixes (tree 31aa6a2, 2026-10-25 afternoon)

The GPT-6 Astra stack review (`proposals/audit/astra-stack-review-2026-10-25/`) led to runtime privacy fixes (malformed upstream values), helper fixes (local-only Docker endpoint, occupied-port refusal, container recording after Docker timeouts, Compose network removal), an exact installed-package gate and stricter OCI gates. On the merged tree (`31aa6a2`; `npm run check` 2,396/2,396; both eval eras 83/83 per arm) every live check was repeated:

```
checkout:  PREPARE_OK resources=282 types=7   VERIFY_OK runs=18 passed=18 failed=0   DOWN_OK actions=3 (container and network removed)
installed: PACKAGE_INSTALLED_OK runs=18 guards=6 tar=415d0a2ff9da3e343d4673ebe9efbfc765663ffe98af018b05b9b6d50eca9a21
           (installed gateway compared with the verified inventory: files, modes, hashes and npm's recorded integrity)
S10:       OCI_BUILD_OK platform=linux/arm64 local=sha256:cfe6e15f1770d0200bc4d3487f84e38cca4f1ac59af1ee9791854ec7e2c6c21a files=1045
           OCI_GATES_OK runs=18 report=29286fab0c8abf2ee190593bd8958dd76d3622118d4bedec92fbbdbc44cc2886 supply_chain=unverified
```

- Re-packed tar: 99 files, SHA-256 `415d0a2f…9a21`, npm integrity `sha512-yMpN9BT/6BgBQlE+KKDt/zn7yPio0R3IMA2UY6tOkx9DShir9MLpMeVLQdMegmkg/BGsW8NbyXKB8YPu8L15qw==`. The approved inventories changed only in size and hash for the ten packaged files compiled from changed sources (core privacy, index, schema, search parameters; auth client credentials; the helper's docker, down, prepare and seed-http modules) and `docs/QUICKSTART.md`.
- Release packet (`release:manifest`, revision `31aa6a2`): 19 files, manifest SHA-256 `0a76856b…71cbd`, still `private-candidate`, 25 items missing.
- The stricter S10 gates now establish what their names say: **startup/shutdown**, all 23 sessions exited 0 with no signal within 1 s; **cancellation**, with a 30 s ordinary upstream timeout the uncancelled request stayed open 4.4 s and the socket closed 93 ms after the abort (limit 4 s). The other seven runtime gates passed as before. Supply-chain cells and linux/amd64 remain unverified.
- The installed run took 98.6 s warm (seeding 33.2 s, verification 63.1 s, cleanup 2.3 s), 0 errors.
