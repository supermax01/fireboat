// Deliberately built-ins only, including the transitive release module.
import { readFileSync } from 'node:fs';
import { runtimeVersionAdmitted, RUNTIME_ASSETS, sha256, StartupFault, type ReleaseMetadata, type RuntimeAsset } from './release.js';

/** Check both admission floor and the actual lossless primitives before importing any gateway code. */
export function checkRuntime(release: ReleaseMetadata): void {
  if (!runtimeVersionAdmitted(process.versions.node, release.runtime.floor)) throw new StartupFault('RUNTIME_UNSUPPORTED');
  const host = JSON as unknown as { rawJSON?: (text: string) => object; isRawJSON?: (value: unknown) => boolean };
  if (typeof host.rawJSON !== 'function' || typeof host.isRawJSON !== 'function') throw new StartupFault('RUNTIME_UNSUPPORTED');
  let source: string | undefined;
  try {
    JSON.parse('[1.0]', (_key: string, value: unknown, context?: { source?: string }) => {
      if (typeof value === 'number') source = context?.source;
      return value;
    });
    if (source !== '1.0' || !host.isRawJSON(host.rawJSON('1.0')) || JSON.stringify(host.rawJSON('1.0')) !== '1.0') throw new Error();
  } catch { throw new StartupFault('RUNTIME_UNSUPPORTED'); }
}

export function checkRuntimeAssets(release: ReleaseMetadata, root = new URL('../../../', import.meta.url)): void {
  for (const [label, path] of Object.entries(RUNTIME_ASSETS)) {
    let bytes: Buffer;
    try { bytes = readFileSync(new URL(path, root)); }
    catch { throw new StartupFault('ASSET_MISSING', label as RuntimeAsset); }
    if (sha256(bytes) !== release.assets[label as RuntimeAsset].sha256) throw new StartupFault('ASSET_INVALID', label as RuntimeAsset);
  }
}

export function startupMessage(error: unknown): string {
  const fault = error instanceof StartupFault ? error : new StartupFault('STARTUP_FAILED');
  return `fireboat: ${fault.code}${fault.label ? ` ${fault.label}` : ''}\n`;
}

export const HELP = `fireboat — synthetic-only local FHIR MCP gateway

Usage:
  fireboat --config <path>          Serve MCP over stdio
  fireboat --doctor --config <path> Check config and source metadata
  fireboat --version                Show release, schema and runtime cell
  fireboat --help                   Show this help

Config path precedence: --config > FIREBOAT_CONFIG > FHIR_MCP_CONFIG (a JSON file).
FHIR_MCP_CONFIG is a deprecated alias for this release; using it emits a stderr note.
Local stdio only; literal loopback source; one configured synthetic patient.
Five read-only tools: fhir_capabilities, fhir_search, fhir_read, fhir_page, fhir_result.
Optional outbound OAuth client credentials use a named secret environment variable.
No SMART authorization, clinical writes or remote serving.
Normal serving stdout carries MCP protocol traffic only.
`;
