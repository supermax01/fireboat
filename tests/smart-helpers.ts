// Synthetic-only SMART test harness: an in-repo authorization server and FHIR source on loopback.
// Every key, token and assertion is generated at run time; none is written in this repository.
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, verify, type KeyObject } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

export const SMART_PATIENT = 'synthetic-smart-a';
export const SMART_CLIENT = 'synthetic-backend-client';
export const SMART_KID = 'synthetic-kid-1';
export const KEY_ENV = 'FIREBOAT_TEST_SMART_PRIVATE_KEY';

export type Rec = Record<string, any>;
export interface Keys { privateKey: KeyObject; publicKey: KeyObject; pem: string; alg: 'ES384' | 'RS384' }

export function generateSigningKey(kind: 'p384' | 'p256' | 'rsa2048' | 'rsa1024' | 'ed25519' = 'p384'): Keys {
  const pair = kind === 'p384' ? generateKeyPairSync('ec', { namedCurve: 'P-384' })
    : kind === 'p256' ? generateKeyPairSync('ec', { namedCurve: 'P-256' })
    : kind === 'ed25519' ? generateKeyPairSync('ed25519')
    : generateKeyPairSync('rsa', { modulusLength: kind === 'rsa2048' ? 2048 : 1024 });
  const pem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  return { privateKey: pair.privateKey, publicKey: pair.publicKey, pem, alg: kind.startsWith('rsa') ? 'RS384' : 'ES384' };
}

