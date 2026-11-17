## What changed and why

## Checks run locally

This project has no hosted CI, so please tick only what you actually ran (Node 24.22.0, see `.nvmrc`).

- [ ] `npm run check` (not needed for prose-only changes)
- [ ] `npm run eval:retrieval` and `npm run eval:retrieval -- --era legacy`
- [ ] `npm run test:isolation`
- [ ] `node --import tsx scripts/generate-m3b-docs.ts --check` and `node --import tsx scripts/emit-m3b-contract.mjs --check` (if a generator input or tool wording changed)
- [ ] `npm run test:package` (if a document that ships in the npm package changed)

## Boundaries

- [ ] No real patient data, credentials or tokens anywhere in this change
- [ ] No FHIR writes, arbitrary URLs or headers, remote unauthenticated serving or hidden model calls
- [ ] Tool descriptions, schemas and instructions unchanged, or re-captured and still within their byte caps
- [ ] If I changed guarded code, its mutation-registry entries still apply (`node --import tsx --test tests/mutation-anchors.test.ts` passes)
- [ ] I did not hand-edit generated files
