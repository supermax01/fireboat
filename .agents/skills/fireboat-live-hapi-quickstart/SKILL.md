---
name: fireboat-live-hapi-quickstart
description: Run fireboat against a local, helper-owned HAPI FHIR server seeded with the synthetic Synthea quickstart data, verify the packaged tasks and generate host configurations. Use when testing beyond the bundled stub source.
---

# Live HAPI quickstart

The full procedure, and the expected output of every step, is in [docs/QUICKSTART.md](../../../docs/QUICKSTART.md). This skill is the short version.

## Limits

- The pinned HAPI image is **linux/arm64 only** today; other platforms are unverified.
- You need local Docker with Compose v2. Everything binds to loopback only.
- The helper owns `127.0.0.1:18080`. Do not run the unit suite or the mutation gate while it is up.
- Data is synthetic only. Credits for the LOINC, SNOMED CT, UCUM and HL7 codes in the seed are in `licenses/SEED_NOTICES.md`.

## Steps

```sh
npm ci && npm run build
# define the fireboat-quickstart helper function exactly as docs/QUICKSTART.md shows, then:
fireboat-quickstart prepare --run-dir "$QUICKSTART_RUN"       # expect PREPARE_OK resources=282
fireboat-quickstart verify  --run-dir "$QUICKSTART_RUN" --node "$QUICKSTART_NODE" --cli "$QUICKSTART_CLI" --config "$QUICKSTART_CONFIG"   # expect VERIFY_OK runs=18
fireboat-quickstart configs --node "$QUICKSTART_NODE" --cli "$QUICKSTART_CLI" --config "$QUICKSTART_CONFIG" --out "$QUICKSTART_RUN/host-configs.json"
fireboat-quickstart down    --run-dir "$QUICKSTART_RUN"       # always clean up
```

Report anything unexpected as a GitHub issue, with the step, its output, your OS and architecture, Docker version and Node version.
