import { isAbsolute } from 'node:path';
import { controlledFetch, type HttpFetch } from '../../core/src/transport.js';
import { JWT_BEARER_ASSERTION, loadAssertionKey, signClientAssertion, validateAssertionConfig, type AssertionKey, type AssertionKeySource } from './client-assertion.js';
import { newState, pkcePair, stateMatches } from './pkce.js';
import { checkDiscoveredEndpoint, discoverSmartConfiguration, discoveryOutcome, type SmartConfiguration } from './smart-discovery.js';
import { assessGrant, requestedScopes, validateScopeOverrides, type GrantAssessment, type ScopeSyntax } from './smart-scopes.js';
import { bindingMatches, defaultTokenFile, prepareGrantDirectory, readTokenFile, withGrantLock, writeTokenFile, type GrantBinding, type LockHeld, type StoredGrant } from './token-store.js';
import { abortFault, BEARER_TOKEN, CredentialFault, fault, MAX_TOKEN_LENGTH, parseLoopbackUrl, TokenProvider, type CachedToken, type GrantedInteraction,
  type SmartDoctorStatus, type TokenProviderOptions } from './token-provider.js';

export interface SmartStandaloneLaunchConfig {
  type: 'smart_standalone_launch';
  clientId: string;
  clientAuth?: 'public' | 'private_key_jwt';
  keyId?: string;
  privateKeyEnv?: string;
  privateKeyFile?: string;
  redirectPort?: number;
  offlineAccess?: boolean;
  tokenFile?: string;
  scopes?: string[];
  scopeSyntax?: ScopeSyntax;
  endpoints?: { authorization?: string; token?: string };
}

/** Internal wiring and test injections; not part of public gateway config. */
export interface SmartStandaloneOptions extends TokenProviderOptions {
  fetchFn?: HttpFetch;
  env?: Record<string, string | undefined>;
  /** The configured patient: the code exchange must name exactly this patient, and a refresh that names one must too. */
  patientId: string;
  servedTypes: readonly string[];
  /** Names the default token file. */
  alias: string;
  onGrantChanged?: () => void;
}

/** Why `fireboat login` failed, beyond the shared credential fault codes. Never carries request data. */
export type LoginCode = 'PKCE_UNSUPPORTED' | 'AUTHORIZATION_DENIED' | 'CALLBACK_INVALID' | 'CALLBACK_TIMEOUT'
  | 'LISTENER_UNAVAILABLE' | 'PATIENT_CONTEXT_MISSING' | 'PATIENT_MISMATCH';
export class LoginFault extends Error {
  constructor(readonly code: LoginCode) { super(code); this.name = 'LoginFault'; }
}
/** Why a sign-in callback listener stopped without an accepted callback. Never carries request data. */
export class CallbackFault extends Error {
  constructor(readonly code: 'CALLBACK_TIMEOUT' | 'LISTENER_UNAVAILABLE' | 'LISTENER_CLOSED') { super(code); this.name = 'CallbackFault'; }
}
/** The one-shot redirect listener `fireboat login` provides (it lives in the login command, never in the serving process). */
export interface CallbackListener {
  readonly host: string;
  readonly port: number;
  readonly redirectUri: string;
  /** The query of the first callback that `accept` admitted. */
  readonly result: Promise<URLSearchParams>;
  close(): void;
}
export interface LoginIo {
  /** Starts the one-shot loopback redirect listener; only a callback `accept` admits (the exact state) completes it. */
  listen(port: number, timeoutMs: number, accept: (params: URLSearchParams) => boolean): Promise<CallbackListener>;
  /** Shows the authorization URL (it carries state and the PKCE challenge only) and may open a browser. */
  onAuthorizeUrl(url: URL): void;
  timeoutMs: number;
}
export interface LoginResult {
  scope: 'exact' | 'broader' | 'narrower';
  grantedTypes: number;
  servedTypes: number;
  refresh: boolean;
  warnings: string[];
}

