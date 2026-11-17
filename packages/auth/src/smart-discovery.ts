import { GatewayFault, utf8Charset, type HttpFetch } from '../../core/src/transport.js';
import { CredentialFault, fault, LocalWorkRefusal, parseLoopbackUrl } from './token-provider.js';

/** Discovery documents are small; anything larger is refused rather than buffered. */
export const MAX_DISCOVERY_BYTES = 65_536;

/** Operator pins for endpoints on a loopback origin other than the FHIR source's. Discovery must agree with each pin. */
export interface SmartEndpointPins { token?: URL; authorization?: URL }

export interface SmartConfiguration {
  readonly tokenEndpoint: URL;
  readonly authorizationEndpoint?: URL;
  readonly codeChallengeMethods: readonly string[];
  /** Advertised gaps that do not stop the flow, as stable codes (no URLs or values). */
  readonly warnings: readonly string[];
}

export interface SmartDiscoveryOptions {
  fetchFn: HttpFetch;
  /** Counts the discovery request against the caller's upstream allowance before it is sent. */
  onRequest?: () => void;
  timeoutMs: number;
  signal: AbortSignal;
  pins: SmartEndpointPins;
  /** Backend Services checks the client-credentials grant and signed-JWT client authentication. */
  flow: 'backend_services' | 'standalone_launch';
  signingAlg?: 'ES384' | 'RS384';
}

