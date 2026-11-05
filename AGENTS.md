# Guidance for coding agents

fireboat is a small, read-only MCP gateway for one patient's FHIR R4 records. The product contract is [PLAN.md](PLAN.md) revision 0.4.1. Current status and limits are in [README.md](README.md), [docs/M3B-STATUS.md](docs/M3B-STATUS.md) and [docs/LIMITS.md](docs/LIMITS.md). This is a synthetic-data prototype, not a release.

## Boundaries

- Keep the core policy, HTTP transport, output projection, result store and MCP adapter separate.
- Expose only implemented tools.
- No clinical writes, arbitrary HTTP requests, arbitrary URLs or headers, remote unauthenticated serving, hidden LLM calls, or real patient data in fixtures.
- Never claim SMART authorization, clinical deployment readiness, vendor support or protocol compatibility without running the relevant checks.

## Tests and evidence

- Prefer meaningful tests for authorization, patient confinement, omitted inline payloads, safe continuations, strict search, transport budgets and redirects, and actual SDK client calls.
- Compile and run the relevant tests before committing (`npm run check` runs the full local suite).
- Mutants live only in `scripts/mutation-guards.mjs`. A change to guarded code needs its mutants to stay killed by named tests.
- Do not place resource bodies, credentials or patient identifiers in ordinary logs.
