// Arms Ws and Wm: WSO2 fhir-mcp-server 0.11.0 (W's install) against the bench Medplum, with authorization on and a
// static bearer token (FHIR_SERVER_ACCESS_TOKEN, WSO2's documented stdio mode).
//   Ws: a token of the patient-scoped client of the run's patient (Medplum AccessPolicy confines it to that patient's
//       compartment, read interactions only; backend-enforced, data/medplum-clients.ts).
//   Wm: a token of the project's system-level client (no AccessPolicy).
// WSO2 has no client-credentials flow for its FHIR backend (FHIR_SERVER_CLIENT_ID/SECRET drive its MCP-level
// authorization-code proxy), so the harness obtains the token and passes it in; WSO2 itself is unchanged.
// Medplum tokens live one hour: prepareMedplumToken() refreshes before each run, command() reads the cache.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { slotPorts, type DatasetId } from '../lib/paths.js';
import type { ArmId } from '../lib/types.js';
import { MEDPLUM_FHIR_PATH, clientCredentialsToken, type TokenResponse } from '../infra/medplum.js';
import { medplumDir } from '../data/medplum-lib.js';

export const MEDPLUM_ARMS: readonly ArmId[] = ['Ws', 'Wm'];
export const isMedplumArm = (arm: ArmId): boolean => MEDPLUM_ARMS.includes(arm);
/** Arms that run WSO2 0.11.0 (same tools, adapter, parser, page size and install). */
export const WSO2_ARMS: readonly ArmId[] = ['W', 'Ws', 'Wm'];
export const isWso2Arm = (arm: ArmId): boolean => WSO2_ARMS.includes(arm);

/**
 * Slot s's recording proxy in front of Medplum: port 1824s (lib/paths.ts slotPorts, scopeProxy), so a Medplum run never
 * takes a HAPI slot's ports.
 */
export const medplumProxyPort = (slot: number) => slotPorts(slot).scopeProxy;
export const medplumProxyBase = (slot: number) => `http://127.0.0.1:${medplumProxyPort(slot)}${MEDPLUM_FHIR_PATH}`;

/** clients.json (git-ignored, under RESULTS/medplum/<dataset>/), written by bench:medplum:clients. Synthetic local stack only. */
export interface MedplumClients {
  schema: 'fbbench.medplum-clients/1';
  dataset: DatasetId;
  project_id: string;
  chosen_patient: string;
  system: { client_id: string; secret: string };
  scoped: Record<string, { client_id: string; secret: string; access_policy_id: string }>;
}

export const clientsPath = (d: DatasetId) => join(medplumDir(d), 'clients.json');

const clientsCache = new Map<DatasetId, MedplumClients>();
export function loadMedplumClients(d: DatasetId): MedplumClients {
  const hit = clientsCache.get(d);
  if (hit) return hit;
  const p = clientsPath(d);
  if (!existsSync(p)) throw new Error(`missing ${p}: run bench:medplum:clients -- --dataset ${d}`);
  const c = JSON.parse(readFileSync(p, 'utf8')) as MedplumClients; // our own file
  clientsCache.set(d, c);
  return c;
}

/** Which Medplum client an arm's run uses. Ws: the run patient's scoped client (none: the arm cannot run that patient). */
export function clientFor(arm: ArmId, clients: MedplumClients, patientId: string): { client_id: string; secret: string } {
  if (arm === 'Wm') return clients.system;
  if (arm === 'Ws') {
    const c = clients.scoped[patientId];
    if (!c) throw new Error(`no patient-scoped Medplum client for Patient/${patientId}`);
    return c;
  }
  throw new Error(`arm ${arm} does not run against Medplum`);
}

const tokens = new Map<string, TokenResponse>();
const tokenKey = (arm: ArmId, d: DatasetId, patientId: string) => (arm === 'Ws' ? `Ws|${d}|${patientId}` : `${arm}|${d}`);
/** Seconds of validity a token must still have when a run starts (a run takes well under this). */
export const TOKEN_MIN_REMAINING_S = 900;

export const tokenFresh = (t: TokenResponse | undefined, now = Date.now()): boolean =>
  !!t && now < t.obtained_at + (t.expires_in - TOKEN_MIN_REMAINING_S) * 1000;

/** Obtains (or reuses) the run's token before launch. */
export async function prepareMedplumToken(arm: ArmId, d: DatasetId, patientId: string): Promise<void> {
  const k = tokenKey(arm, d, patientId);
  if (tokenFresh(tokens.get(k))) return;
  const c = clientFor(arm, loadMedplumClients(d), patientId);
  tokens.set(k, await clientCredentialsToken(c.client_id, c.secret));
}

/** The cached token for a run; throws when prepareMedplumToken() has not run (launch then records server_start_failed). */
export function medplumTokenFor(arm: ArmId, d: DatasetId, patientId: string): string {
  const t = tokens.get(tokenKey(arm, d, patientId));
  if (!t) throw new Error(`no Medplum token prepared for ${arm} ${d} Patient/${patientId}`);
  return t.access_token;
}

/** For tests only. */
export function setMedplumTokenForTest(arm: ArmId, d: DatasetId, patientId: string, token: string): void {
  tokens.set(tokenKey(arm, d, patientId), { access_token: token, expires_in: 3600, obtained_at: Date.now() });
}

/**
 * WSO2's environment against Medplum (W's, with FHIR_SERVER_DISABLE_AUTHORIZATION unset and
 * FHIR_SERVER_ACCESS_TOKEN set). `base` is W's base environment (PATH, HOME, LANG, TMPDIR).
 */
export function wso2MedplumEnv(base: Record<string, string>, fhirBaseUrl: string, token: string): Record<string, string> {
  if (!token) throw new Error('empty Medplum access token');
  return { ...base, FHIR_SERVER_BASE_URL: fhirBaseUrl, FHIR_SERVER_ACCESS_TOKEN: token };
}

/** Environment keys whose values are credentials: never written into run records. */
export const SECRET_ENV_KEYS = ['FHIR_SERVER_ACCESS_TOKEN'] as const;
