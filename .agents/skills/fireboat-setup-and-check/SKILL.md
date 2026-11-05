---
name: fireboat-setup-and-check
description: Set up a fireboat checkout and run its local gates (typecheck, tests, build, demo, evals, isolation). Use on a first run, after pulling changes, before committing, or when the environment misbehaves.
---

# Set up and check fireboat

## Requirements

- Node **24.22.0**, the version in `.nvmrc`. It is the only verified runtime; other Node 24 versions are unverified, and 24.21.0 is known to be bad.
- npm 11. Install with `npm ci`, never `npm install`, so the lockfile stays exact.
- Docker only for the optional live checks. The core workflow needs none.

## Steps

```sh
npm ci
npm run check            # typecheck, ~2,400 tests including real MCP SDK stdio calls, build
npm run demo -- --check  # synthetic source + real stdio server; expect "demo check passed (8 outcomes)"
```

Before committing anything that touches behaviour, also run:

```sh
npm run eval:retrieval                    # modern MCP era: expect "tasks 83/83 passed"
npm run eval:retrieval -- --era legacy    # legacy era: same
npm run test:isolation                    # B2 suite; "status=DIAGNOSTIC earned=0" is expected today
```

## When something fails

- **Many temp folders, or a full disk:** run suites with their own `TMPDIR` (`TMPDIR=$(mktemp -d) npm test`) and delete it afterwards. Suites stopped early skip their cleanup.
- **A hang near port 18080:** a live HAPI quickstart owns `127.0.0.1:18080`. Stop it (`fireboat-quickstart down`) or wait before running the unit suite.
- **`ledger design digest differs from the design file`** in the isolation suite: `proposals/b2-isolation-suite-design.md` was edited. Restore it byte for byte.
- **`generate-m3b-docs: out of sync`:** a generated doc was hand-edited, or its inputs changed. See the `fireboat-docs-and-contract` skill.
- **Never fix a failure** by weakening a test, oracle, budget or guard.
