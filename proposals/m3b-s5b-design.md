# M3b S5b design: withheld-entry collapse

- **Author:** Claude (root), 2026-10-22. Implements the S5b definition in `proposals/m3b-s5-workplan.md` (S5b section) and the acceptance specifics adopted in `proposals/release-plan.md` §2.3 (GPT §4.5).
- **Baseline:** the S5 checkpoint commit on `r/s5-candidate`. Work happens in a separate worktree (`.local/worktrees/s5b`, branch `candidate/s5b`) and lands by merge after review.
- **Contract impact:** none to tool schemas, fault codes, listing bytes or the envelope spine. `transform.withheld_payloads` entries may carry `count` (already admitted by the gate's key whitelist); the gate is tightened, never loosened.

## 1. Problem

A delivered page carries one manifest entry per withheld occurrence per record. On a 20-record Observation page every record contributes identical `{path:"/meta/source", reason:"PROTECTED_LINK"}` and `{path:"/subject/display", reason:"PATIENT_REFERENCE_COMPANION_WITHHELD"}` entries: 40 entries, about 2.5 KB, 16–17% of `structuredContent`, duplicated again in the full-text channel. The C.3 target (spec Addendum C) wants provenance + withheld + coverage at ≤15% of `structuredContent`; today it is about 17%.

## 2. Rules (from the agreed S5b text)

1. Merge only **positively classified policy entries**: origin recorded at creation as policy (not attachment, not payload, not link-in-text), with exactly the keys `{path, reason}` and byte-identical safe strings.
2. Attachment and Binary entries (`V1_PAYLOAD_WITHHELD`, `PROTECTED_LINK` created under the attachment flag) stay distinct even when byte-identical and metadata-free. `PROTECTED_LINK_IN_TEXT` (carries `spans`) and any entry with metadata stay distinct. Unknown origin (no sidecar, length mismatch) is ineligible.
3. Merge happens **after final record selection**, inside `assemble()`, so every packing pop and the oversize recovery recompute it; no collapse state is stored or cached.
4. N > 1 becomes one entry `{path, reason, count: N}` (new object; stored entries are never mutated); singletons keep their shape (shared reference is fine).
5. Retained per-record omissions (`withheld_reasons`, inspect rows) are derived from the uncollapsed per-record manifests; `omitted_fields` stays the unique union.
6. Both channels disclose multiplicity exactly once: full-text-v1 carries the JSON (count inside the entry); structured-evidence-v1 prints `withheld xN: {"path":..,"reason":..}` for counted entries and `withheld: {...}` for every other entry, in array order. The current shape-only text aggregation (`delivery.ts:328-340`), which wrongly merges metadata-free attachment entries, is removed.
7. Evals count validated multiplicity (`count` when it is a safe integer ≥ 2 on an eligible shape, else 1), never raw array length.
8. Savings are measured, not assumed; a C.3 miss is published as a miss and does not change defaults.

## 3. Implementation

### 3.1 Origin sidecar (privacy.ts)

`Sanitized` gains `manifestOrigins: ManifestOrigin[]` aligned with `manifests` (`'policy' | 'attachment' | 'payload' | 'link_text' | 'unknown'`). The walk carries two attachment flags: the pre-existing `attachment` (schema, shape or path spelling; conservative) keeps driving withholding and attachment metadata, and the new `inAttachment` (schema-declared Attachment context, own or inherited by every descendant) drives only the origin. String sites: payload keys are `'payload'`; prose link spans are `'link_text'`; a withheld link is `'attachment'` inside a schema Attachment, `'unknown'` when the attachment context is shape- or spelling-inferred or the site has no schema element, else `'policy'`. Node and child withholds pass `'policy'` when the site's schema element resolves and `'unknown'` otherwise (undeclared properties, companions under an undeclared reference-like node, shared-reference reasons on unresolved nodes). Only `'policy'` entries collapse; `'unknown'` is ineligible, as the adopted S5b text requires ("path spelling alone never classifies attachments"). The default parameter stays `'policy'` so the anchored shared-scope call sites (whose elements resolve by construction) are textually unchanged. `withhold()` and the `:429` push sit inside the `privacy-projection-only` anchor span, so that one registry entry is migrated (find and replace updated to the new text) with an A2 row; no other anchor moves.

The array is enumerable on `Sanitized`, so it is part of the retained blob and counted by the ledger (honest accounting; a few bytes per record). Quota-sensitive tests at 256 B retention are re-measured.

### 3.2 Collapse (index.ts `assemble()`)

Replace `withheld_payloads: selected.flatMap(item => item.record.manifests)` with `collapseWithheld(selected.map(item => item.record))`, a pure exported helper in `projection.ts`:

- walk records in order, entries in order; for an entry at index i with `origins[i] === 'policy'` and keys exactly `{path, reason}`, bucket by `path + '\u0000' + reason` (first-occurrence position retained); everything else is pushed through as-is;
- buckets with N ≥ 2 emit one new object `{ path, reason, count: N }` at the first occurrence's position; N = 1 emits the original entry;
- missing/short `manifestOrigins` makes every entry of that record ineligible.

`pendingBound` (`:998`) stays as the conservative uncollapsed estimate (collapse only shrinks).

### 3.3 Text channel (delivery.ts `withheldLines`)

One line per delivered entry in array order; counted entries print `withheld xN: <json without count>`; no re-aggregation. `delivery-profiles.test.ts:231-248` migrates: three policy entries collapse (count 3) and print one `x3` line; three metadata-free attachment entries print three lines.

### 3.4 Gate (contracts.ts, new rules between the manifest-key rule and `:574`)

`count`, when present, must be a safe integer ≥ 2 and the entry's keys must be exactly `path`, `reason`, `count`. Review additions: a `count` never travels with `V1_PAYLOAD_WITHHELD` or `PROTECTED_LINK_IN_TEXT` (reasons only the payload and in-text-link sites emit), and one counted `{path, reason}` pair is delivered at most once. Uncounted duplicates legitimately remain (ineligible origins). Inspect envelopes keep `withheld_payloads: []`.

### 3.5 Evals (runner.ts `withheld`)

`all.length` becomes the sum of `multiplicity(entry)`; a direct `evaluateCheck` unit test covers count, singleton and malformed count. Tasks unchanged (single-record reads).

### 3.6 Registry

- Migrate `privacy-projection-only` (find/replace updated to the new sanitize text).
- New mutants (ids as in the integration plan A2 row): `collapse-counts-undelivered` (collapse computed from the snapshot records instead of `selected`), `collapse-merges-attachment` (attachment and payload origins treated as policy), `collapse-drops-count` (count omitted from merged entries), `collapse-drops-reason` (same-path entries merge across reasons), `gate-count-singleton` (gate accepts `count: 1`), `gate-count-on-payload-reason`, `gate-counted-pair-duplicate`, `origin-payload-as-policy`, `origin-attachment-link-as-policy`, `origin-unknown-site-as-policy`, `origin-spelling-attachment-as-policy`, `origin-companion-unknown-as-policy` (creation-site origin tags), `text-double-counted` (count repeated inside the quoted JSON). Each with `--only` evidence and A2 rows; `hashes.mutants` refreshed last.

### 3.7 Measurement

`scripts/measure-withheld-collapse.ts`: render the 20- and 100-record synthetic Observation pages (policy-only, and attachment-heavy with a schema Attachment url + metadata-free payload and an unknown-origin vendor link per record) through the real gateway in both profiles and eras. Full-text: before and after (expanded twin), structuredContent bytes, result bytes, the withheld share. Structured-evidence: result bytes, line counts and the attachment-line growth against a merged-line equivalent (the S5 shape-only aggregator is gone). Results go in `proposals/audit/s5b-measurements.md`.

## 4. Tests to add or migrate

- Collapse helper: same path/reason across records (N=2, N=20), singleton shape, attachment and payload never merge, metadata entries never merge, `link_text` never merges, missing sidecar ineligible, within-record duplicates merge, order stability, new-object invariant (stored entries unchanged).
- Rendering: both channels agree on multiplicity; full-text and structured-evidence lanes; `fhir_result` project/page views; inspect rows unchanged.
- Packing: counts follow the delivered records under a byte ceiling and the collapsed page is smaller than its expanded twin (the packer's pre-existing estimate bound decides how many records fit, so "fits only after collapse" is not a reachable property); oversize recovery keeps counts bound to what was delivered.
- Gate: `count: 1`, `count` with metadata, `count` with extra keys, `count` on a payload or in-text-link reason, and a duplicated counted pair all rejected; valid counted entry accepted.
- Origins: every creation site pinned through `sanitize` (schema Attachment url/data/inherited link, extension payload, prose link, schema-less site, spelling-only attachment, undeclared reference companion, undeclared shared property).
- Evals: `withheld` check with counted entries.
- Isolation PAY-01 and INJ-03 unchanged and green.

## 5. Acceptance

`npm run check`, isolation 76/76, both eval eras, demos and controls, contract `--check` (unchanged generator), `--only` evidence for every new or migrated mutant, the full 14-shard aggregate on the merged commit, the measurement report, and an independent review pass before merge. C.3 may miss; defaults stay FHIR/full-text either way.

## 6. Implementation record (2026-10-22, branch `candidate/s5b`)

- `packages/core/src/privacy.ts`: `ManifestOrigin` (with `unknown`) and the aligned `manifestOrigins` sidecar; the walk carries the schema-declared `inAttachment` context beside the conservative `attachment` flag; `withhold()` takes an origin (default `policy`); payload, attachment-context link, in-text-link, schema-less, undeclared-property and companion sites tag their origin (§3.1). The `privacy-projection-only` registry anchor was migrated to the new text twice (same three insertions; final anchor line 410, sha256 `4bf3d300…`).
- `packages/core/src/withheld.ts` (new): `collapseWithheld` and `withheldMultiplicity`.
- `packages/core/src/index.ts`: the assembly copy site uses `collapseWithheld(selected.map(item => item.record))`; re-exports the helpers.
- `packages/core/src/delivery.ts`: `withheldLines` prints one line per delivered entry, `withheld xN:` for counted entries with the count removed from the quoted JSON; the shape-only aggregation is gone.
- `packages/core/src/contracts.ts`: a `count` is ≥ 2, travels only with `path` and `reason`, never with a payload or in-text-link reason, and one counted pair is delivered at most once.
- `packages/evals/src/runner.ts`: the `withheld` check sums validated multiplicity through its own one-line transcription of the count rule (independent of `core/src/withheld.ts`).
- Tests: `tests/s5b-withheld-collapse.test.ts` (helper units including same-path/different-reason and every ineligible shape, every creation-site origin through `sanitize`, a 20-record SDK page in both eras and both delivery profiles with compact format, retained project/page/inspect views and gate negatives, a same-path/different-reason Organization page, byte-ceiling and oversize-recovery consistency with the expanded twin, eval multiplicity); `tests/delivery-profiles.test.ts` migrated.
- Registry (§3.6): thirteen S5b mutants; `hashes.mutants` refreshed last.
- Measurement (`scripts/measure-withheld-collapse.ts`, `proposals/audit/s5b-measurements.md`): full-text policy-only pages shrink 22.0% (N=20) and 25.7% (N=100) in structuredContent and 21.7–25.5% in result bytes, the withheld share dropping from 23–26% to 0.4–1.8%; attachment-heavy pages (one schema Attachment url + payload and one unknown-origin link per record, none collapsible) shrink 14.9–16.8%. Structured-evidence text is unchanged on policy-only pages and grows 12.5–14.4% on attachment-heavy pages (one line per attachment entry instead of S5's origin-blind merged `xN` line). This is the synthetic fixture, not the C.3 frozen stratum; C.3 is measured at S11.

### 6.2 Verification before commit (2026-10-22, root-run on Node 24.22.0, macOS arm64, 12 CPUs, with the 750c611 shard run and the S6 judge sharing the machine)

| Check | Result |
| --- | --- |
| `npm run check` | typecheck clean; 1,909 node tests: 1,907 pass, 2 S6 TODO, 0 fail; build with the compiled-identity check |
| Retrieval evals, both eras | per era 207 pass / 15 `pending_profile_proof` / 0 fail (69/74 tasks per arm); 215/221 comparable checks per arm; 0/291 byte-accounting deviations |
| `npm run test:isolation` | 76/76 (68 diagnostic cases, 0 counted) |
| Contract `--check` | in sync |
| `npm run demo` | completes on synthetic data |
| Registry (`--only`, 1 worker × 2) | 13 of 13 new S5b mutants killed with named, reproduced failures (12 on the first run; `origin-spelling-attachment-as-policy` on the re-judge after the schema-known Extension case was added); the two migrated anchors (`privacy-projection-only`, `privacy-undeclared-path-raw`) verified exact-once; evidence rows in `proposals/audit/a2-anchor-migration.tsv`; raw reports in the gitignored `.local/s5b-only/` |

Not run on this tree: the official 14-shard aggregate (it runs on the merged `r/s5-candidate` commit together with S6), CI, any live backend.

### 6.1 Independent review (Opus adversarial pass, 2026-10-22, staged diff on 750c611)

No high finding. Dispositions:

| # | Severity | Finding | Decision |
| --- | --- | --- | --- |
| 1 | Medium | Schema-unknown sites and links under Attachment elements were classified by key spelling (`/vendorDocument/url` collapsed; `/presentedForm/0/extension/0/valueUrl` was `policy` while `/valueAttachment/extension/0/valueUrl` was `attachment`), against the adopted text. | **Fixed:** `unknown` origin for schema-less sites and spelling-only attachment context; schema Attachment context inherited by descendants; companions and undeclared properties tagged explicitly. Pinned through `sanitize` for every site. |
| 2 | Medium | Creation-site origin tags (payload, attachment-context link) were untested; mutating them passed every test and the gate. | **Fixed:** origin tests per site, a page with identical metadata-free payload and unknown-origin entries, the gate reason rule, and five `origin-*` mutants. |
| 3 | Medium | The "dropped reasons" mutant was missing; keying the collapse by path alone passed. | **Fixed:** same-path/different-reason tests (helper and Organization page, both channels), `collapse-drops-reason` and `text-double-counted` mutants. |
| 4 | Low | The gate admitted counts on payload/in-text-link reasons and duplicated counted pairs. | **Fixed:** two gate rules, pinned on real envelopes, two mutants. |
| 5 | Low | Mutant ids differed from the integration plan; the A2 row for `privacy-projection-only` still said unchanged. | **Fixed:** ids renamed to the plan's; A2 rows written with the `--only` evidence. |
| 6 | Low | Compact format, `fhir_result` page, the structured profile through the gateway, oversize recovery and a page that fits only after collapse were untested; the spans negative tested a pre-existing rule. | **Fixed** (all but one): compact, page action, structured profile and oversize recovery pinned; the spans negative uses `PROTECTED_LINK_IN_TEXT`; `keyOnly`/short-sidecar pinned. "Fits only after collapse" is not reachable: the packer's pre-existing estimate bound decides how many records fit; the test asserts the expanded twin is larger instead. |
| 7 | Low | Measurement covered full-text only; structured text grows on attachment-heavy pages. | **Fixed:** both profiles and an attachment-heavy page measured and recorded. |
| 8 | Low | Stale docstring (`renderV2`) and `docs/S5-STATUS.md` text. | **Fixed.** |
| 9 | Low | The eval runner imported the producer's multiplicity helper. | **Fixed:** inlined transcription. |
