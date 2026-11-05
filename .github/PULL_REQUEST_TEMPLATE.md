## What changed and why

## Checks run locally

- [ ] `npm run check`
- [ ] `npm run test:isolation`
- [ ] `npm run eval:retrieval` and `npm run eval:retrieval -- --era legacy`
- [ ] `node --import tsx scripts/emit-m3b-contract.mjs --check` (if a generator input changed)

## Boundaries

- [ ] No real patient data, credentials or tokens anywhere in this change
- [ ] No clinical writes, arbitrary HTTP, arbitrary URLs/headers, remote unauthenticated serving or hidden model calls
- [ ] Tool descriptions, schemas and instructions unchanged, or re-captured and still within their byte caps
- [ ] Guarded behaviour changes come with a mutation-registry update (`tests/mutation-anchors.test.ts` passes)