const CONFIG_KEYS = new Set(['type', 'clientId', 'clientAuth', 'keyId', 'privateKeyEnv', 'privateKeyFile', 'redirectPort', 'offlineAccess', 'tokenFile', 'scopes', 'scopeSyntax', 'endpoints']);
const CODE = /^[\x21-\x7E]{1,4096}$/;
const refreshShape = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= MAX_TOKEN_LENGTH && BEARER_TOKEN.test(value);
const relation = (grant: GrantAssessment): LoginResult['scope'] => grant.narrower ? 'narrower' : grant.broader ? 'broader' : 'exact';

/**
 * SMART standalone patient launch. `signIn` runs only in `fireboat login`: discovery, PKCE S256, the one-shot loopback
 * redirect, the code exchange and the token file. The serving process never signs in: it reads the token file, refreshes
 * when it holds a refresh token, and otherwise reports CONNECTION_REQUIRED. The configured patient stays the authority;
 * the token's patient context is an extra precondition, never a selector.
 */
export class SmartStandaloneProvider extends TokenProvider {
  private readonly source: URL;
  private readonly sourceBaseUrl: string;
  private readonly clientId: string;
  private readonly keyId?: string;
  private readonly keySource?: AssertionKeySource;
  private readonly resourceScopes: readonly string[];
  private readonly requestScope: string;
  private readonly servedTypes: readonly string[];
  private readonly pins: { authorization?: URL; token?: URL };
  private readonly patientId: string;
  readonly tokenFile: string;
  readonly redirectPort: number;
  private readonly offlineAccess: boolean;
  private readonly fetchFn: HttpFetch;
  private readonly env: Record<string, string | undefined>;
  private readonly onGrantChanged?: () => void;
  private grant: GrantAssessment | null = null;
  /** The access token this process last served; distrusted once the source rejected it. */
  private servedAccess?: string;
  private distrusted?: string;
  /**
   * Stops a sign-in in progress when the provider closes: its discovery, code exchange and wait for the grant lock. The
   * wait for the browser callback is not stopped; it ends on the listener's own timeout. Cleared when the sign-in ends.
   */
  private signingIn?: AbortController;

