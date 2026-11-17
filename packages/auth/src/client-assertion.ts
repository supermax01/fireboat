import { constants as fsConstants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createPrivateKey, randomBytes, sign, type KeyObject } from 'node:crypto';
import { ENV_NAME, fault } from './token-provider.js';

/** Where the client-assertion signing key comes from: exactly one of an environment variable or a private file. */
export interface AssertionKeySource { privateKeyEnv?: string; privateKeyFile?: string }
export interface AssertionKey { readonly alg: 'ES384' | 'RS384'; readonly kid: string; readonly key: KeyObject }

/** Assertion lifetime: well inside the five minutes SMART Backend Services allows. */
export const ASSERTION_LIFETIME_S = 120;
export const JWT_BEARER_ASSERTION = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const MAX_KEY_BYTES = 65_536;
const KEY_ID = /^[\x21-\x7E]{1,256}$/;

/** Configuration shape only; the key itself is read when a token is requested, never at construction. */
export function validateAssertionConfig(source: AssertionKeySource, keyId: unknown): void {
  if (typeof keyId !== 'string' || !KEY_ID.test(keyId)) throw fault('INVALID_CONFIG', 'SMART keyId is invalid.');
  const fromEnv = source.privateKeyEnv !== undefined, fromFile = source.privateKeyFile !== undefined;
  if (fromEnv === fromFile) throw fault('INVALID_CONFIG', 'Configure exactly one of privateKeyEnv or privateKeyFile.');
  if (fromEnv && (typeof source.privateKeyEnv !== 'string' || source.privateKeyEnv.length > 128 || !ENV_NAME.test(source.privateKeyEnv))) {
    throw fault('INVALID_CONFIG', 'SMART privateKeyEnv is invalid.');
  }
  if (fromFile && (typeof source.privateKeyFile !== 'string' || source.privateKeyFile.length > 4_096 || !isAbsolute(source.privateKeyFile) || source.privateKeyFile.includes('\0'))) {
    throw fault('INVALID_CONFIG', 'SMART privateKeyFile must be an absolute path.');
  }
}

/** A regular file, not a link, owned by this user, with no group or other permission bits. */
async function readKeyFile(path: string): Promise<string> {
  let handle;
  try { handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK); }
  catch { throw fault('CREDENTIAL_UNAVAILABLE', 'Configured private key file is not available.'); }
  try {
    const info = await handle.stat();
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    if (!info.isFile() || uid === undefined || info.uid !== uid || (info.mode & 0o077) !== 0) {
      throw fault('CREDENTIAL_UNAVAILABLE', 'Configured private key file must be a regular file owned by this user with no group or other access.');
    }
    if (info.size === 0 || info.size > MAX_KEY_BYTES) throw fault('CREDENTIAL_UNAVAILABLE', 'Configured private key file is not usable.');
    const bytes = await handle.readFile();
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_KEY_BYTES) throw fault('CREDENTIAL_UNAVAILABLE', 'Configured private key file is not usable.');
    return bytes.toString('utf8');
  } catch (error) {
    if (error instanceof Error && error.name === 'CredentialFault') throw error;
    throw fault('CREDENTIAL_UNAVAILABLE', 'Configured private key file is not available.');
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** EC P-384 signs ES384 and RSA of at least 2048 bits signs RS384; every other key is refused. */
export function assertionAlgorithm(key: KeyObject): 'ES384' | 'RS384' {
  if (key.type !== 'private') throw fault('CREDENTIAL_UNAVAILABLE', 'Configured signing key is not a private key.');
  const details = key.asymmetricKeyDetails ?? {};
  if (key.asymmetricKeyType === 'ec' && details.namedCurve === 'secp384r1') return 'ES384';
  const bits = details.modulusLength ?? 0;
  if (key.asymmetricKeyType === 'rsa' && bits >= 2048 && bits <= 8192) return 'RS384';
  throw fault('CREDENTIAL_UNAVAILABLE', 'Configured signing key type is not allowed (EC P-384 or RSA of at least 2048 bits).');
}

/** Parses PEM or JWK text (a leading `{`). Parse errors never carry key material outward. */
export function parsePrivateKey(text: string): KeyObject {
  if (text.length === 0 || text.length > MAX_KEY_BYTES) throw fault('CREDENTIAL_UNAVAILABLE', 'Configured private key is not available.');
  try {
    if (text.trimStart().startsWith('{')) {
      const jwk: unknown = JSON.parse(text);
      if (!jwk || typeof jwk !== 'object' || Array.isArray(jwk)) throw new Error('not an object');
      return createPrivateKey({ key: jwk as never, format: 'jwk' });
    }
    return createPrivateKey({ key: text, format: 'pem' });
  } catch {
    throw fault('CREDENTIAL_UNAVAILABLE', 'Configured private key could not be parsed.');
  }
}

/** Reads and checks the signing key for one token request, so a rotated key is picked up without a restart. */
export async function loadAssertionKey(source: AssertionKeySource, keyId: string, env: Record<string, string | undefined>): Promise<AssertionKey> {
  let text: string | undefined;
  if (source.privateKeyEnv !== undefined) text = env[source.privateKeyEnv];
  else if (source.privateKeyFile !== undefined) text = await readKeyFile(source.privateKeyFile);
  if (typeof text !== 'string' || text.length === 0) throw fault('CREDENTIAL_UNAVAILABLE', 'Configured private key is not available.');
  const key = parsePrivateKey(text);
  return { alg: assertionAlgorithm(key), kid: keyId, key };
}

const segment = (value: unknown): string => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

/**
 * A `private_key_jwt` client assertion: header `alg`, `kid`, `typ: JWT`; claims `iss` = `sub` = client id,
 * `aud` = the token endpoint exactly as it is used, `iat`, `exp` = `iat` + 120 s and a fresh random `jti`.
 * ES384 signatures use the JOSE (IEEE P1363) encoding.
 */
export function signClientAssertion(key: AssertionKey, clientId: string, audience: string, nowMs: number): string {
  const iat = Math.floor(nowMs / 1_000);
  const header = { alg: key.alg, kid: key.kid, typ: 'JWT' };
  const claims = { iss: clientId, sub: clientId, aud: audience, iat, exp: iat + ASSERTION_LIFETIME_S, jti: randomBytes(32).toString('base64url') };
  const input = `${segment(header)}.${segment(claims)}`;
  const signature = key.alg === 'ES384'
    ? sign('sha384', Buffer.from(input, 'utf8'), { key: key.key, dsaEncoding: 'ieee-p1363' })
    : sign('sha384', Buffer.from(input, 'utf8'), key.key);
  return `${input}.${signature.toString('base64url')}`;
}