/** `<baseUrl>/.well-known/smart-configuration`, keeping every path segment of the FHIR base. */
export function smartConfigurationUrl(source: URL): URL {
  const url = new URL(source.href);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/.well-known/smart-configuration`;
  return url;
}

/**
 * The one endpoint policy: a literal loopback http(s) URL with no credentials, query or fragment, on the FHIR
 * source's origin unless the operator pinned it, in which case discovery must name exactly the pinned URL.
 */
export function checkDiscoveredEndpoint(value: unknown, label: string, source: URL, pin?: URL): URL {
  if (typeof value !== 'string') throw fault('INVALID_TOKEN_RESPONSE', `SMART discovery ${label} is missing.`);
  let url: URL;
  try { url = parseLoopbackUrl(value, `SMART discovery ${label}`); }
  catch (error) {
    if (error instanceof CredentialFault && error.code === 'LOOPBACK_ONLY') throw error;
    throw fault('INVALID_TOKEN_RESPONSE', `SMART discovery ${label} is invalid.`);
  }
  if (pin) {
    if (url.href !== pin.href) throw fault('INVALID_TOKEN_RESPONSE', `SMART discovery ${label} disagrees with the configured endpoint.`);
  } else if (url.origin !== source.origin) {
    throw fault('LOOPBACK_ONLY', `SMART discovery ${label} is not on the FHIR source origin and is not configured.`);
  }
  return url;
}

function stringList(document: Record<string, unknown>, field: string): string[] | undefined {
  const value = document[field];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 256 || value.some(item => typeof item !== 'string' || item.length > 256)) {
    throw fault('INVALID_TOKEN_RESPONSE', 'SMART discovery document is invalid.');
  }
  return value as string[];
}

function discoveryFetchFault(error: unknown): CredentialFault | LocalWorkRefusal {
  if (error instanceof LocalWorkRefusal || error instanceof CredentialFault) return error;
  if ((error as { code?: unknown } | null)?.code === 'UPSTREAM_LIMIT') return fault('TOKEN_RESPONSE_LIMIT', 'SMART discovery document exceeds the byte limit.');
  if (error instanceof GatewayFault) return fault('INVALID_TOKEN_RESPONSE', 'SMART discovery document is invalid.');
  if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) return fault('TOKEN_TIMEOUT', 'SMART discovery timed out.', true);
  return fault('TOKEN_ENDPOINT_ERROR', 'SMART discovery is unavailable.', true);
}

async function readDiscovery(response: Response): Promise<Record<string, unknown>> {
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined);
    throw fault('UNSAFE_REDIRECT', 'SMART discovery redirects are disabled.');
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw fault('TOKEN_ENDPOINT_ERROR', `SMART discovery failed (HTTP ${response.status}).`, response.status === 429 || response.status >= 500);
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (!/^application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|$)/i.test(contentType) || !utf8Charset(contentType)) {
    await response.body?.cancel().catch(() => undefined);
    throw fault('INVALID_TOKEN_RESPONSE', 'SMART discovery document is invalid.');
  }
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_DISCOVERY_BYTES)) {
    await response.body?.cancel().catch(() => undefined);
    throw fault('TOKEN_RESPONSE_LIMIT', 'SMART discovery document exceeds the byte limit.');
  }
  const reader = response.body?.getReader();
  if (!reader) throw fault('INVALID_TOKEN_RESPONSE', 'SMART discovery document is invalid.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_DISCOVERY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw fault('TOKEN_RESPONSE_LIMIT', 'SMART discovery document exceeds the byte limit.');
      }
      chunks.push(value);
    }
  } catch (error) {
    throw discoveryFetchFault(error);
  } finally {
    reader.releaseLock();
  }
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw fault('INVALID_TOKEN_RESPONSE', 'SMART discovery document is invalid.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw fault('INVALID_TOKEN_RESPONSE', 'SMART discovery document is invalid.');
  return parsed as Record<string, unknown>;
}

/**
 * Fetches `<baseUrl>/.well-known/smart-configuration` unauthenticated through the controlled client: no redirects,
 * at most 64 KiB, counted in the caller's request allowance. Discovery never selects an endpoint the operator did
 * not allow (see `checkDiscoveredEndpoint`).
 */
export async function discoverSmartConfiguration(source: URL, options: SmartDiscoveryOptions): Promise<SmartConfiguration> {
  const url = smartConfigurationUrl(source);
  let response: Response;
  options.onRequest?.();
  try {
    response = await options.fetchFn(url, {
      method: 'GET',
      redirect: 'manual',
      maxCompressedBytes: MAX_DISCOVERY_BYTES,
      signal: AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)]),
      headers: { accept: 'application/json' },
    });
  } catch (error) {
    throw discoveryFetchFault(error);
  }
  const document = await readDiscovery(response);

  const tokenEndpoint = checkDiscoveredEndpoint(document.token_endpoint, 'token_endpoint', source, options.pins.token);
  const authorizationEndpoint = options.flow === 'standalone_launch'
    ? checkDiscoveredEndpoint(document.authorization_endpoint, 'authorization_endpoint', source, options.pins.authorization)
    : undefined;
  const grants = stringList(document, 'grant_types_supported');
  const authMethods = stringList(document, 'token_endpoint_auth_methods_supported');
  const algs = stringList(document, 'token_endpoint_auth_signing_alg_values_supported');
  const codeChallengeMethods = stringList(document, 'code_challenge_methods_supported') ?? [];
  stringList(document, 'capabilities');
  stringList(document, 'scopes_supported');

  const warnings: string[] = [];
  if (options.flow === 'backend_services') {
    if (grants && !grants.includes('client_credentials')) warnings.push('SMART_GRANT_TYPE_NOT_ADVERTISED');
    if (authMethods && !authMethods.includes('private_key_jwt')) warnings.push('SMART_CLIENT_AUTH_NOT_ADVERTISED');
    if (algs && options.signingAlg && !algs.includes(options.signingAlg)) warnings.push('SMART_SIGNING_ALG_NOT_ADVERTISED');
  } else if (grants && !grants.includes('authorization_code')) warnings.push('SMART_GRANT_TYPE_NOT_ADVERTISED');
  return { tokenEndpoint, ...(authorizationEndpoint ? { authorizationEndpoint } : {}), codeChallengeMethods, warnings };
}

/** For doctor: unreachable or refusing discovery is `unavailable`; a document fireboat refuses is `invalid`. */
export function discoveryOutcome(error: unknown): 'unavailable' | 'invalid' {
  const code = error instanceof CredentialFault ? error.code : '';
  return ['INVALID_TOKEN_RESPONSE', 'LOOPBACK_ONLY', 'TOKEN_RESPONSE_LIMIT'].includes(code) ? 'invalid' : 'unavailable';
}
