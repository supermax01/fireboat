// Toolchain pins for the bench (Node for fireboat and fhirHydrant, Python for WSO2 and momentum, uv). Resolved through
// mise at run time (never hard-coded install paths) and version-checked. `bench/run/setup.sh` installs them with
// `mise install`. MISE_BIN may name the mise executable; otherwise "mise" on PATH, then Homebrew's default location.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const TOOL_PINS = { node: '24.22.0', python312: '3.12.16', python313: '3.13.18', uv: '0.13.7' } as const;

const MISE_CANDIDATES = [process.env.MISE_BIN, 'mise', '/opt/homebrew/bin/mise', '/usr/local/bin/mise'].filter((x): x is string => !!x);
const cache = new Map<string, string>();

/** `mise where <tool>@<version>`; throws with the install command when the tool is missing. */
export function miseWhere(tool: string, version: string): string {
  const key = `${tool}@${version}`;
  const hit = cache.get(key);
  if (hit) return hit;
  for (const mise of MISE_CANDIDATES) {
    try {
      const dir = execFileSync(mise, ['where', key], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (dir && existsSync(dir)) { cache.set(key, dir); return dir; }
    } catch { /* next candidate */ }
  }
  throw new Error(`${key} is not installed through mise; run: mise install ${key}`);
}

const checked = (path: string, versionArgs: string[], expect: string): string => {
  const out = execFileSync(path, versionArgs, { encoding: 'utf8' }).trim();
  if (!out.includes(expect)) throw new Error(`${path} reports "${out}", expected ${expect}`);
  return path;
};

export const nodeBinDir = (): string => join(miseWhere('node', TOOL_PINS.node), 'bin');
export const nodeBin = (): string => join(nodeBinDir(), 'node');
export const python312 = (): string => checked(join(miseWhere('python', TOOL_PINS.python312), 'bin', 'python3.12'), ['--version'], TOOL_PINS.python312);
export const python313 = (): string => checked(join(miseWhere('python', TOOL_PINS.python313), 'bin', 'python3.13'), ['--version'], TOOL_PINS.python313);

/** uv's binary sits in an architecture-named subdirectory of its mise install. */
export function uvBin(): string {
  const dir = miseWhere('uv', TOOL_PINS.uv);
  const candidates = [join(dir, 'uv'), ...readdirSync(dir).filter(d => d.startsWith('uv-')).map(d => join(dir, d, 'uv'))];
  const found = candidates.find(existsSync);
  if (!found) throw new Error(`uv binary not found under ${dir}`);
  return checked(found, ['--version'], TOOL_PINS.uv);
}

/** Checks every pinned tool and returns their resolved paths and reported versions (for manifests). */
export function toolchainReport(): Record<string, { path: string; version: string }> {
  const v = (p: string) => execFileSync(p, ['--version'], { encoding: 'utf8' }).trim();
  const node = checked(nodeBin(), ['--version'], `v${TOOL_PINS.node}`);
  const out: Record<string, { path: string; version: string }> = { node: { path: node, version: v(node) } };
  for (const [k, f] of [['python312', python312], ['python313', python313], ['uv', uvBin]] as const) { const p = f(); out[k] = { path: p, version: v(p) }; }
  return out;
}

// bench:toolchain: prints the resolved, version-checked toolchain (setup.sh records it).
if (import.meta.url === `file://${process.argv[1]}`) process.stdout.write(JSON.stringify(toolchainReport(), null, 2) + '\n');
