// Built-ins only: the bootstrap must read release identity before loading the gateway.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const RUNTIME_ASSETS = Object.freeze({
  'r4-index': 'packages/core/src/generated/r4-index.json',
  'r4-search-parameters': 'packages/core/src/generated/r4-search-parameters.json',
  'support-matrix': 'packages/core/src/data/support-matrix.json',
  'search-profiles': 'packages/core/src/data/search-profiles.json',
  'compact-profiles': 'packages/core/src/data/compact-profiles.json',
  'host-profiles': 'packages/core/src/data/host-profiles.json',
});
export type RuntimeAsset = keyof typeof RUNTIME_ASSETS;
export const RELEASE_BIN = 'dist/packages/server/src/cli.js';
export const RUNTIME_FLOOR = '24.0.0';
export const NODE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
export const SHA256 = /^[a-f0-9]{64}$/;
export const PLATFORMS = ['aix', 'android', 'darwin', 'freebsd', 'haiku', 'linux', 'openbsd', 'sunos', 'win32', 'cygwin', 'netbsd'] as const;
export const ARCHITECTURES = ['arm', 'arm64', 'ia32', 'loong64', 'mips', 'mipsel', 'ppc', 'ppc64', 'riscv64', 's390', 's390x', 'x64'] as const;
export interface RuntimeCell { node: string; platform: string; arch: string }
export interface ReleaseMetadata {
  name: string; packageName: string; version: string; schema: '0.3'; catalog: 'm3b-catalog/3'; bin: string;
  assets: Record<RuntimeAsset, { path: string; sha256: string }>;
  productionDependencies: Record<string, string>;
  runtime: { floor: string; recordedCells: RuntimeCell[] };
}

export class StartupFault extends Error {
  constructor(readonly code: 'RUNTIME_UNSUPPORTED' | 'ASSET_MISSING' | 'ASSET_INVALID' | 'STARTUP_FAILED',
    readonly label?: RuntimeAsset | 'release') { super(code); }
}
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: readonly string[]): boolean =>
  Object.keys(value).sort().join('\n') === [...expected].sort().join('\n');
const token = (value: unknown, pattern: RegExp, max = 128): value is string => typeof value === 'string' && value.length <= max && !/[\x00-\x20\x7f]/.test(value) && pattern.test(value);

/** A release is a closed manifest; paths and asset labels are never supplied by configuration. */
export function validReleaseMetadata(value: unknown): value is ReleaseMetadata {
  if (!record(value) || !keys(value, ['name', 'packageName', 'version', 'schema', 'catalog', 'bin', 'assets', 'productionDependencies', 'runtime'])) return false;
  if (!token(value.name, /^[A-Za-z0-9._-]{1,80}$/) || !token(value.packageName, /^(?:@[a-z0-9_-]+\/)?[a-z0-9_-]+(?:[.-][a-z0-9_-]+)*$/)
    || !token(value.version, SEMVER) || value.schema !== '0.3' || value.catalog !== 'm3b-catalog/3' || value.bin !== RELEASE_BIN) return false;
  if (!record(value.assets) || !keys(value.assets, Object.keys(RUNTIME_ASSETS))) return false;
  for (const [label, path] of Object.entries(RUNTIME_ASSETS)) {
    const asset = value.assets[label];
    if (!record(asset) || !keys(asset, ['path', 'sha256']) || asset.path !== path || !token(asset.sha256, SHA256)) return false;
  }
  if (!record(value.productionDependencies) || !Object.keys(value.productionDependencies).length) return false;
  if (!Object.entries(value.productionDependencies).every(([name, pin]) => token(name, /^(?:@[a-z0-9_-]+\/)?[a-z0-9._-]+$/) && token(pin, SEMVER))) return false;
  const runtime = value.runtime;
  if (!record(runtime) || !keys(runtime, ['floor', 'recordedCells']) || runtime.floor !== RUNTIME_FLOOR || !Array.isArray(runtime.recordedCells)) return false;
  const cells = runtime.recordedCells;
  if (cells.length > 100 || !cells.every(cell => record(cell) && keys(cell, ['node', 'platform', 'arch']) && token(cell.node, NODE_VERSION)
    && PLATFORMS.includes(cell.platform as never) && ARCHITECTURES.includes(cell.arch as never))) return false;
  return new Set(cells.map(cell => JSON.stringify(cell))).size === cells.length;
}

