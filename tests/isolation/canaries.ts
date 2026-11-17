/** Frozen deterministic synthetic marker dictionary. Never print matched values. */
export const CANARIES = [
  { id: 'foreign-id', segments: ['Q7bForeign83', 'R9bIdentity74', 'T6bPatient52'], kind: 'identity' },
  { id: 'foreign-detail', segments: ['V8bDetail91', 'W5bPrivate62', 'X4bRecord37'], kind: 'identity' },
  { id: 'payload', segments: ['K8payload72', 'L9payload63', 'M7payload54'], kind: 'payload' },
  { id: 'credential', segments: ['C8secret91', 'D9secret82', 'E7secret73'], kind: 'credential' },
  { id: 'a-prose', segments: ['A8prose991', 'A9family882', 'A7note773'], kind: 'permitted-prose' },
] as const;
export const A = 'synthetic-a';
export const B = CANARIES[0].segments.join('-');
export const SECRET = CANARIES[1].segments.join(' ');
export const PAYLOAD = CANARIES[2].segments.join('');
export const CREDENTIAL = CANARIES[3].segments.join('-');
export const PROSE = CANARIES[4].segments.join(' ');
export const MRN = 'urn:synthetic:b2:patient-identifiers';
export const CONTROL = 'Synthetic allowed clinical evidence';
export const FIXED_TIME = '2026-10-19T00:00:00.000Z';
export const SEED = 'b2-isolation-v1-20261019';