  constructor(sourceBaseUrl: string, config: SmartStandaloneLaunchConfig, options: SmartStandaloneOptions) {
    super(sourceBaseUrl);
    this.source = new URL(sourceBaseUrl);
    this.sourceBaseUrl = sourceBaseUrl;
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw fault('INVALID_CONFIG', 'Credential configuration is invalid.');
    for (const key of Object.keys(config)) {
      if (!CONFIG_KEYS.has(key)) throw fault('INVALID_CONFIG', 'Credential configuration contains an unsupported field.');
    }
    if (config.type !== 'smart_standalone_launch') throw fault('INVALID_CONFIG', 'Credential configuration type is invalid.');
    if (typeof config.clientId !== 'string' || config.clientId.length === 0 || config.clientId.length > 256 || /[\s\x00-\x1F\x7F]/.test(config.clientId)) {
      throw fault('INVALID_CONFIG', 'Credential configuration clientId is invalid.');
    }
    this.clientId = config.clientId;
    const clientAuth = config.clientAuth ?? 'public';
    if (clientAuth === 'private_key_jwt') {
      validateAssertionConfig(config, config.keyId);
      this.keyId = config.keyId;
      this.keySource = config.privateKeyEnv !== undefined ? { privateKeyEnv: config.privateKeyEnv } : { privateKeyFile: config.privateKeyFile };
    } else if (clientAuth !== 'public' || config.keyId !== undefined || config.privateKeyEnv !== undefined || config.privateKeyFile !== undefined) {
      throw fault('INVALID_CONFIG', 'A public SMART client takes no signing key.');
    }
    if (config.redirectPort !== undefined && (!Number.isInteger(config.redirectPort) || (config.redirectPort !== 0 && (config.redirectPort < 1024 || config.redirectPort > 65_535)))) {
      throw fault('INVALID_CONFIG', 'SMART redirectPort is invalid.');
    }
    this.redirectPort = config.redirectPort ?? 0;
    if (config.offlineAccess !== undefined && typeof config.offlineAccess !== 'boolean') throw fault('INVALID_CONFIG', 'SMART offlineAccess is invalid.');
    this.offlineAccess = config.offlineAccess === true;
    const syntax = config.scopeSyntax ?? 'v2';
    if (syntax !== 'v1' && syntax !== 'v2') throw fault('INVALID_CONFIG', 'SMART scopeSyntax is invalid.');
    if (!Array.isArray(options?.servedTypes) || options.servedTypes.length === 0) throw fault('INVALID_CONFIG', 'Served resource types are required.');
    this.servedTypes = [...options.servedTypes];
    this.resourceScopes = config.scopes === undefined ? requestedScopes('patient', this.servedTypes, syntax) : validateScopeOverrides(config.scopes, 'patient', syntax, this.servedTypes);
    // The patient context only comes back when launch/patient is requested; offline_access only when the operator opts in.
    this.requestScope = ['launch/patient', ...this.resourceScopes, ...(config.offlineAccess ? ['offline_access'] : [])].join(' ');
    const pins: { authorization?: URL; token?: URL } = {};
    if (config.endpoints !== undefined) {
      if (!config.endpoints || typeof config.endpoints !== 'object' || Array.isArray(config.endpoints) || Object.keys(config.endpoints).some(key => key !== 'token' && key !== 'authorization')) {
        throw fault('INVALID_CONFIG', 'SMART endpoints are invalid.');
      }
      if (config.endpoints.token !== undefined) pins.token = parseLoopbackUrl(config.endpoints.token, 'SMART token endpoint');
      if (config.endpoints.authorization !== undefined) pins.authorization = parseLoopbackUrl(config.endpoints.authorization, 'SMART authorization endpoint');
    }
    this.pins = pins;
    if (typeof options.patientId !== 'string' || options.patientId.length === 0) throw fault('INVALID_CONFIG', 'Patient binding is required.');
    this.patientId = options.patientId;
    this.env = options.env ?? process.env;
    if (config.tokenFile !== undefined) {
      if (typeof config.tokenFile !== 'string' || !isAbsolute(config.tokenFile) || config.tokenFile.length > 4_096 || config.tokenFile.includes('\0')) {
        throw fault('INVALID_CONFIG', 'SMART tokenFile must be an absolute path.');
      }
      this.tokenFile = config.tokenFile;
    } else this.tokenFile = defaultTokenFile(options.alias, this.env);
    // Never ambient fetch in production: the controlled client ignores NODE_USE_ENV_PROXY/HTTP(S)_PROXY.
    this.fetchFn = options.fetchFn ?? controlledFetch;
    this.onGrantChanged = options.onGrantChanged;
    this.configureTokenOptions(options);
  }

  allows(resourceType: string, interaction: GrantedInteraction): boolean {
    return this.grant?.permits.get(resourceType)?.has(interaction) === true;
  }

  override close(): void {
    super.close();
    this.signingIn?.abort();
  }

  /** A rejected access token is never served again from the file; the next acquisition refreshes or asks for a login. */
  override invalidate(generation?: number): boolean {
    const served = this.servedAccess;
    const invalidated = super.invalidate(generation);
    if (invalidated && served !== undefined) this.distrusted = served;
    return invalidated;
  }

  private discover(signal: AbortSignal): Promise<SmartConfiguration> {
    return discoverSmartConfiguration(this.source, { fetchFn: this.fetchFn, onRequest: this.onRequest, timeoutMs: this.timeoutMs, signal, pins: this.pins, flow: 'standalone_launch' });
  }

  private expectedBinding(tokenEndpoint: string): GrantBinding {
    return { sourceBaseUrl: this.sourceBaseUrl, tokenEndpoint, clientId: this.clientId, patientId: this.patientId };
  }

