---
name: fireboat-change-guarded-code
description: Change fireboat's core policy, patient confinement, transport, projection, store or delivery code without weakening its guarantees. Covers tests, the mutation registry and anchors. Use for any edit under packages/core or packages/server that affects behaviour.
---

# Change guarded code safely

The guarantees are the product: patient confinement, read-only access, exact decimals, honest coverage, bounded bytes and no arbitrary network surface. Every guard is pinned by tests, and the mutation gate proves those tests notice when a guard breaks.

## Before editing

1. Read the boundaries in `AGENTS.md`.
2. Find the guards the change touches: `grep -n "packages/core/src/<file>" scripts/mutation-guards.mjs`. Each `M(id, file, find, replace, {suites})` or `C(id, edits, …)` entry is a deliberate weakening that named tests must kill.

## While editing

- Add or extend tests that fail without the change. Prefer real SDK stdio calls (see `tests/m3b-mcp.test.ts`) and exact assertions over snapshots.
- Keep the layers separate: core policy, transport, projection, store, MCP adapter.
- Do not log resource bodies, credentials or patient identifiers.

## Keep the mutation gate honest

```sh
node --import tsx --test tests/mutation-anchors.test.ts             # every anchor still matches exactly once
node scripts/mutation-guards.mjs --only <id1>,<id2> --workers 2     # judge the mutants your change touches
node scripts/mutation-guards.mjs --list                             # list all mutant ids
```

- If you changed the guarded code text, an anchor (`find`) may stop matching. Update it to the equivalent new code with **the same meaning**. A re-anchor must weaken the same guard.
- A new guard needs a new mutant, inserted before the `// B2 machinery:` marker, plus the test that kills it.
- A mutant that survives means the tests miss a weakening. Strengthen the tests. Never delete the mutant, and never add it to `scripts/mutation-survivors.json` without a reviewed equivalence argument.
- `--only` runs are diagnostic. Acceptance needs the full sharded run (`--shard i/n`, then `--aggregate`) on an idle machine. It takes hours, so leave it to maintainers.

## Finish

Run `npm run check`, both eval eras and `npm run test:isolation`. If tool wording or schemas changed, also follow the `fireboat-docs-and-contract` skill.
