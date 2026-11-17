// Medplum backend for arms Ws and Wm: a FHIR server that enforces patient scope itself (an AccessPolicy per client), so
// WSO2 can be shown with a backend-enforced patient scope. Separate from the HAPI stack: own compose project, own port, own
// volume, own manifests. compose file: infra/medplum/compose.yaml (tests/medplum.test.ts keeps the two in agreement).
// Every credential here is a public synthetic bootstrap value of a disposable loopback stack, never a real secret.
import { fileURLToPath } from 'node:url';
import { parseLossless, type LosslessValue } from '../lib/json.js';
import { run } from './manifest.js';

export const MEDPLUM_COMPOSE_PROJECT = 'fbbench-medplum';
/** Next to this module (not under lib/paths.ts BENCH), so a worktree starts its own copy. */
export const MEDPLUM_COMPOSE_FILE = fileURLToPath(new URL('./medplum/compose.yaml', import.meta.url));
/** Bench-reserved range, unused by HAPI (18190), the slot ports (1821s-1824s) and fireboat's own Medplum test stack (18103). */
export const MEDPLUM_PORT = 18195;
export const MEDPLUM_ORIGIN = `http://127.0.0.1:${MEDPLUM_PORT}`;
export const MEDPLUM_FHIR_PATH = '/fhir/R4';
export const MEDPLUM_FHIR_BASE = `${MEDPLUM_ORIGIN}${MEDPLUM_FHIR_PATH}`;
export const MEDPLUM_TOKEN_URL = `${MEDPLUM_ORIGIN}/oauth2/token`;
export const MEDPLUM_VOLUME = 'fbbench-medplum-pg-synthea-dev';
/** Only Synthea development data is loaded into Medplum (no MIMIC). */
export const MEDPLUM_DATASETS = ['synthea-dev'] as const;

/** The same three images, by digest, as docker/compose.medplum.yaml in the repository (fireboat's own Medplum test stack). */
export const MEDPLUM_IMAGES = {
  medplum: 'medplum/medplum-server@sha256:2968c9aeb85d03968370855a5dc409a6f28ef5abda0996e353be06c525b61216',
  postgres: 'postgres@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea',
  redis: 'redis@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499',
} as const;
/** The version in packages/server/package.json inside the medplum image; bench:medplum:up checks /healthcheck. */
export const MEDPLUM_EXPECTED_VERSION = '5.2.6';

/** Synthetic bootstrap super-admin client (docker/compose.medplum.yaml values). Used only by the loader and client setup. */
export const MEDPLUM_BOOTSTRAP = {
  clientId: '11111111-1111-4111-8111-111111111111',
  clientSecret: 'synthetic_bootstrap_only_never_use_for_real_data',
} as const;

/** Non-default Medplum settings, recorded in manifests/medplum-infra.json. Everything else is the image default. */
export const MEDPLUM_SETTINGS = {
  MEDPLUM_MAX_JSON_SIZE: '8mb', // default 1mb; one Synthea Provenance is 1.65 MB
  MEDPLUM_RATE_LIMITS_ENABLED: 'false', // default true; the per-user FHIR quota throttles a bulk load
  MEDPLUM_REGISTER_ENABLED: 'false',
  MEDPLUM_EMAIL_PROVIDER: 'none',
  MEDPLUM_BASE_URL: `${MEDPLUM_ORIGIN}/`,
} as const;

export async function medplumCompose(args: readonly string[]) {
  return run('docker', ['compose', '-p', MEDPLUM_COMPOSE_PROJECT, '-f', MEDPLUM_COMPOSE_FILE, ...args], { timeoutMs: 900_000 });
}

/** Refuses any URL that is not on the Medplum loopback origin (setup requests never leave it). */
export function medplumUrl(path: string): URL {
  const u = new URL(path, `${MEDPLUM_ORIGIN}/`);
  if (u.origin !== MEDPLUM_ORIGIN) throw new Error(`refusing a request outside ${MEDPLUM_ORIGIN}`);
  return u;
}

export interface TokenResponse { access_token: string; expires_in: number; obtained_at: number }

/** OAuth client credentials against the Medplum token endpoint (form body, HTTP Basic client authentication). */
export async function clientCredentialsToken(clientId: string, clientSecret: string): Promise<TokenResponse> {
  const obtainedAt = Date.now();
  const res = await fetch(MEDPLUM_TOKEN_URL, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: { authorization: `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Medplum token request for client ${clientId} rejected (HTTP ${res.status}): ${text.slice(0, 300)}`);
  const body = JSON.parse(text) as { access_token?: unknown; expires_in?: unknown }; // OAuth response, not FHIR data
  if (typeof body.access_token !== 'string') throw new Error('Medplum token response has no access_token');
  return { access_token: body.access_token, expires_in: typeof body.expires_in === 'number' ? body.expires_in : 3600, obtained_at: obtainedAt };
}

export interface MedplumResponse { status: number; body: LosslessValue | null; text: string }

/** One request to the Medplum origin with a bearer token. Never throws on an HTTP status; the body is lossless-parsed. */
export async function medplumRequest(path: string, token: string | null, init: { method?: string; body?: string; timeoutMs?: number; contentType?: string } = {}): Promise<MedplumResponse> {
  const res = await fetch(medplumUrl(path), {
    method: init.method ?? 'GET', redirect: 'error', signal: AbortSignal.timeout(init.timeoutMs ?? 120_000),
    headers: {
      accept: 'application/fhir+json, application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.body !== undefined ? { 'content-type': init.contentType ?? 'application/fhir+json' } : {}),
    },
    ...(init.body !== undefined ? { body: init.body } : {}),
  });
  const text = await res.text();
  let body: LosslessValue | null = null;
  try { body = text ? parseLossless(text) : null; } catch { body = null; }
  return { status: res.status, body, text };
}

/** GET /healthcheck: {ok, version, postgres, redis}. null when Medplum is not reachable. */
export async function medplumHealth(): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(medplumUrl('/healthcheck'), { redirect: 'error', signal: AbortSignal.timeout(5000) });
    const text = await res.text();
    if (!res.ok) return null;
    return JSON.parse(text) as Record<string, unknown>; // Medplum's own status JSON, not FHIR data
  } catch {
    return null;
  }
}