  /** The stored grant, refused unless it is bound to this source, client, patient and an allowed token endpoint. */
  private async stored(): Promise<StoredGrant> {
    const grant = await readTokenFile(this.tokenFile);
    if (!grant) throw fault('CONNECTION_REQUIRED', 'No stored SMART grant; run fireboat login.');
    return this.bound(grant);
  }

  private bound(grant: StoredGrant): StoredGrant {
    let endpoint: URL;
    try { endpoint = checkDiscoveredEndpoint(grant.binding.tokenEndpoint, 'token_endpoint', this.source, this.pins.token); }
    catch { throw fault('CONNECTION_REQUIRED', 'The stored SMART grant is bound to another token endpoint; run fireboat login.'); }
    if (!bindingMatches(grant.binding, this.expectedBinding(endpoint.href))) throw fault('CONNECTION_REQUIRED', 'The stored SMART grant is bound to another source, client or patient; run fireboat login.');
    return grant;
  }

  private assess(scope: unknown): GrantAssessment {
    return assessGrant(scope, this.resourceScopes, 'patient', this.servedTypes);
  }

  private adoptGrant(grant: GrantAssessment, accessToken: string): void {
    const changed = this.grant !== null && this.grant.scope !== grant.scope;
    this.grant = grant;
    this.servedAccess = accessToken;
    if (changed) this.onGrantChanged?.();
  }

  private async clientAuthentication(tokenEndpoint: URL, key?: AssertionKey): Promise<Record<string, string>> {
    if (!this.keySource) return { client_id: this.clientId };
    const signing = key ?? await loadAssertionKey(this.keySource, this.keyId!, this.env);
    return { client_assertion_type: JWT_BEARER_ASSERTION, client_assertion: signClientAssertion(signing, this.clientId, tokenEndpoint.href, this.now()) };
  }

  protected async request(generation: number, signal: AbortSignal): Promise<CachedToken> {
    return this.fromStored(generation, signal, await this.stored(), 2);
  }

  /** `rereads` bounds how many times a grant another process replaced is adopted before asking for a login. */
  private async fromStored(generation: number, signal: AbortSignal, stored: StoredGrant, rereads: number): Promise<CachedToken> {
    if (stored.accessToken !== this.distrusted) {
      const usableUntil = this.usableUntil(stored.issuedAt, stored.expiresAt);
      if (this.now() < usableUntil) {
        const grant = this.assess(stored.scope);
        const token = this.commitUntil(generation, stored.accessToken, usableUntil);
        this.adoptGrant(grant, stored.accessToken);
        return token;
      }
    }
    // A refresh token is used only when the operator opted in to offline access.
    if (stored.refreshToken === undefined || !this.offlineAccess) throw fault('CONNECTION_REQUIRED', 'The stored SMART grant has expired; run fireboat login.');
    return this.refresh(generation, signal, stored, rereads);
  }

  private async refresh(generation: number, signal: AbortSignal, stored: StoredGrant, rereads: number): Promise<CachedToken> {
    const outcome = await withGrantLock(this.tokenFile, async (held): Promise<{ token: CachedToken } | { changed: StoredGrant } | { rejected: true }> => {
      // Under the lock the file is the authority: a concurrent login or another server may have replaced the grant,
      // and a logout may have removed it (then this refresh stops here and writes nothing).
      const current = await this.stored();
      if (current.accessToken !== stored.accessToken || current.refreshToken !== stored.refreshToken) return { changed: current };
      return this.refreshLocked(generation, signal, current, held);
    }, { signal });
    if ('token' in outcome) return outcome.token;
    // Adopting a grant another process stored can mean refreshing again under a new wait for the lock: a closed provider
    // or a cancelled flight stops here instead.
    this.stopIfDone(signal);
    if ('changed' in outcome) {
      if (rereads > 0) return this.fromStored(generation, signal, outcome.changed, rereads - 1);
      throw fault('CONNECTION_REQUIRED', 'The stored SMART grant keeps changing; run fireboat login.');
    }
    // Rejected: a login may be storing a fresh grant right now, so re-read the file once more.
    if (rereads > 0) {
      const current = await this.stored();
      if (current.refreshToken !== stored.refreshToken || current.accessToken !== stored.accessToken) return this.fromStored(generation, signal, current, rereads - 1);
    }
    throw fault('CONNECTION_REQUIRED', 'The stored SMART grant was rejected; run fireboat login.');
  }