export interface DecodedAssertion { header: Rec; claims: Rec; signatureValid: boolean }
export function decodeAssertion(jwt: string, publicKey: KeyObject): DecodedAssertion {
  const [h, c, s] = jwt.split('.');
  const header = JSON.parse(Buffer.from(h!, 'base64url').toString('utf8')) as Rec;
  const claims = JSON.parse(Buffer.from(c!, 'base64url').toString('utf8')) as Rec;
  const data = Buffer.from(`${h}.${c}`, 'utf8'), signature = Buffer.from(s ?? '', 'base64url');
  const signatureValid = header.alg === 'ES384' ? verify('sha384', data, { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature)
    : header.alg === 'RS384' ? verify('sha384', data, publicKey, signature) : false;
  return { header, claims, signatureValid };
}

export interface TokenRequest { form: URLSearchParams; assertion?: DecodedAssertion; rejected?: string }
export interface AuthorizationCode { code: string; challenge: string; method: string; redirectUri: string; scope: string; used: boolean }
export interface StubOptions {
  keys?: Keys;
  /** The FHIR base path; long and path-bearing by default, like a SMART Launcher simulation base. */
  basePath?: string;
  /** Edits the discovery document before it is served. */
  discovery?: (doc: Rec, origin: string) => Rec | void;
  /** Replaces the discovery response entirely. */
  discoveryReply?: (res: ServerResponse) => boolean;
  /** Edits the token response for call `n` (1-based); `requestedScope` is what the client asked for. */
  tokenReply?: (body: Rec, call: number, requestedScope: string) => Rec | { status: number; body?: Rec; headers?: Rec } | void;
  expiresIn?: number;
  /** The patient a launch/patient code exchange reports; null omits it. Defaults to SMART_PATIENT. */
  launchPatient?: string | null;
  /** The patient a refresh reports; null omits it. Defaults to the launch patient. */
  refreshPatient?: string | null;
  /** Edits the authorize redirect: return an error code, or a replacement state. */
  authorize?: (params: URLSearchParams) => { error?: string; state?: string } | void;
  /** Revoke a refresh token once it has been used (rotation that the SMART Launcher does not enforce). */
  rotateStrictly?: boolean;
  /** Awaited after a token request is recorded and before it is answered, to hold the reply. */
  holdToken?: (request: TokenRequest) => Promise<void> | void;
}

export async function startSmartStub(options: StubOptions = {}) {
  const keys = options.keys ?? generateSigningKey('p384');
  const basePath = options.basePath ?? `/v/r4/sim/${randomBytes(300).toString('base64url')}/fhir`;
  const prefix = basePath.replace(/\/fhir$/, '');
  let origin = '';
  const issued = new Set<string>();
  const usedJti = new Set<string>();
  const tokenRequests: TokenRequest[] = [];
  const fhirRequests: { url: URL; authorized: boolean }[] = [];
  let discoveryRequests = 0;
  let expiresIn = options.expiresIn;
  let grantOverride: string | undefined;
  let launchPatient = options.launchPatient === undefined ? SMART_PATIENT : options.launchPatient;
  const codes = new Map<string, AuthorizationCode>();
  const refreshTokens = new Map<string, { scope: string }>();
  const authorizeRequests: URL[] = [];
  const readBody = async (req: IncomingMessage) => { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer); return Buffer.concat(chunks).toString('utf8'); };
  const json = (res: ServerResponse, status: number, body: unknown, type = 'application/json') => { res.statusCode = status; res.setHeader('content-type', type); res.end(JSON.stringify(body)); };
  const tokenUrl = () => `${origin}${prefix}/auth/token`;
  const own = (id: string) => ({ resourceType: 'Observation', id, status: 'final', subject: { reference: `Patient/${SMART_PATIENT}` }, code: { text: 'Synthetic SMART lab' },
    valueQuantity: { value: 7.0, system: 'http://unitsofmeasure.org', code: 'mg', unit: 'mg' } });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, origin);
    if (url.pathname === `${basePath}/.well-known/smart-configuration`) {
      discoveryRequests++;
      if (options.discoveryReply?.(res)) return;
      let doc: Rec = { issuer: `${origin}${basePath}`, token_endpoint: tokenUrl(), authorization_endpoint: `${origin}${prefix}/auth/authorize`,
        grant_types_supported: ['authorization_code', 'client_credentials'], token_endpoint_auth_methods_supported: ['private_key_jwt'],
        token_endpoint_auth_signing_alg_values_supported: ['ES384', 'RS384'], code_challenge_methods_supported: ['S256'],
        scopes_supported: ['launch/patient', 'patient/*.rs'], capabilities: ['client-confidential-asymmetric', 'permission-v2'] };
      doc = options.discovery?.(doc, origin) ?? doc;
      json(res, 200, doc); return;
    }
    if (url.pathname === `${prefix}/auth/authorize` && req.method === 'GET') {
      authorizeRequests.push(url);
      const p = url.searchParams, redirect = p.get('redirect_uri');
      if (!redirect || !URL.canParse(redirect)) { res.statusCode = 400; res.end(); return; }
      const back = (params: Record<string, string>) => {
        const location = new URL(redirect);
        for (const [k, v] of Object.entries(params)) location.searchParams.set(k, v);
        res.statusCode = 302; res.setHeader('location', location.href); res.end();
      };
      const state = p.get('state') ?? '';
      // Unlike the SMART Launcher, the stub requires S256 PKCE, state, the client id and the FHIR base as aud.
      if (p.get('response_type') !== 'code' || p.get('client_id') !== SMART_CLIENT || !state || !p.get('code_challenge')
        || p.get('code_challenge_method') !== 'S256' || p.get('aud') !== `${origin}${basePath}` || !p.get('scope')) return back({ error: 'invalid_request', state });
      const edit = options.authorize?.(p) ?? {};
      if (edit.error) return back({ error: edit.error, state });
      const code = randomBytes(24).toString('base64url');
      codes.set(code, { code, challenge: p.get('code_challenge')!, method: p.get('code_challenge_method')!, redirectUri: redirect, scope: p.get('scope')!, used: false });
      return back({ code, state: edit.state ?? state });
    }
    if (url.pathname === `${prefix}/auth/token` && req.method === 'POST') {
      const form = new URLSearchParams(await readBody(req));
      const record: TokenRequest = { form };
      tokenRequests.push(record);
      await options.holdToken?.(record);
      const reject = (reason: string, error = 'invalid_client', status = 401) => { record.rejected = reason; json(res, status, { error }); };
      const grantType = form.get('grant_type');
      const assertionValid = (): boolean => {
        if (form.get('client_assertion_type') !== 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer') { reject('assertion_type'); return false; }
        let assertion: DecodedAssertion;
        try { assertion = decodeAssertion(form.get('client_assertion') ?? '', keys.publicKey); } catch { reject('assertion_malformed'); return false; }
        record.assertion = assertion;
        const { header, claims } = assertion, now = Math.floor(Date.now() / 1000);
        if (!assertion.signatureValid) { reject('signature'); return false; }
        if (header.typ !== 'JWT' || header.kid !== SMART_KID || header.alg !== keys.alg) { reject('header'); return false; }
        if (claims.iss !== SMART_CLIENT || claims.sub !== SMART_CLIENT) { reject('iss_sub'); return false; }
        if (claims.aud !== tokenUrl()) { reject('aud'); return false; }
        if (typeof claims.exp !== 'number' || typeof claims.iat !== 'number' || claims.exp <= now || claims.exp - claims.iat > 300) { reject('exp'); return false; }
        if (typeof claims.jti !== 'string' || usedJti.has(claims.jti)) { reject('jti'); return false; }
        usedJti.add(claims.jti);
        return true;
      };
      const clientValid = (): boolean => form.has('client_assertion') ? assertionValid() : form.get('client_id') === SMART_CLIENT || (reject('client_id'), false);
      let requestedScope: string, patient: string | null = null, refresh = false;
      if (grantType === 'client_credentials') {
        if (!assertionValid()) return;
        requestedScope = form.get('scope') ?? '';
      } else if (grantType === 'authorization_code') {
        if (!clientValid()) return;
        const entry = codes.get(form.get('code') ?? '');
        if (!entry) return reject('code', 'invalid_grant', 400);
        if (entry.used) return reject('code_reused', 'invalid_grant', 400);
        entry.used = true; // single use, which the SMART Launcher does not enforce
        if (form.get('redirect_uri') !== entry.redirectUri) return reject('redirect_uri', 'invalid_grant', 400);
        const verifier = form.get('code_verifier') ?? '';
        if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || createHash('sha256').update(verifier, 'ascii').digest('base64url') !== entry.challenge) return reject('pkce', 'invalid_grant', 400);
        requestedScope = entry.scope;
        const scopes = requestedScope.split(' ');
        if (scopes.includes('launch/patient')) patient = launchPatient;
        refresh = scopes.includes('offline_access');
      } else if (grantType === 'refresh_token') {
        if (!clientValid()) return;
        const presented = form.get('refresh_token') ?? '';
        const entry = refreshTokens.get(presented);
        if (!entry) return reject('refresh', 'invalid_grant', 400);
        if (options.rotateStrictly) refreshTokens.delete(presented);
        requestedScope = entry.scope;
        if (requestedScope.split(' ').includes('launch/patient')) patient = options.refreshPatient === undefined ? launchPatient : options.refreshPatient;
        refresh = true;
      } else return reject('grant_type', 'unsupported_grant_type', 400);
      const accessToken = randomBytes(24).toString('base64url');
      let body: Rec = { access_token: accessToken, token_type: 'bearer', expires_in: expiresIn ?? (grantType === 'client_credentials' ? 600 : 3600), scope: grantOverride ?? requestedScope,
        ...(patient !== null ? { patient } : {}), ...(refresh ? { refresh_token: randomBytes(24).toString('base64url') } : {}) };
      const edited = options.tokenReply?.(body, tokenRequests.length, requestedScope);
      if (edited && typeof edited.status === 'number') { for (const [k, v] of Object.entries(edited.headers ?? {})) res.setHeader(k, v as string); json(res, edited.status, edited.body ?? {}); return; }
      body = (edited as Rec | undefined) ?? body;
      if (typeof body.access_token === 'string') issued.add(body.access_token);
      if (typeof body.refresh_token === 'string') refreshTokens.set(body.refresh_token, { scope: requestedScope });
      res.setHeader('cache-control', 'no-store');
      json(res, 200, body); return;
    }
    if (url.pathname.startsWith(`${basePath}/`)) {
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
      const authorized = bearer !== undefined && issued.has(bearer);
      fhirRequests.push({ url, authorized });
      if (!authorized) { res.setHeader('www-authenticate', 'Bearer error="invalid_token"'); json(res, 401, { resourceType: 'OperationOutcome' }, 'application/fhir+json'); return; }
      const path = url.pathname.slice(basePath.length);
      if (path === '/metadata') {
        json(res, 200, { resourceType: 'CapabilityStatement', fhirVersion: '4.0.1', rest: [{ mode: 'server', resource: ['Observation', 'Encounter', 'Patient'].map(type => ({ type,
          interaction: [{ code: 'read' }, { code: 'search-type' }], searchParam: [{ name: 'patient', type: 'reference' }, ...(type === 'Observation' ? [{ name: 'encounter', type: 'reference' }] : [])] })) }] }, 'application/fhir+json');
        return;
      }
      if (path === '/Observation') {
        json(res, 200, { resourceType: 'Bundle', type: 'searchset', link: [{ relation: 'self', url: url.href }],
          entry: [own('smart-1'), own('smart-2')].map(resource => ({ resource, search: { mode: 'match' } })) }, 'application/fhir+json');
        return;
      }
      const read = /^\/Observation\/([A-Za-z0-9.-]+)$/.exec(path);
      if (read) { json(res, 200, own(read[1]!), 'application/fhir+json'); return; }
      json(res, 404, { resourceType: 'OperationOutcome' }, 'application/fhir+json'); return;
    }
    res.statusCode = 404; res.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    keys, origin, basePath, baseUrl: `${origin}${basePath}/`, tokenUrl: tokenUrl(), publicKey: createPublicKey(keys.privateKey),
    issued, tokenRequests, fhirRequests, discoveryRequests: () => discoveryRequests,
    setExpiresIn: (value: number) => { expiresIn = value; }, revokeAll: () => { issued.clear(); }, setLaunchPatient: (value: string | null) => { launchPatient = value; },
    codes, refreshTokens, authorizeRequests, grant: (scope?: string) => { grantOverride = scope; },
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
export type SmartStub = Awaited<ReturnType<typeof startSmartStub>>;

