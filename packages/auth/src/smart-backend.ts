import { controlledFetch, type HttpFetch } from '../../core/src/transport.js';
import { JWT_BEARER_ASSERTION, loadAssertionKey, signClientAssertion, validateAssertionConfig, type AssertionKeySource } from './client-assertion.js';
import { discoverSmartConfiguration, discoveryOutcome } from './smart-discovery.js';
import { assessGrant, requestedScopes, validateScopeOverrides, type GrantAssessment, type ScopeSyntax } from './smart-scopes.js';
import { fault, parseLoopbackUrl, TokenProvider, type CachedToken, type GrantedInteraction, type SmartDoctorStatus, type TokenProviderOptions } from './token-provider.js';

export interface SmartBackendServicesConfig {
  type: 'smart_backend_services';
  clientId: string;
  keyId: string;
  privateKeyEnv?: string;
  privateKeyFile?: string;
  scopes?: string[];
  scopeSyntax?: ScopeSyntax;
  endpoints?: { token?: string };
}

/** Internal wiring and test injections; not part of public gateway config. */
export interface SmartProviderOptions extends TokenProviderOptions {
  fetchFn?: HttpFetch;
  env?: Record<string, string | undefined>;
  /** The configured patient: a token response that names a patient must name exactly this one. */
  patientId: string;
  /** The gateway's served resource types, in registry order; the default scope request covers each. */
  servedTypes: readonly string[];
  /** Called after a token whose grant differs from the previous one is cached. */
  onGrantChanged?: () => void;
}

const CONFIG_KEYS = new Set(['type', 'clientId', 'keyId', 'privateKeyEnv', 'privateKeyFile', 'scopes', 'scopeSyntax', 'endpoints']);

/**
 * SMART Backend Services client: discovery, then `client_credentials` with a `private_key_jwt` assertion and
 * `system/` read scopes. Tokens live in memory only. The configured patient stays the only patient boundary:
 * a Backend Services token carries no patient context, and one that names a different patient is refused.
 */
export class SmartBackendProvider extends TokenProvider {
  private readonly source: URL;
  private readonly clientId: string;
  private readonly keyId: string;
  private readonly keySource: AssertionKeySource;
  private readonly requested: readonly string[];
  private readonly servedTypes: readonly string[];
  private readonly tokenPin?: URL;
  private readonly patientId: string;
  private readonly fetchFn: HttpFetch;
  private readonly env: Record<string, string | undefined>;
  private readonly onGrantChanged?: () => void;
  private grant: GrantAssessment | null = null;
  private discoveryWarnings: readonly string[] = [];

  constructor(sourceBaseUrl: string, config: SmartBackendServicesConfig, options: SmartProviderOptions) {
    super(sourceBaseUrl);
    this.source = new URL(sourceBaseUrl);
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw fault('INVALID_CONFIG', 'Credential configuration is invalid.');
    for (const key of Object.keys(config)) {
      if (!CONFIG_KEYS.has(key)) throw fault('INVALID_CONFIG', 'Credential configuration contains an unsupported field.');
    }
    if (config.type !== 'smart_backend_services') throw fault('INVALID_CONFIG', 'Credential configuration type is invalid.');
    if (typeof config.clientId !== 'string' || config.clientId.length === 0 || config.clientId.length > 256 || /[\s\x00-\x1F\x7F]/.test(config.clientId)) {
      throw fault('INVALID_CONFIG', 'Credential configuration clientId is invalid.');
    }
    this.clientId = config.clientId;
    validateAssertionConfig(config, config.keyId);
    this.keyId = config.keyId;
    this.keySource = config.privateKeyEnv !== undefined ? { privateKeyEnv: config.privateKeyEnv } : { privateKeyFile: config.privateKeyFile };
    const syntax = config.scopeSyntax ?? 'v2';
    if (syntax !== 'v1' && syntax !== 'v2') throw fault('INVALID_CONFIG', 'SMART scopeSyntax is invalid.');
    if (!Array.isArray(options?.servedTypes) || options.servedTypes.length === 0) throw fault('INVALID_CONFIG', 'Served resource types are required.');
    this.servedTypes = [...options.servedTypes];
    this.requested = config.scopes === undefined ? requestedScopes('system', this.servedTypes, syntax) : validateScopeOverrides(config.scopes, 'system', syntax, this.servedTypes);
    if (config.endpoints !== undefined) {
      if (!config.endpoints || typeof config.endpoints !== 'object' || Array.isArray(config.endpoints) || Object.keys(config.endpoints).some(key => key !== 'token')) {
        throw fault('INVALID_CONFIG', 'SMART endpoints are invalid.');
      }
      if (config.endpoints.token !== undefined) this.tokenPin = parseLoopbackUrl(config.endpoints.token, 'SMART token endpoint');
    }
    if (typeof options.patientId !== 'string' || options.patientId.length === 0) throw fault('INVALID_CONFIG', 'Patient binding is required.');
    this.patientId = options.patientId;
    // Never ambient fetch in production: the controlled client ignores NODE_USE_ENV_PROXY/HTTP(S)_PROXY.
    this.fetchFn = options.fetchFn ?? controlledFetch;
    this.env = options.env ?? process.env;
    this.onGrantChanged = options.onGrantChanged;
    this.configureTokenOptions(options);
  }

