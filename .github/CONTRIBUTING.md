# Contributing

Thank you for considering a contribution. fireboat is a small, read-only MCP gateway for one patient's FHIR R4 records. It is an early source preview that runs on synthetic data by default, and nothing here promises a release date or support. The rules below keep it honest. Please also read the [code of conduct](CODE_OF_CONDUCT.md).

## Ground rules

- **Synthetic data by default.** Fixtures, tests, examples, issues and pull requests use synthetic data only. Openly licensed de-identified research data (currently the MIMIC-IV Clinical Database Demo on FHIR v2.1.0, ODbL) may be used for benchmarks only: it is downloaded at run time, cited (see [benchmarks and research data](../docs/TESTING.md#benchmarks-and-research-data)), and never committed to the repository or included in fixtures, tests, examples, issues, pull requests or logs. Never add any other real or de-identified patient data.
- **No secrets.** No credentials, tokens or private keys in code, tests, configuration examples or commits. Outbound credentials come from environment variables named in configuration.
- **Read-only, one fixed patient.** No FHIR writes, no tool argument that selects another patient, no tool that accepts a URL, host or header, no remote unauthenticated serving, no hidden model calls, no tools beyond the five implemented ones.
- **Keep the layers separate:** core policy, HTTP transport, output projection, the result store and the MCP adapter (`packages/core`, `packages/server`).
- **Ordinary logs never contain** resource bodies, credentials or patient identifiers.
- **No overclaiming.** Do not claim clinical readiness, SMART authorization, vendor compatibility or security guarantees that a recorded check does not support. See [AGENTS.md](../AGENTS.md) for the full list of boundaries.

## Set up

Use Node 24.22.0, the version in [.nvmrc](../.nvmrc). It is the only verified runtime.

```sh
npm ci
npm run check            # typecheck, the full test suite (real MCP SDK stdio calls), build
npm run demo -- --check  # synthetic source plus real stdio server; needs no Docker or keys
```

The suite takes a few minutes. Check that `node --version` prints v24.22.0 inside the checkout before running it. While iterating, run one file with `node --import tsx --test tests/<file>.test.ts`. If you run several suites in parallel, give each its own `TMPDIR` and delete it afterwards, because some suites leave temporary folders behind when stopped early. Do not run the unit suite while a live HAPI quickstart is using `127.0.0.1:18080`.

## No automatic checks on pull requests

The project uses no hosted CI. Pull requests get no automatic checks, so run the checks below yourself and say in the pull request which ones you ran.

## Before you open a pull request

- `npm run check` for any change to code, tests, schemas or data. For prose-only changes, the docs checks are enough.
- `npm run eval:retrieval` and `npm run eval:retrieval -- --era legacy`, which cover MCP protocol versions 2026-07-28 and 2025-11-25. Both must pass.
- `npm run test:isolation`, the patient-isolation suite. It currently runs diagnostically, so 0 counted cases is expected.
- `node --import tsx scripts/generate-m3b-docs.ts --check` and `node --import tsx scripts/emit-m3b-contract.mjs --check`, which confirm the generated docs and the tool contract match the code.
- `npm run test:package` after editing any document that ships in the npm package (see "Generated files" below). If its drift test fails, say so in the pull request.

Add tests for anything that touches authorization, patient confinement, payload withholding, continuations, strict search, transport budgets, redirects or denials. Prefer tests that use a real MCP SDK client over stdio.

## The mutation gate, in plain words

The code that enforces the safety boundaries is guarded by deliberate weakenings, called mutants, listed in `scripts/mutation-guards.mjs`. The gate edits the code to apply each mutant and expects a named test to fail. If a test does not notice, the guard is not doing its job. If you change guarded code, keep every mutant caught, or update its anchor (the code snippet it edits) so it keeps the same meaning. `node --import tsx --test tests/mutation-anchors.test.ts` checks that every anchor still applies. Never weaken a guard, budget, oracle, gate or test to make something pass. If a test looks wrong, say so in the pull request instead of editing it.

A full run of the gate splits the mutants into shards (`--shard i/n`), then combines the shard reports with `--aggregate`. Most mutants are decided by a targeted first pass that runs a few likely test files and kills a mutant only when a named test fails twice; every other mutant is judged by the full path. A few mutants are declared survivors, each with a written justification in `scripts/mutation-survivors.json`. A full run takes hours, so while iterating run a few mutants with `--only <ids>`; a diagnostic `--only` run never counts as a full pass. Current results are in [docs/TESTING.md](../docs/TESTING.md).

## Generated files

Do not hand-edit generated files. Change their inputs and regenerate:

- `docs/SUPPORT-MATRIX.md`, `docs/support-matrix.json`, `docs/QUERY-EVIDENCE.md`, `docs/COMPACT-PROFILES.md`, `docs/HOST-PROFILES.md`, `docs/QUERY-REPAIR.md` (generated by `scripts/generate-m3b-docs.ts`)
- `packages/core/src/generated/*` (generated from the pinned HL7 FHIR R4 package)
- `packaging/licenses/inventory.json` and `packaging/*.json` (approved inventories, updated only by the packaging tools)

Some documents ship in the npm package, including `README.md`, `.github/SECURITY.md`, `packaging/THIRD_PARTY_NOTICES.md`, several files under `docs/` and the files under `packaging/licenses/`. Their hashes are pinned in `packaging/npm-files.json`, and `tests/package-inventory-drift.test.ts` fails when one of them changes without a maintainer re-approving the inventory. If it fails after your edit, say so in the pull request; the maintainer re-approves it with `npm run stage:package -- --approve-inventory <absolute-new-stage>`.

Tool descriptions, schemas and server instructions are measured against byte caps in `docs/contracts/m3b-tools.json`. A wording change needs a fresh capture and must stay within each tool's cap.

## Pull request contents

- What changed and why, and the tests that pin it.
- Regenerated artifacts when a generator's input changed.
- No unrelated reformatting.
- Small, focused commits with a subject that says what changed.

## Security reports

Do not open a public issue for a suspected vulnerability. Use the private route in [SECURITY.md](SECURITY.md).

## License

By contributing you agree that your contribution is licensed under the Apache License 2.0 that covers this repository (see [LICENSE](../LICENSE) and [NOTICE](../NOTICE)).
