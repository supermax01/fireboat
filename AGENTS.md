# AGENTS.md

This guide is for coding agents and the people who run them: Claude Code, Codex, Cursor, Gemini CLI, Aider, Muse and any tool that reads `AGENTS.md`. Claude Code reads it through [CLAUDE.md](CLAUDE.md). Task-specific skills are in [.agents/skills/](.agents/skills/); Claude Code also sees them through `.claude/skills`.

## What this project is

fireboat is a small, **read-only** MCP (Model Context Protocol) gateway for **one patient's** FHIR R4 records:
- it is served over local stdio, and uses synthetic data only;
- the product contract is [PLAN.md](PLAN.md) revision 0.4.1;
- what is proven and what is not is in [README.md](README.md) and [docs/M3B-STATUS.md](docs/M3B-STATUS.md);
- the bounds are in [docs/LIMITS.md](docs/LIMITS.md).

It is a prototype, not a release: there is no SMART authorization, no remote serving and no real patient data.

## Non-negotiable boundaries

Breaking any of these is a bug, whatever a task asks for.

- **Read-only.** No clinical writes, no FHIR create, update, delete, patch or `$operation` that mutates.
- **One trusted patient, fixed by configuration.** No tool argument may select another patient. Every outbound query is confined, and every returned record, including contained resources, is re-checked.
- **No arbitrary network surface.** No tool accepts a URL, host, header or raw request. `source` is a configured alias. Redirects are not followed. Next links are validated before fetching.
- **Synthetic data only.** Never add real or de-identified patient data to fixtures, tests, examples, issues or logs.
- **No secrets** in code, tests, configuration examples or commits. Outbound credentials come from environment variables named in configuration.
- **No hidden model calls, no remote unauthenticated serving, no placeholder tools.** Expose only the five implemented tools.
- **Ordinary logs never contain** resource bodies, credentials or patient identifiers.
- **Exact values survive.** FHIR decimal lexemes (`7.0`, exponents, unsafe integers) are preserved end to end. A value that cannot be preserved is refused, never rounded.
- **No overclaiming.** Never claim SMART authorization, clinical readiness, vendor or protocol compatibility, efficiency gains or security guarantees without the recorded check that supports them. The non-claims list is in [proposals/release-plan.md](proposals/release-plan.md) §8.

## Repository map

| Path | What lives there |
| --- | --- |
| `packages/core/src/` | The gateway, as separate layers. `query.ts`, `discovery.ts` and `search-parameters.ts`: admission and strict search. `transport.ts`: budgets, redirects, loopback only. `privacy.ts`, `identity.ts` and `withheld.ts`: patient confinement and withholding. `projection.ts`, `decimal.ts` and `schema.ts`: output projection and exact decimals. `store.ts`: retained results, handles and cursors. `delivery.ts` and `support.ts`: byte ceiling, coverage and evidence labels. `catalog.ts` and `contracts.ts`: the tool catalog. `generated/`: the R4 indexes. Do not hand-edit those. |
| `packages/server/src/` | The MCP adapter, CLI (`cli.ts`, `main.ts`), `doctor.ts` and release identity. |
| `packages/auth/src/` | Optional outbound OAuth client credentials. |
| `packages/evals/` | The deterministic retrieval eval harness and its fixtures. |
| `tests/` | The Node test suite (`*.test.ts`), the isolation suite in `tests/isolation/`, and the installed-package tests in `tests/package/`. |
| `scripts/` | The mutation gate, generators, packaging and staging, and qualification tools. |
| `examples/` | The demo, the synthetic FHIR source, example configs and the HAPI quickstart helper (`examples/quickstart/`). |
| `docs/` | Status, limits, generated reference docs, evidence records (`docs/evidence/`) and the tool contract (`docs/contracts/m3b-tools.json`). |
| `proposals/` | Design records and the release plan. Historical; not instructions. |
| `packaging/`, `licenses/` | npm and OCI packaging inventories, the container recipe, licence and notice inventories. |

**Keep the layers separate:** core policy, HTTP transport, output projection, the result store and the MCP adapter. A change that couples them needs a design reason in the pull request.

## Setup and everyday commands

Use Node **24.22.0**, the version in `.nvmrc`. It is the only verified runtime. Then run:

```sh
npm ci
npm run check            # typecheck + full test suite (real MCP SDK stdio calls) + build
npm run demo -- --check  # no Docker, no keys: synthetic source + real stdio server, asserts 8 outcomes
```