export const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Source entrypoint support, also used by the build generator. No SDK/core imports or generated source file. */
export function sourceReleaseMetadata(root: URL): ReleaseMetadata {
  const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
  const scalar = (path: string, name: string): string => {
    const text = readFileSync(new URL(path, root), 'utf8');
    const matches = [...text.matchAll(new RegExp(`export const ${name} = '([^']+)'`, 'g'))];
    if (matches.length !== 1) throw new StartupFault('ASSET_INVALID', 'release');
    return matches[0]![1]!;
  };
  const release = {
    name: Object.keys(pkg.bin)[0], packageName: pkg.name, version: pkg.version,
    schema: scalar('packages/core/src/contracts.ts', 'M3B_SCHEMA_VERSION'),
    catalog: scalar('packages/core/src/catalog.ts', 'CATALOG_V2_VERSION'),
    bin: Object.values(pkg.bin)[0],
    assets: Object.fromEntries(Object.entries(RUNTIME_ASSETS).map(([label, path]) => {
      let bytes: Buffer;
      try { bytes = readFileSync(new URL(path, root)); }
      catch { throw new StartupFault('ASSET_MISSING', label as RuntimeAsset); }
      return [label, { path, sha256: sha256(bytes) }];
    })),
    productionDependencies: pkg.dependencies,
    runtime: {
      // The owner has retained >=24. The proposed 24.21 floor is not an authorization to change it.
      floor: RUNTIME_FLOOR,
      // Local source gates / G-HOST recorded this exact cell. CI declarations are not passing cells.
      recordedCells: [{ node: '24.22.0', platform: 'darwin', arch: 'arm64' }],
    },
  };
  if (!validReleaseMetadata(release)) throw new StartupFault('ASSET_INVALID', 'release');
  return release;
}

export function readReleaseMetadata(): ReleaseMetadata {
  // tsx development launches use source assets; installed JavaScript always requires the emitted manifest.
  if (import.meta.url.endsWith('.ts')) return sourceReleaseMetadata(new URL('../../../', import.meta.url));
  let bytes: string;
  try { bytes = readFileSync(new URL('./generated/release.json', import.meta.url), 'utf8'); }
  catch { throw new StartupFault('ASSET_MISSING', 'release'); }
  try {
    const release: unknown = JSON.parse(bytes);
    if (!validReleaseMetadata(release)) throw new Error();
    return release;
  } catch { throw new StartupFault('ASSET_INVALID', 'release'); }
}

export function runtimeCell(release: ReleaseMetadata, cell: RuntimeCell): 'recorded' | 'unverified' {
  return release.runtime.recordedCells.some(recorded => recorded.node === cell.node && recorded.platform === cell.platform && recorded.arch === cell.arch) ? 'recorded' : 'unverified';
}

export function runtimeVersionAdmitted(node: string, minimum = RUNTIME_FLOOR): boolean {
  const parts = NODE_VERSION.exec(node), floor = minimum.split('.').map(Number);
  const actual = parts ? parts.slice(1).map(Number) : [];
  return actual.length === 3 && actual.every(Number.isSafeInteger) && (actual[0]! > floor[0]!
    || actual[0] === floor[0] && (actual[1]! > floor[1]! || actual[1] === floor[1] && actual[2]! >= floor[2]!));
}

export function versionLine(release: ReleaseMetadata, cell: RuntimeCell = { node: process.versions.node, platform: process.platform, arch: process.arch }): string {
  return `${release.name} ${release.version} schema=${release.schema} node=${cell.node} runtime=${runtimeCell(release, cell)}`;
}
