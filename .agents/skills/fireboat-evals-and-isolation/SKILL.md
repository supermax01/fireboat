---
name: fireboat-evals-and-isolation
description: Run and interpret fireboat's deterministic retrieval evals (both MCP protocol eras) and the B2 patient-isolation suite. Use when verifying a change, investigating an eval failure or adding an eval task or isolation case.
---

# Evals and the isolation suite

## Retrieval evals

```sh
npm run eval:retrieval                    # modern era (2026-07-28)
npm run eval:retrieval -- --era legacy    # legacy era (2025-11-25)
```

- Each run executes the tasks in `packages/evals/` through a real MCP client in three arms (`fhir`, `compact`, `selected`). It checks exact facts, codings and quantities, decimal lexemes, ordering, provenance, coverage, withheld data, denials, outbound confinement and measured wire bytes.
- Expect `tasks 83/83 passed`. The report is written to `.local/evals/retrieval-eval-v0.json`.
- No model is called, and clinical performance is not measured. Do not describe eval results as model accuracy.
- A failure names the task and the check. Fix the code, not the expected value, unless the task itself is shown to be wrong.

## Isolation suite (B2)

```sh
npm run test:isolation
```

- The suite runs manifested attack and control cases against the patient-confinement core, with independent oracles and a counting aggregate.
- Today's expected result is `status=DIAGNOSTIC earned=0`. The release gate needs at least 200 independent counted cases, and that work is in progress. Never report the diagnostic run as isolation proof.
- `proposals/b2-isolation-suite-design.md` is bound by digest. Editing it breaks the suite (`ledger design digest differs`).
- New cases go in `tests/isolation/cases-v1.json`, following `tests/isolation/case-schema.ts`. Each case names its design obligation and needs its own independent fault that the case kills.
