# Contributing

Thank you for considering a contribution. This project is a synthetic-data, read-only FHIR MCP gateway prototype with a strict evidence discipline; the rules below keep it that way.

## Ground rules

- **Synthetic data only.** Never add real patient data, even de-identified, to fixtures, tests, examples, issues or pull requests. The bundled synthetic source and the Synthea-derived fixtures are the only data sources.
- **No secrets.** No credentials, tokens or private keys in code, tests, configuration examples or CI. Outbound credentials come from environment variables named in configuration.
- **No clinical writes, arbitrary HTTP, arbitrary URLs or headers, remote unauthenticated serving, hidden model calls, or unimplemented tools.** The MCP surface is the five implemented read-only tools.
- Keep the core policy, HTTP transport, output projection, result store and MCP adapter separate (`packages/core`, `packages/server`).
- Ordinary logs must never contain resource bodies, credentials or patient identifiers.

## Before you open a pull request

```sh
npm ci
npm run check            # typecheck, tests (including real SDK stdio calls), build
npm run test:isolation   # patient-isolation suite
npm run eval:retrieval && npm run eval:retrieval -- --era legacy
```

Add tests for anything that touches authorization, confinement, payload omission, continuations, transport budgets or denials. If you change guarded behaviour, the mutation registry (`scripts/mutation-guards.mjs`) may need a new or updated mutant; `tests/mutation-anchors.test.ts` fails when an anchor no longer applies.

Tool descriptions, schemas and server instructions are measured against byte caps (`docs/contracts/m3b-tools.json`). Any change to them must come with a fresh capture and must not exceed the cap for that tool.

## Pull request contents

- A clear statement of what changed and why, with the tests that pin it.
- Updated generated artifacts when a generator's input changed (`node --import tsx scripts/emit-m3b-contract.mjs --check` must pass).
- No unrelated reformatting.

## Code of conduct

Be respectful and constructive. Reports of unacceptable behaviour can be sent through the private channel described in `SECURITY.md`.

## License

By contributing you agree that your contribution is licensed under the Apache License 2.0 that covers this repository.
