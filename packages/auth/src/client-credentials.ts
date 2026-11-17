import { controlledFetch, type HttpFetch } from '../../core/src/transport.js';
import { ENV_NAME, fault, parseLoopbackUrl, SCOPE_TOKEN, TokenProvider, type CachedToken, type TokenProviderOptions } from './token-provider.js';

export { CredentialFault, LocalWorkRefusal, type AuthorizationGrant } from './token-provider.js';

export interface OAuthClientCredentialsConfig {
  type: 'client_credentials';
  tokenUrl: string;
  clientId: string;
  clientSecretEnv: string;
  scopes?: string[];
}

/** Internal transport options and test injections; not part of public gateway config. */
export interface ClientCredentialsProviderOptions extends TokenProviderOptions {
  fetchFn?: typeof fetch;
  env?: Record<string, string | undefined>;
}

const CONFIG_KEYS = new Set(['type', 'tokenUrl', 'clientId', 'clientSecretEnv', 'scopes']);

/**
 * Local OAuth2 client-credentials provider for a synthetic loopback backend.
 * This is not SMART user launch/PKCE, SMART backend-services private_key_jwt,
 * or inbound MCP authorization. Requested scopes are sent as-is; granted
 * permissions are not verified here.
 */
export class ClientCredentialsProvider extends TokenProvider {
  private readonly tokenUrl: URL;
  private readonly clientId: string;
  private readonly clientSecretEnv: string;
  private readonly scopes: readonly string[];
  private readonly fetchFn: HttpFetch;
  private readonly env: Record<string, string | undefined>;

  constructor(sourceBaseUrl: string, config: OAuthClientCredentialsConfig, options: ClientCredentialsProviderOptions = {}) {
    super(sourceBaseUrl);

    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw fault('INVALID_CONFIG', 'Credential configuration is invalid.');
    }
    for (const key of Object.keys(config)) {
      if (!CONFIG_KEYS.has(key)) throw fault('INVALID_CONFIG', 'Credential configuration contains an unsupported field.');
    }
    if (config.type !== 'client_credentials') {
      throw fault('INVALID_CONFIG', 'Credential configuration type is invalid.');
    }
    this.tokenUrl = parseLoopbackUrl(config.tokenUrl, 'Token URL');

    if (typeof config.clientId !== 'string' || config.clientId.length === 0 || config.clientId.length > 256 || /[\s\x00-\x1F\x7F]/.test(config.clientId)) {
      throw fault('INVALID_CONFIG', 'Credential configuration clientId is invalid.');
    }
    this.clientId = config.clientId;

    if (typeof config.clientSecretEnv !== 'string' || config.clientSecretEnv.length > 128 || !ENV_NAME.test(config.clientSecretEnv)) {
      throw fault('INVALID_CONFIG', 'Credential configuration clientSecretEnv is invalid.');
    }
    this.clientSecretEnv = config.clientSecretEnv;

    const scopes = config.scopes ?? [];
    if (!Array.isArray(scopes) || scopes.length > 20
      || scopes.some(s => typeof s !== 'string' || s.length === 0 || s.length > 128 || !SCOPE_TOKEN.test(s))
      || new Set(scopes).size !== scopes.length) {
      throw fault('INVALID_CONFIG', 'Credential configuration scopes are invalid.');
    }
    this.scopes = [...scopes];

    // Never ambient fetch in production: the controlled client ignores NODE_USE_ENV_PROXY/HTTP(S)_PROXY.
    this.fetchFn = options.fetchFn ?? controlledFetch;
    this.env = options.env ?? process.env;
    this.configureTokenOptions(options);
  }

  /** Granted permissions are not verified for plain client credentials; the source alone enforces them. */
  allows(): boolean { return true; }

  protected async request(generation: number, signal: AbortSignal): Promise<CachedToken> {
    const secret = this.env[this.clientSecretEnv];
    if (typeof secret !== 'string' || secret.length === 0 || secret.length > 4_096) {
      throw fault('CREDENTIAL_UNAVAILABLE', 'Configured client secret is not available.');
    }
    const basic = Buffer.from(`${encodeURIComponent(this.clientId)}:${encodeURIComponent(secret)}`, 'utf8').toString('base64');
    const form = new URLSearchParams({ grant_type: 'client_credentials' });
    if (this.scopes.length > 0) form.set('scope', this.scopes.join(' '));

    // Lifetime is anchored to request start: the token may have been issued at any instant after this.
    const startedAt = this.now();
    let response: Response;
    this.onRequest?.();
    try {
      response = await this.fetchFn(this.tokenUrl, {
        method: 'POST',
        redirect: 'manual',
        // The token allowance bounds compressed input (metered raw before decompression)
        // as well as the decoded bytes counted in readBounded below.
        maxCompressedBytes: this.maxTokenResponseBytes,
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]),
        headers: {
          authorization: `Basic ${basic}`,
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: form.toString(),
      });
    } catch (error) {
      throw this.mapFetchError(error);
    }

    const { accessToken, expiresIn } = this.bearerFields(await this.readTokenFields(response));
    return this.commitToken(generation, startedAt, accessToken, expiresIn);
  }
}
