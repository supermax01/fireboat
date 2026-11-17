import { ClientCredentialsProvider, type OAuthClientCredentialsConfig } from './client-credentials.js';
import { SmartBackendProvider, type SmartBackendServicesConfig } from './smart-backend.js';
import { SmartStandaloneProvider, type SmartStandaloneLaunchConfig } from './smart-standalone.js';
import type { TokenProvider, TokenProviderOptions } from './token-provider.js';

export type SourceAuthConfig = OAuthClientCredentialsConfig | SmartBackendServicesConfig | SmartStandaloneLaunchConfig;

/** What the gateway hands every provider. Plain client credentials uses only the timeout and request counter. */
export interface CredentialProviderContext extends Pick<TokenProviderOptions, 'timeoutMs' | 'onRequest'> {
  patientId: string;
  servedTypes: readonly string[];
  /** The source alias; names the default SMART token file. */
  alias: string;
  onGrantChanged: () => void;
}

/** Builds the outbound credential provider for `source.auth`. */
export function createCredentialProvider(sourceBaseUrl: string, config: SourceAuthConfig, context: CredentialProviderContext): TokenProvider {
  if (config.type === 'smart_standalone_launch') {
    return new SmartStandaloneProvider(sourceBaseUrl, config, { timeoutMs: context.timeoutMs, onRequest: context.onRequest,
      patientId: context.patientId, servedTypes: context.servedTypes, alias: context.alias, onGrantChanged: context.onGrantChanged });
  }
  if (config.type === 'smart_backend_services') {
    return new SmartBackendProvider(sourceBaseUrl, config, { timeoutMs: context.timeoutMs, onRequest: context.onRequest,
      patientId: context.patientId, servedTypes: context.servedTypes, onGrantChanged: context.onGrantChanged });
  }
  return new ClientCredentialsProvider(sourceBaseUrl, config, { timeoutMs: context.timeoutMs, onRequest: context.onRequest });
}
