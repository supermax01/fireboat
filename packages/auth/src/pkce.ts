import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** PKCE (RFC 7636), S256 only: a 32-byte random verifier and its SHA-256 challenge, both base64url. */
export interface PkcePair { readonly verifier: string; readonly challenge: string; readonly challengeMethod: 'S256' }

export function pkcePair(): PkcePair {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: pkceChallenge(verifier), challengeMethod: 'S256' };
}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/** 32 random bytes, base64url: the authorization request's `state`. */
export function newState(): string {
  return randomBytes(32).toString('base64url');
}

/** Constant-time comparison of the returned `state` with the one this login sent. */
export function stateMatches(expected: string, received: unknown): boolean {
  if (typeof received !== 'string') return false;
  const a = Buffer.from(expected, 'utf8'), b = Buffer.from(received, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