  allows(resourceType: string, interaction: GrantedInteraction): boolean {
    return this.grant?.permits.get(resourceType)?.has(interaction) === true;
  }

  /** Stable warning codes for operator diagnostics; never URLs, scopes or token values. */
  get warnings(): string[] {
    return [...this.discoveryWarnings, ...(this.grant?.broader ? ['SMART_GRANT_BROADER_THAN_REQUESTED'] : []),
      ...(this.grant?.narrower ? ['SMART_GRANT_NARROWER_THAN_REQUESTED'] : [])];
  }

  /** Closed operator summary for doctor. The grant is known only after a token was acquired in this process. */
  override async doctorStatus(): Promise<SmartDoctorStatus> {
    let discovery: SmartDoctorStatus['discovery'] = 'ok';
    try {
      await discoverSmartConfiguration(this.source, { fetchFn: this.fetchFn, onRequest: this.onRequest, timeoutMs: this.timeoutMs,
        signal: AbortSignal.timeout(this.timeoutMs), pins: { token: this.tokenPin }, flow: 'backend_services' });
    } catch (error) { discovery = discoveryOutcome(error); }
    const grant = this.grant;
    return { discovery, pkce: 'n/a', grant: 'n/a', patientContext: 'n/a',
      scope: !grant ? 'unknown' : grant.narrower ? 'narrower' : grant.broader ? 'broader' : 'exact',
      ...(grant ? { grantedTypes: grant.permits.size } : {}), servedTypes: this.servedTypes.length };
  }

  protected async request(generation: number, signal: AbortSignal): Promise<CachedToken> {
    const key = await loadAssertionKey(this.keySource, this.keyId, this.env);
    const discovered = await discoverSmartConfiguration(this.source, { fetchFn: this.fetchFn, onRequest: this.onRequest, timeoutMs: this.timeoutMs,
      signal, pins: { token: this.tokenPin }, flow: 'backend_services', signingAlg: key.alg });
    this.discoveryWarnings = discovered.warnings;
    const tokenUrl = discovered.tokenEndpoint;
    // A fresh assertion (and jti) for every token request, retries included; `aud` is the endpoint exactly as used.
    const form = new URLSearchParams({ grant_type: 'client_credentials', scope: this.requested.join(' '),
      client_assertion_type: JWT_BEARER_ASSERTION, client_assertion: signClientAssertion(key, this.clientId, tokenUrl.href, this.now()) });

    // Lifetime is anchored to request start: the token may have been issued at any instant after this.
    const startedAt = this.now();
    let response: Response;
    this.onRequest?.();
    try {
      response = await this.fetchFn(tokenUrl, {
        method: 'POST',
        redirect: 'manual',
        maxCompressedBytes: this.maxTokenResponseBytes,
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]),
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: form.toString(),
      });
    } catch (error) {
      throw this.mapFetchError(error);
    }

    const fields = await this.readTokenFields(response);
    const { accessToken, expiresIn } = this.bearerFields(fields);
    if (fields.patient !== undefined && fields.patient !== this.patientId) throw fault('POLICY_DENIED', 'Token patient context differs from the configured patient.');
    const grant = assessGrant(fields.scope, this.requested, 'system', this.servedTypes);
    const token = this.commitToken(generation, startedAt, accessToken, expiresIn);
    const changed = this.grant !== null && this.grant.scope !== grant.scope;
    this.grant = grant;
    if (changed) this.onGrantChanged?.();
    return token;
  }
}