/** A gateway configuration for the stub; the key is named by environment variable only. */
export function smartConfig(stub: SmartStub, auth: Rec = {}): Rec {
  return { mode: 'synthetic', source: { alias: 'smart-stub', baseUrl: stub.baseUrl,
    auth: { type: 'smart_backend_services', clientId: SMART_CLIENT, keyId: SMART_KID, privateKeyEnv: KEY_ENV, ...auth } }, patientId: SMART_PATIENT };
}

/** A standalone-launch configuration for the stub; the grant is stored in `tokenFile` (always a test temp path). */
export function standaloneConfig(stub: SmartStub, tokenFile: string, auth: Rec = {}): Rec {
  return { mode: 'synthetic', source: { alias: 'smart-launch', baseUrl: stub.baseUrl,
    auth: { type: 'smart_standalone_launch', clientId: SMART_CLIENT, tokenFile, ...auth } }, patientId: SMART_PATIENT };
}

/** Acts as a browser that approves at once: follows the authorization URL to the stub, then its redirect to the loopback listener. */
export async function approve(authorizeUrl: string): Promise<{ location: string; status: number; headers: Headers; body: string }> {
  const first = await fetch(authorizeUrl, { redirect: 'manual' });
  const location = first.headers.get('location');
  if (first.status !== 302 || !location) throw new Error(`authorize did not redirect (${first.status})`);
  const second = await fetch(location, { redirect: 'manual' });
  return { location, status: second.status, headers: second.headers, body: await second.text() };
}
