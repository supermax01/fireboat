#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { open, readFile, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostConfigurations } from './configs.js';
import { downRun } from './down.js';
import { fault, QuickstartFault, sha256 } from './manifest.js';
import { prepare } from './prepare.js';
import type { HelperAssets, PrepareResult } from './prepare.js';
import { atomicPrivateWrite, jsonBytes } from './run-state.js';
import { openGatewaySession } from './client.js';
import { verify, type SessionFactory, type VerifyReport } from './verify.js';

type CliResult = Readonly<{ line: string; exitCode: 0 | 1 | 2 }>;
type CliDependencies = Readonly<{
  assets?: () => Promise<HelperAssets>;
  prepare?: typeof prepare; down?: typeof downRun; verify?: typeof verify;
}>;
/** The verifier's sessions are the helper client's, launched with the installed CLI and the operator's config. */
export const helperSessions: SessionFactory = launch => openGatewaySession({ argv: [launch.node, launch.cli, '--config', launch.config], era: launch.era, observe: launch.observe });
const verifiedLine = (r: VerifyReport): string => `${r.failed ? 'VERIFY_FAILED' : 'VERIFY_OK'} runs=${r.runs.length} passed=${r.passed} failed=${r.failed}`
  + ` limitations=${[...new Set(r.runs.flatMap(run => run.limitations))].sort().join(',') || 'none'} evidence=${r.evidenceSha256}`;
const projectRoot = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../../' : '../../../', import.meta.url));
export async function loadHelperAssets(): Promise<HelperAssets> {
  const [manifest, compose, resources] = await Promise.all([
    readFile(join(projectRoot, 'examples/quickstart/seed-manifest.json')),
    readFile(join(projectRoot, 'compose.quickstart.yaml')),
    readFile(join(projectRoot, 'packages/evals/fixtures/quickstart/resources.ndjson'))
  ]);
  return { manifest, compose, resources };
}
function argumentsFor(args: readonly string[], flags: readonly string[], switches: readonly string[] = []): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (Object.hasOwn(result, key)) throw fault('CLI_USAGE');
    if (switches.includes(key)) result[key] = 'true';
    else if (flags.includes(key) && args[i + 1] && !args[i + 1]!.startsWith('--')) result[key] = args[++i]!;
    else throw fault('CLI_USAGE');
  }
  if (flags.some(k => !result[k] || !isAbsolute(result[k]!) || result[k]!.includes('\0'))) throw fault('CLI_USAGE');
  return result;
}
const preparedLine = (r: PrepareResult): string => `PREPARE_OK resources=${r.resources} types=${r.types} manifest=${r.manifestSha256} receipt=${r.receiptSha256} packet=${r.packetSha256}`;
export async function runQuickstart(argv: readonly string[], dependencies: CliDependencies = {}): Promise<CliResult> {
  try {
    const [command, ...args] = argv;
    if (command === 'prepare') {
      const flags = argumentsFor(args, ['--run-dir']);
      const assets = await (dependencies.assets ?? loadHelperAssets)();
      const result = await (dependencies.prepare ?? prepare)({ ...assets, runDirectory: flags['--run-dir']! });
      return { line: preparedLine(result), exitCode: 0 };
    }
    if (command === 'down') {
      const flags = argumentsFor(args, ['--run-dir'], ['--volumes']);
      const assets = await (dependencies.assets ?? loadHelperAssets)();
      const result = await (dependencies.down ?? downRun)(assets.manifest, flags['--run-dir']!, flags['--volumes'] === 'true');
      return { line: `DOWN_OK actions=${result.actions} receipt=${result.receiptSha256}`, exitCode: 0 };
    }
    if (command === 'verify') {
      const flags = argumentsFor(args, ['--run-dir', '--node', '--cli', '--config']);
      const assets = await (dependencies.assets ?? loadHelperAssets)();
      const report = await (dependencies.verify ?? verify)({ runDirectory: flags['--run-dir']!, node: flags['--node']!, cli: flags['--cli']!, config: flags['--config']!,
        assets }, { openSession: helperSessions });
      return { line: verifiedLine(report), exitCode: report.failed ? 1 : 0 };
    }
    if (command === 'configs') {
      const flags = argumentsFor(args, ['--node', '--cli', '--config', '--out']);
      const bytes = jsonBytes(hostConfigurations({ node: flags['--node']!, cli: flags['--cli']!, config: flags['--config']! }));
      // Generated review material has an explicit new destination. Never
      // overwrite an existing settings file (or follow an existing symlink).
      const destination = flags['--out']!;
      const reserve = await open(destination, 'wx', 0o600).catch(() => { throw fault('LAUNCH_INVALID'); });
      await reserve.close();
      try { await atomicPrivateWrite(destination, bytes); }
      catch (error) { await rm(destination, { force: true }); throw error; }
      return { line: `CONFIGS_OK forms=4 sha256=${sha256(bytes)}`, exitCode: 0 };
    }
    throw fault('CLI_USAGE');
  } catch (error) {
    const code = error instanceof QuickstartFault ? error.code : 'HELPER_FAILED';
    return { line: code, exitCode: code === 'CLI_USAGE' ? 2 : 1 };
  }
}
/** True when this module is the process entry, also when it is started through a symlink (an npm bin shim, macOS /var). */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try { return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}
if (isMainModule()) {
  const result = await runQuickstart(process.argv.slice(2));
  (result.exitCode === 0 ? process.stdout : process.stderr).write(`${result.line}\n`);
  process.exitCode = result.exitCode;
}