  /** Throws the provider's fault when it was closed, or the cancellation fault when `signal` was aborted. */
  private stopIfDone(signal: AbortSignal): void {
    if (this.closed) throw fault('PROVIDER_CLOSED', 'Credential provider is closed.');
    if (signal.aborted) throw abortFault(signal);
  }

  /**
   * One refresh with the grant file locked. A 400 or 401 is reported as rejected; anything else throws. `signal` (the
   * flight's) stops discovery and everything else before the refresh request is sent. The request itself is not cut by
   * it: the server may rotate the refresh token as soon as the request arrives, so the request and its response run to
   * their own timeout even after every waiter has left or the flight was superseded.
   */
  private async refreshLocked(generation: number, signal: AbortSignal, stored: StoredGrant, held: LockHeld): Promise<{ token: CachedToken } | { rejected: true }> {
    const discovered = await this.discover(signal);
    if (discovered.tokenEndpoint.href !== stored.binding.tokenEndpoint) throw fault('CONNECTION_REQUIRED', 'The SMART token endpoint changed; run fireboat login.');
    const tokenUrl = discovered.tokenEndpoint;
    const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: stored.refreshToken!, ...await this.clientAuthentication(tokenUrl) });

    // A holder that lost the grant lock (it stalled past the stale limit, say) must not present a refresh token that
    // another process may already have replaced: a server that detects refresh-token reuse can revoke the whole grant.
    await held();
    // The last point at which an abort stops the refresh: nothing has been sent yet.
    if (signal.aborted) throw abortFault(signal);
    // Lifetime is anchored to request start: the token may have been issued at any instant after this.
    const startedAt = this.now();
    let response: Response;
    this.onRequest?.();
    try {
      response = await this.fetchFn(tokenUrl, {
        method: 'POST',
        redirect: 'manual',
        maxCompressedBytes: this.maxTokenResponseBytes,
        signal: this.sentRequestSignal(),
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: form.toString(),
      });
    } catch (error) {
      throw this.mapFetchError(error);
    }
    if (response.status === 400 || response.status === 401) {
      await response.body?.cancel().catch(() => undefined);
      return { rejected: true };
    }
    const fields = await this.readTokenFields(response);
    const { accessToken, expiresIn } = this.bearerFields(fields);
    // A refresh that names a patient must name the bound one; one that omits it keeps the binding recorded at login.
    if (fields.patient !== undefined && fields.patient !== stored.binding.patientId) throw fault('POLICY_DENIED', 'Refreshed token patient context differs from the configured patient.');
    const grant = this.assess(fields.scope);
    if (fields.refresh_token !== undefined && !refreshShape(fields.refresh_token)) throw fault('INVALID_TOKEN_RESPONSE', 'Token endpoint returned an invalid response.');
    // The file is the only copy of a rotated refresh token, so a response that was received is written back even if
    // every waiter has left, the flight was superseded or the provider closed meanwhile. Only a holder that lost the
    // grant lock writes nothing, since another process now owns the file. A process that exits before the response
    // arrives can still lose a rotated token.
    await writeTokenFile(this.tokenFile, { ...stored, scope: grant.scope, accessToken, issuedAt: startedAt, expiresAt: startedAt + expiresIn * 1_000,
      ...(typeof fields.refresh_token === 'string' ? { refreshToken: fields.refresh_token } : {}) }, held);
    // The access token reaches memory only while this flight's generation is current and the provider open.
    const token = this.commitToken(generation, startedAt, accessToken, expiresIn);
    this.adoptGrant(grant, accessToken);
    return { token };
  }

  /** `fireboat login` only: authorization code with PKCE S256 over a one-shot loopback redirect. Stores nothing on any failure. */
  async signIn(io: LoginIo): Promise<LoginResult> {
    if (this.closed) throw fault('PROVIDER_CLOSED', 'Credential provider is closed.');
    // A grant directory that cannot hold the grant fails here, before the user is sent to approve anything.
    await prepareGrantDirectory(this.tokenFile);
    const controller = new AbortController();
    this.signingIn = controller;
    try { return await this.signInWith(io, controller); }
    finally { if (this.signingIn === controller) this.signingIn = undefined; }
  }

  /** The sign-in itself, stopped through `controller` when the provider closes. */
  private async signInWith(io: LoginIo, controller: AbortController): Promise<LoginResult> {
    const discovered = await this.discover(controller.signal);
    if (!discovered.codeChallengeMethods.includes('S256')) throw new LoginFault('PKCE_UNSUPPORTED');
    const key = this.keySource ? await loadAssertionKey(this.keySource, this.keyId!, this.env) : undefined;
    const pkce = pkcePair();
    const state = newState();
    let listener: CallbackListener;
    // Only a callback carrying this login's state (constant-time compared) is accepted; any other probe of
    // /callback is refused by the listener without consuming it.
    try { listener = await io.listen(this.redirectPort, io.timeoutMs, params => stateMatches(state, params.get('state'))); }
    catch { throw new LoginFault('LISTENER_UNAVAILABLE'); }
    try {
      const authorize = new URL(discovered.authorizationEndpoint!.href);
      authorize.searchParams.set('response_type', 'code');
      authorize.searchParams.set('client_id', this.clientId);
      authorize.searchParams.set('redirect_uri', listener.redirectUri);
      authorize.searchParams.set('scope', this.requestScope);
      authorize.searchParams.set('state', state);
      authorize.searchParams.set('aud', this.sourceBaseUrl.replace(/\/+$/, ''));
      authorize.searchParams.set('code_challenge', pkce.challenge);
      authorize.searchParams.set('code_challenge_method', 'S256');
      io.onAuthorizeUrl(authorize);
      let params: URLSearchParams;
      try { params = await listener.result; }
      catch (error) { throw new LoginFault(error instanceof CallbackFault && error.code === 'CALLBACK_TIMEOUT' ? 'CALLBACK_TIMEOUT' : 'CALLBACK_INVALID'); }
      if (params.has('error')) throw new LoginFault('AUTHORIZATION_DENIED');
      const code = params.get('code');
      if (code === null || !CODE.test(code)) throw new LoginFault('CALLBACK_INVALID');

      const tokenUrl = discovered.tokenEndpoint;
      const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: listener.redirectUri, code_verifier: pkce.verifier,
        ...await this.clientAuthentication(tokenUrl, key) });
      const startedAt = this.now();
      let response: Response;
      this.onRequest?.();
      try {
        response = await this.fetchFn(tokenUrl, {
          method: 'POST',
          redirect: 'manual',
          maxCompressedBytes: this.maxTokenResponseBytes,
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(this.timeoutMs)]),
          headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
          body: form.toString(),
        });
      } catch (error) {
        throw this.mapFetchError(error);
      }
      const fields = await this.readTokenFields(response);
      const { accessToken, expiresIn } = this.bearerFields(fields);
      // The code exchange must carry the configured patient exactly; otherwise nothing is stored.
      if (fields.patient === undefined) throw new LoginFault('PATIENT_CONTEXT_MISSING');
      if (fields.patient !== this.patientId) throw new LoginFault('PATIENT_MISMATCH');
      const grant = this.assess(fields.scope);
      // A refresh token is kept only when the operator opted in to offline access; otherwise it is discarded unread.
      const refreshToken = this.offlineAccess ? fields.refresh_token : undefined;
      if (refreshToken !== undefined && !refreshShape(refreshToken)) throw fault('INVALID_TOKEN_RESPONSE', 'Token endpoint returned an invalid response.');
      const usableUntil = this.usableUntil(startedAt, startedAt + expiresIn * 1_000);
      if (!(this.now() < usableUntil)) throw fault('TOKEN_EXPIRED', 'Token endpoint returned a token whose usable lifetime elapsed before delivery.', true);
      const stored: StoredGrant = { version: 1, binding: this.expectedBinding(tokenUrl.href), scope: grant.scope, accessToken,
        issuedAt: startedAt, expiresAt: startedAt + expiresIn * 1_000, ...(typeof refreshToken === 'string' ? { refreshToken } : {}) };
      // A provider closed during the sign-in neither takes the grant lock nor waits for it, and writes nothing.
      if (this.closed) throw fault('PROVIDER_CLOSED', 'Credential provider is closed.');
      try { await withGrantLock(this.tokenFile, held => this.storeLogin(stored, usableUntil, held), { signal: controller.signal }); }
      catch (error) { throw this.closed ? fault('PROVIDER_CLOSED', 'Credential provider is closed.') : error; }
      return { scope: relation(grant), grantedTypes: grant.permits.size, servedTypes: this.servedTypes.length, refresh: typeof refreshToken === 'string',
        warnings: [...discovered.warnings, ...(grant.broader ? ['SMART_GRANT_BROADER_THAN_REQUESTED'] : []), ...(grant.narrower ? ['SMART_GRANT_NARROWER_THAN_REQUESTED'] : [])] };
    } finally {
      listener.close();
      controller.abort();
    }
  }

  /** Stores a login's grant with the grant lock held. The wait for the lock can outlast the token: an expired grant never replaces the stored one. */
  private async storeLogin(stored: StoredGrant, usableUntil: number, held: LockHeld): Promise<void> {
    if (this.closed) throw fault('PROVIDER_CLOSED', 'Credential provider is closed.');
    if (!(this.now() < usableUntil)) throw fault('TOKEN_EXPIRED', 'The token\'s usable lifetime elapsed while the grant lock was held by another process.', true);
    await writeTokenFile(this.tokenFile, stored, held);
  }

  /** Closed operator summary for doctor: never URLs, scopes, tokens or file paths. */
  override async doctorStatus(): Promise<SmartDoctorStatus> {
    let discovery: SmartDoctorStatus['discovery'] = 'ok', pkce: SmartDoctorStatus['pkce'] = 'missing';
    try { pkce = (await this.discover(AbortSignal.timeout(this.timeoutMs))).codeChallengeMethods.includes('S256') ? 'S256' : 'missing'; }
    catch (error) { discovery = discoveryOutcome(error); pkce = 'missing'; }
    // No file is `absent`; an unusable file or one bound elsewhere is `invalid`.
    let file: StoredGrant | null;
    try { file = await readTokenFile(this.tokenFile); }
    catch { return { discovery, pkce, grant: 'invalid', patientContext: 'n/a', scope: 'unknown', servedTypes: this.servedTypes.length }; }
    if (!file) return { discovery, pkce, grant: 'absent', patientContext: 'n/a', scope: 'unknown', servedTypes: this.servedTypes.length };
    let stored: StoredGrant;
    try { stored = this.bound(file); }
    catch { return { discovery, pkce, grant: 'invalid', patientContext: 'n/a', scope: 'unknown', servedTypes: this.servedTypes.length }; }
    let grant: GrantAssessment;
    try { grant = this.assess(stored.scope); }
    catch { return { discovery, pkce, grant: 'invalid', patientContext: 'n/a', scope: 'unknown', servedTypes: this.servedTypes.length }; }
    const live = this.now() < this.usableUntil(stored.issuedAt, stored.expiresAt) || (this.offlineAccess && stored.refreshToken !== undefined);
    return { discovery, pkce, grant: live ? 'present' : 'expired', patientContext: 'match', scope: relation(grant), grantedTypes: grant.permits.size, servedTypes: this.servedTypes.length };
  }
}