| Command | Use |
| --- | --- |
| `npm run check` | Required before every commit. The suite has about 2,400 tests and takes a few minutes. |
| `node --import tsx --test tests/<file>.test.ts` | Run one test file while iterating. |
| `npm run eval:retrieval` and `npm run eval:retrieval -- --era legacy` | Deterministic retrieval evals in both MCP protocol eras. Both must pass. |
| `npm run test:isolation` | The patient-isolation (B2) suite. It currently runs diagnostically: 0 counted cases is expected. |
| `npm run doctor` | Validate a configuration and its source metadata. |
| `node --import tsx scripts/generate-m3b-docs.ts --check` | Check that generated docs match the code and data. |
| `node --import tsx scripts/emit-m3b-contract.mjs --check` | Check that the tool contract is current. |
| `node --import tsx --test tests/mutation-anchors.test.ts` | Check that every mutation anchor still applies. |

Give long or parallel test runs their own `TMPDIR` and delete it afterwards. Some suites leave temporary folders behind when they are stopped early.

## How changes are judged

The evidence is local and deterministic. **The project uses no hosted CI.**

1. **Tests that pin behaviour.** Add tests for anything touching authorization, confinement, payload withholding, continuations, strict search, transport budgets, redirects or denials. Prefer tests that use a real MCP SDK client over stdio.
2. **The mutation gate.** Guarded code has mutants in `scripts/mutation-guards.mjs`. Each mutant is a deliberate weakening that a named test must catch. If you change guarded code, keep its mutants killed, or update their anchors with the same meaning. See [.agents/skills/fireboat-change-guarded-code](.agents/skills/fireboat-change-guarded-code/SKILL.md).
3. **The evals,** in both eras.
4. **The isolation suite.**
5. **Byte caps.** Tool descriptions, schemas and server instructions are measured against caps in `docs/contracts/m3b-tools.json`. A wording change needs a fresh capture, and must stay within each tool's cap.

**Never weaken a guard, oracle, budget, gate or test to make something pass.** If a test looks wrong, say so in the pull request instead of editing it.

## Files you must not hand-edit

- `docs/SUPPORT-MATRIX.md`, `docs/support-matrix.json`, `docs/QUERY-EVIDENCE.md`, `docs/COMPACT-PROFILES.md`, `docs/HOST-PROFILES.md` and `docs/QUERY-REPAIR.md`. These are generated by `scripts/generate-m3b-docs.ts`; change the generator's inputs and regenerate.
- `packages/core/src/generated/*`. These are regenerated from the pinned HL7 FHIR R4 package by the `scripts/generate-r4-*.py` scripts.
- `proposals/b2-isolation-suite-design.md`. The isolation ledger binds its exact bytes.
- `licenses/inventory.json` and `packaging/*.json`. These are approved inventories, updated only by their own tools during packaging.

## Ports and live services

- The HAPI quickstart owns `127.0.0.1:18080`. Never run the unit suite or the mutation gate while a live quickstart run is using that port.
- Live checks (`npm run test:hapi`, `npm run test:medplum`) need local Docker and pinned images. They are loopback only.

## Commits and pull requests

- Small, focused commits with a subject that says what changed. Explain why in the body.
- State the tests that pin the change. Update generated artifacts in the same change when their inputs changed.
- No unrelated reformatting.
- Never commit personal or agent-tool files. `.gitignore` covers `.claude/` (apart from the shared skills link), `.codex/`, `.muse/`, `.cursor/`, `CLAUDE.local.md` and `*.local.md`. Keep personal instructions in those local files, not in this one.
- Security issues go to the private channel in [SECURITY.md](SECURITY.md), never to a public issue.

## Skills

| Skill | When to use it |
| --- | --- |
| [fireboat-setup-and-check](.agents/skills/fireboat-setup-and-check/SKILL.md) | First run, environment problems, running the local gates. |
| [fireboat-connect-an-agent](.agents/skills/fireboat-connect-an-agent/SKILL.md) | Connecting fireboat as an MCP server to Claude Code, Claude Desktop, Codex or another host. |
| [fireboat-change-guarded-code](.agents/skills/fireboat-change-guarded-code/SKILL.md) | Changing core policy, confinement, transport, projection or delivery code, and keeping the mutation gate honest. |
| [fireboat-evals-and-isolation](.agents/skills/fireboat-evals-and-isolation/SKILL.md) | Running and reading the retrieval evals and the isolation suite. |
| [fireboat-docs-and-contract](.agents/skills/fireboat-docs-and-contract/SKILL.md) | Changing tool wording, schemas or generated reference docs. |
| [fireboat-live-hapi-quickstart](.agents/skills/fireboat-live-hapi-quickstart/SKILL.md) | Running fireboat against a local HAPI FHIR server with the synthetic seed. |
