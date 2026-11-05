// Trusted fresh-install harness. Native Node type stripping runs the worker without tsx.
// Runtime imports are built-ins only; gateway/helper children use only their installed JS entrypoints.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, cp, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { VerifyReport } from '../examples/quickstart/verify.js';

export class PackageQuickstartFault extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'PackageQuickstartFault'; this.code = code; }
}
const fault = (code: string) => new PackageQuickstartFault(code);
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const hash = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
const hex = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const json = async (path: string): Promise<any> => JSON.parse(await readFile(path, 'utf8'));
const save = async (path: string, value: unknown) => writeFile(path, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 });
const requireThat = (ok: unknown, code: string): void => { if (!ok) throw fault(code); };

export const PACKAGE_TASKS = ['package-latest-hba1c', 'package-status-sensitive', 'package-drain-reproject'] as const;
export const PACKAGE_ERAS = ['modern', 'legacy'] as const;
export const PACKAGE_ARMS = ['fhir', 'compact', 'selected'] as const;
export const PACKAGE_GUARDS = ['runtime', 'missing-asset', 'stdout', 'lifecycle', 'seam', 'helper-negatives'] as const;
export type GuardResult = { id: typeof PACKAGE_GUARDS[number]; status: 'pass' | 'fail'; code?: string };

/** Require the complete Cartesian grid, not an aggregate count or one successful task. */
export function allThreeTasksPassed(value: unknown): value is VerifyReport {
  if (!record(value) || value.schema !== 'fireboat-quickstart-verify/1' || value.doctor !== 'ready' || value.instrumentation !== 'request-observer'
    || !Array.isArray(value.runs) || value.runs.length !== 18 || value.passed !== 18 || value.failed !== 0) return false;
  const wanted = new Set(PACKAGE_ERAS.flatMap(era => PACKAGE_TASKS.flatMap(task => PACKAGE_ARMS.map(arm => `${era}/${task}/${arm}`))));
  for (const run of value.runs) {
    if (!record(run) || !wanted.delete(`${run.era}/${run.task}/${run.arm}`) || run.status !== 'pass' || !Array.isArray(run.failing) || run.failing.length
      || !record(run.checks) || !Number.isInteger(run.checks.passed) || run.checks.passed < 1 || run.checks.failed !== 0
      || !Number.isInteger(run.checks.incomparable) || run.checks.incomparable < 0) return false;
  }
  if (wanted.size || !Array.isArray(value.controls) || value.controls.length !== 2) return false;
  const eras = new Set<string>(PACKAGE_ERAS);
  return value.controls.every(c => record(c) && eras.delete(c.era) && c.status === 'pass' && hex(c.cleanSha256) && c.cleanSha256 === c.observedSha256);
}

/** Negative guards are independent results. None can compensate for a failed or absent retrieval task. */
export function assertOnboarding(report: unknown, guards: readonly GuardResult[]): void {
  if (!allThreeTasksPassed(report)) throw fault('ONBOARDING_FAILED');
  const wanted = new Set<string>(PACKAGE_GUARDS);
  if (guards.length !== wanted.size || !guards.every(g => wanted.delete(g.id) && g.status === 'pass') || wanted.size) throw fault('PACKAGE_GUARDS_FAILED');
}

export type InstalledInputs = Readonly<{
  tar: string; packJson: string; helperLock: string; runDirectory: string; scratch: string; timing: string; npm: string; cache: string;
}>;
/** Explicit integration inputs never become a green skip. All paths are operator-supplied absolute paths. */
export function installedInputs(env: NodeJS.ProcessEnv): InstalledInputs {
  const keys = { tar: 'FIREBOAT_PACKAGE_TAR', packJson: 'FIREBOAT_PACKAGE_PACK_JSON', helperLock: 'FIREBOAT_PACKAGE_HELPER_LOCK',
    runDirectory: 'FIREBOAT_PACKAGE_RUN_DIR', scratch: 'FIREBOAT_PACKAGE_SCRATCH', timing: 'FIREBOAT_PACKAGE_TIMING', npm: 'npm_execpath', cache: 'FIREBOAT_PACKAGE_CACHE' } as const;
  const result: Record<string, string> = {};
  for (const [key, variable] of Object.entries(keys)) {
    const value = env[variable] ?? (key === 'packJson' && env.FIREBOAT_PACKAGE_TAR ? `${env.FIREBOAT_PACKAGE_TAR}.pack.json`
      : key === 'cache' ? join(homedir(), '.npm') : undefined);
    if (!value || !isAbsolute(value) || value.includes('\0')) throw fault('PACKAGE_INPUT_REQUIRED');
    result[key] = value;
  }
  return result as InstalledInputs;
}

export type InstallState = InstalledInputs & Readonly<{ node: string; extracted: string; cwd: string; gateway: string; helper: string; config: string; cli: string; helperCli: string }>;
export function installState(input: InstalledInputs, node: string): InstallState {
  const base = resolve(input.scratch);
  return { ...input, scratch: base, node, extracted: join(base, 'extracted'), cwd: join(base, 'unrelated-cwd'),
    gateway: join(base, 'gateway'), helper: join(base, 'helper'), config: join(base, 'helper/examples/quickstart/config.json'),
    cli: join(base, 'gateway/node_modules/@fireboat/gateway/dist/packages/server/src/cli.js'), helperCli: join(base, 'helper/dist/examples/quickstart/main.js') };
}
export const INSTALL_STEPS = ['prerequisites', 'gateway-install', 'helper-install', 'configuration', 'startup', 'doctor', 'verification', 'cleanup'] as const;
export type InstallStep = typeof INSTALL_STEPS[number];
export type InstallCommand = Readonly<{ stage: InstallStep; file: string; args: readonly string[] }>;
export function installPlan(state: InstallState, worker = fileURLToPath(import.meta.url)): InstallCommand[] {
  return INSTALL_STEPS.map(stage => ({ stage, file: state.node, args: [worker, '--step', stage, '--state', join(state.scratch, 'state.json')] }));
}
export function installedEnvironment(state: Pick<InstallState, 'node' | 'scratch'>): NodeJS.ProcessEnv {
  // In particular no inherited NODE_PATH/NODE_OPTIONS, proxy, credentials, config aliases, npm config or loaders.
  return { PATH: [dirname(state.node), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(delimiter), HOME: state.scratch,
    TMPDIR: state.scratch, ...(process.platform === 'win32' && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) };
}

export interface CommandResult { code: number | null; stdout: string; stderr: string; bounded: boolean }
export type CommandExecutor = (file: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeout: number }) => Promise<CommandResult>;
export const executeCommand: CommandExecutor = (file, args, options) => new Promise(accept => {
  const child = spawn(file, [...args], { ...options, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', bounded = true;
  const stop = () => { bounded = false; child.kill('SIGKILL'); };
  const timer = setTimeout(stop, options.timeout);
  child.stdout.on('data', b => { stdout += b; if (Buffer.byteLength(stdout) > 1_048_576) stop(); });
  child.stderr.on('data', b => { stderr += b; if (Buffer.byteLength(stderr) > 1_048_576) stop(); });
  child.once('error', () => { bounded = false; });
  // close, not exit: reap the process and its output pipes before returning, even on spawn failure or a timeout.
  child.once('close', code => { clearTimeout(timer); accept({ code, stdout, stderr, bounded }); });
});

/** The standalone timer must retain every attempted stage and its outcome on the same clock. */
export function assertInstallStages(clock: unknown, stages: readonly unknown[]): void {
  if (!record(clock) || clock.schema !== 1 || clock.errors !== 0 || !Number.isFinite(clock.elapsedMs) || clock.elapsedMs < 0
    || !Array.isArray(clock.events) || clock.events.length !== INSTALL_STEPS.length * 2 || stages.length !== INSTALL_STEPS.length) throw fault('PACKAGE_STAGES_FAILED');
  let previous = 0;
  for (const [i, stage] of INSTALL_STEPS.entries()) {
    const row = stages[i];
    if (!record(row) || row.stage !== stage || row.status !== 'pass') throw fault('PACKAGE_STAGES_FAILED');
    for (const [j, outcome] of ['start', 'success'].entries()) {
      const event = clock.events[i * 2 + j];
      if (!record(event) || event.stage !== stage || event.outcome !== outcome || !Number.isFinite(event.elapsedMs)
        || event.elapsedMs < previous || event.elapsedMs > clock.elapsedMs) throw fault('PACKAGE_STAGES_FAILED');
      previous = event.elapsedMs;
    }
  }
}

const run = (s: InstallState, args: readonly string[], timeout = 30_000) => executeCommand(s.node, args, { cwd: s.cwd, env: installedEnvironment(s), timeout });
const gateway = (s: InstallState, args: readonly string[], preload?: string) => run(s, [...(preload ? ['--require', preload] : []), s.cli, ...args]);
const helper = (s: InstallState, args: readonly string[], timeout?: number) => run(s, [s.helperCli, ...args], timeout);
function succeeded(r: CommandResult): void { requireThat(r.bounded && r.code === 0 && r.stderr === '', 'PACKAGE_COMMAND_FAILED'); }
function refused(r: CommandResult, code: number, line: string): void {
  requireThat(r.bounded && r.code === code && r.stdout === '' && r.stderr === `${line}\n`, 'PACKAGE_NEGATIVE_FAILED');
}

/** No npm bin links are created or used. Every installed tree entry, including dependencies, must be a real file/directory. */
export async function assertNoLinks(directory: string): Promise<void> {
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory() && !info.isFile()) throw fault('PACKAGE_LINK');
  if (info.isDirectory()) for (const child of await readdir(directory)) await assertNoLinks(join(directory, child));
}

async function runtimeGuard(s: InstallState): Promise<void> {
  const path = join(s.scratch, 'runtime-negative.cjs');
  try {
    for (const code of ["Object.defineProperty(process.versions, 'node', {value:'23.99.0'});", 'JSON.rawJSON = undefined;', 'JSON.isRawJSON = undefined;',
      "const parse = JSON.parse; JSON.parse = (text, reviver) => parse(text, reviver && function (k,v) { return reviver.call(this,k,v); });"]) {
      await writeFile(path, code, { mode: 0o600 });
      refused(await gateway(s, ['--doctor'], path), 2, 'fireboat: RUNTIME_UNSUPPORTED');
      succeeded(await gateway(s, ['--version'], path)); succeeded(await gateway(s, ['--help'], path));
    }
  } finally { await rm(path, { force: true }); }
}

async function assetGuard(s: InstallState): Promise<void> {
  const dist = resolve(dirname(s.cli), '../../..'), releasePath = join(dirname(s.cli), 'generated/release.json'), release = await json(releasePath);
  for (const [label, asset] of [...Object.entries(release.assets).map(([label, v]) => [label, (v as { path: string }).path] as const), ['release', 'packages/server/src/generated/release.json']]) {
    const path = join(dist, asset!), bytes = await readFile(path), mode = (await lstat(path)).mode & 0o7777;
    try {
      await rm(path);
      refused(await gateway(s, ['--doctor']), 2, `fireboat: ASSET_MISSING ${label}`);
      await writeFile(path, `${bytes.toString()}\n`);
      if (label !== 'release') refused(await gateway(s, []), 2, `fireboat: ASSET_INVALID ${label}`);
    } finally { await writeFile(path, bytes); await chmod(path, mode); } // Recreated files restore their installed mode, not the umask default.
  }
  const main = join(dirname(s.cli), 'main.js'), bytes = await readFile(main);
  try {
    await writeFile(main, "throw new Error('PRIVATE-STARTUP-CANARY');\n");
    refused(await gateway(s, ['--doctor']), 2, 'fireboat: STARTUP_FAILED');
  } finally { await writeFile(main, bytes); }
}

const VERSIONS = { modern: '2026-07-28', legacy: '2025-11-25' } as const;
const meta = (version: string) => ({ 'io.modelcontextprotocol/protocolVersion': version,
  'io.modelcontextprotocol/clientInfo': { name: 'package-guard', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} });

/** Small bounded wire guard: all stdout must be complete JSON-RPC frames. No raw bodies reach ordinary logs. */
export async function wireGuard(s: InstallState, era: typeof PACKAGE_ERAS[number], termination: 'eof' | 'SIGTERM' | 'SIGINT' = 'eof'): Promise<void> {
  const child = spawn(s.node, [s.cli, '--config', s.config], { cwd: s.cwd, env: installedEnvironment(s), shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '', stderr = '', invalid = false, bytes = 0, ended = false;
  const pending = new Map<number, (value: any) => void>();
  child.stdin.on('error', () => { invalid = true; });
  child.on('error', () => { invalid = true; });
  const closed = new Promise<number | null>(accept => child.once('close', code => { ended = true; accept(code); }));
  const deadline = setTimeout(() => { invalid = true; child.kill('SIGKILL'); }, 30_000);
  child.stderr.on('data', b => { stderr += b; if (stderr.length > 16384) { invalid = true; child.kill('SIGKILL'); } });
  child.stdout.on('data', b => {
    bytes += b.length; buffer += b;
    if (bytes > 1_048_576) { invalid = true; child.kill('SIGKILL'); return; }
    const lines = buffer.split('\n'); buffer = lines.pop()!;
    for (const line of lines) {
      try {
        const frame = JSON.parse(line);
        if (!record(frame) || frame.jsonrpc !== '2.0' || !('method' in frame || 'result' in frame || 'error' in frame)) throw fault('PACKAGE_STDOUT');
        const accept = pending.get(frame.id); pending.delete(frame.id); accept?.(frame);
      } catch { invalid = true; }
    }
  });
  const request = (id: number, method: string, params: Record<string, unknown>) => new Promise<any>((accept, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(fault('PACKAGE_WIRE_TIMEOUT')); }, 5000);
    pending.set(id, value => { clearTimeout(timer); accept(value); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const call = (id: number, version: string) => request(id, 'tools/call', { _meta: meta(version), name: 'fhir_capabilities', arguments: { topic: 'context' } });
  try {
    const version = VERSIONS[era];
    if (era === 'modern') {
      const rejected = await request(1, 'server/discover', { _meta: meta('2099-01-01') });
      requireThat(rejected.error?.code === -32022, 'PACKAGE_ERA');
      const opening = await request(2, 'server/discover', { _meta: meta(version) });
      requireThat(JSON.stringify(opening.result?.supportedVersions) === JSON.stringify([version]), 'PACKAGE_ERA');
    } else {
      const opening = await request(2, 'initialize', { protocolVersion: version, capabilities: {}, clientInfo: { name: 'package-guard', version: '1' } });
      requireThat(opening.result?.protocolVersion === version, 'PACKAGE_ERA');
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    }
    const tools = await request(3, 'tools/list', { _meta: meta(version) });
    requireThat(JSON.stringify(tools.result?.tools?.map((t: any) => t.name).sort()) === JSON.stringify(['fhir_capabilities', 'fhir_page', 'fhir_read', 'fhir_result', 'fhir_search']), 'PACKAGE_TOOLS');
    requireThat((await call(4, VERSIONS[era === 'modern' ? 'legacy' : 'modern'])).error?.code === -32022, 'PACKAGE_ERA');
    const good = await call(5, version);
    requireThat(!good.error && good.result?.structuredContent?.schema_version === '0.3' && !good.result.structuredContent.error, 'PACKAGE_ERA');
    if (termination === 'eof') child.stdin.end(); else child.kill(termination);
    const code = await closed;
    requireThat(code === 0, 'PACKAGE_LIFECYCLE_EXIT');
    requireThat(!invalid && buffer === '', 'PACKAGE_STDOUT');
    // The SDK reports the intentionally rejected modern opening claim through onerror once.
    // The adapter's later cross-era refusal does not invoke onerror. No other stderr is admitted.
    requireThat(stderr === (era === 'modern' ? 'fireboat: TRANSPORT_ERROR\n' : ''), 'PACKAGE_STDERR');
  } finally {
    clearTimeout(deadline);
    if (!ended) { child.kill('SIGKILL'); await closed; }
  }
}

async function seamGuard(s: InstallState): Promise<void> {
  const config = await json(s.config), path = join(s.scratch, 'seam-negative.json');
  try {
    for (const value of [{ ...config, testQueryProfile: {} }, { ...config, testOptions: {} },
      { ...config, source: { ...config.source, testQueryProfile: {} } }, { ...config, source: { ...config.source, searchProfile: 'private-s4-candidate' } }]) {
      await writeFile(path, JSON.stringify(value), { mode: 0o600 });
      const r = await gateway(s, ['--config', path]);
      requireThat(r.bounded && r.code === 2 && r.stdout === '' && /^fireboat: (?:CONFIG_INVALID|PROFILE_INVALID)\n$/.test(r.stderr), 'PACKAGE_SEAM');
    }
    refused(await gateway(s, ['--test-query-profile', 'private-s4-candidate', '--config', s.config]), 2, 'fireboat: ARGUMENTS_INVALID');
  } finally { await rm(path, { force: true }); }
}

async function helperNegatives(s: InstallState): Promise<void> {
  for (const args of [[], ['--help'], ['verify'], ['prepare', '--run-dir', 'relative'], ['up']]) refused(await helper(s, args), 2, 'CLI_USAGE');
  const missing = join(s.scratch, 'absent-run');
  refused(await helper(s, ['verify', '--run-dir', missing, '--node', s.node, '--cli', s.cli, '--config', s.config]), 1, 'RUN_INVALID');
  const asset = join(s.helper, 'examples/quickstart/seed-manifest.json'), bytes = await readFile(asset);
  try {
    await rm(asset);
    refused(await helper(s, ['verify', '--run-dir', missing, '--node', s.node, '--cli', s.cli, '--config', s.config]), 1, 'HELPER_FAILED');
  } finally { await writeFile(asset, bytes); }
}

/** Guard failures are reported individually and do not suppress the retrieval-task attempt. */
export async function collectGuards(execute: (id: GuardResult['id']) => Promise<void>): Promise<GuardResult[]> {
  const guards: GuardResult[] = [];
  for (const id of PACKAGE_GUARDS) {
    try { await execute(id); guards.push({ id, status: 'pass' }); }
    catch (e) { guards.push({ id, status: 'fail', code: e instanceof PackageQuickstartFault ? e.code : 'PACKAGE_GUARD_FAILED' }); }
  }
  return guards;
}

/** Also callable for an explicitly labelled offline rehearsal with an ephemeral seed-backed source. */
export const runInstalledGuards = (s: InstallState): Promise<GuardResult[]> => collectGuards(id => ({ runtime: runtimeGuard, 'missing-asset': assetGuard,
  stdout: (state: InstallState) => wireGuard(state, 'modern'),
  lifecycle: async (state: InstallState) => { for (const era of PACKAGE_ERAS) for (const how of ['eof', 'SIGTERM', 'SIGINT'] as const) await wireGuard(state, era, how); },
  seam: seamGuard, 'helper-negatives': helperNegatives })[id](s));

export async function installComponent(s: InstallState, component: 'gateway' | 'helper', execute: CommandExecutor = executeCommand): Promise<void> {
  const command = (args: readonly string[], timeout: number) => execute(s.node, args, { cwd: s.cwd, env: installedEnvironment(s), timeout });
  const prefix = component === 'gateway' ? s.gateway : s.helper;
  if (component === 'gateway') {
    await mkdir(prefix, { mode: 0o700 });
    await save(join(prefix, 'package.json'), { name: 'fireboat-install-probe', version: '0.0.0', private: true });
  }
  else {
    requireThat((await readFile(s.helperLock)).equals(await readFile(join(s.extracted, 'quickstart/package-lock.json'))), 'PACKAGE_HELPER_LOCK');
    await cp(join(s.extracted, 'quickstart'), prefix, { recursive: true, force: false, errorOnExist: true });
    await chmod(prefix, 0o700);
  }
  const args = [s.npm, '--prefix', prefix, ...(component === 'gateway' ? ['install', '--save-exact', s.tar] : ['ci']),
    '--offline', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--bin-links=false', '--logs-max=0', '--cache', join(s.scratch, 'npm-cache')];
  const result = await command(args, 120_000);
  requireThat(result.bounded && result.code === 0, 'PACKAGE_INSTALL_FAILED');
  await assertNoLinks(prefix);
  const tree = await command([s.npm, '--prefix', prefix, 'ls', '--omit=dev', '--all', '--json', '--long'], 30_000);
  requireThat(tree.bounded && tree.code === 0, 'PACKAGE_TREE_FAILED');
  await save(join(s.scratch, `${component}-tree.json`), JSON.parse(tree.stdout));
}

async function runStep(s: InstallState, step: InstallStep): Promise<void> {
  if (step === 'prerequisites') {
    for (const path of [s.tar, s.packJson, s.helperLock, s.timing, s.npm, s.node]) requireThat((await lstat(path)).isFile(), 'PACKAGE_INPUT_REQUIRED');
    requireThat((await lstat(s.runDirectory)).isDirectory() && (await lstat(s.runDirectory)).mode % 0o1000 === 0o700, 'PACKAGE_RUN_REQUIRED');
    const receipt = await json(join(s.runDirectory, 'receipt.json'));
    requireThat(receipt.schema === 'fireboat-quickstart-run/1' && receipt.phase === 'complete' && hex(receipt.packetSha256) && hex(receipt.attemptSha256), 'PACKAGE_RUN_REQUIRED');
    for (const name of ['attempt.json', 'setup-packet.json']) requireThat((await lstat(join(s.runDirectory, name))).isFile(), 'PACKAGE_RUN_REQUIRED');
    requireThat((await readFile(s.helperLock)).equals(await readFile(join(s.extracted, 'quickstart/package-lock.json'))), 'PACKAGE_HELPER_LOCK');
    requireThat((await readFile(s.timing)).equals(await readFile(join(s.extracted, 'quickstart/fireboat-timing.mjs'))), 'PACKAGE_TIMING_BINDING');
    await cp(join(s.cache, '_cacache'), join(s.scratch, 'npm-cache/_cacache'), { recursive: true, force: false, errorOnExist: true });
    await save(join(s.scratch, 'prerequisites-ok.json'), { ready: true });
  } else if (step === 'gateway-install' || step === 'helper-install') {
    requireThat((await json(join(s.scratch, 'prerequisites-ok.json'))).ready, 'PACKAGE_PREREQUISITES');
    await installComponent(s, step === 'gateway-install' ? 'gateway' : 'helper');
  } else if (step === 'configuration') {
    const result = await helper(s, ['configs', '--node', s.node, '--cli', s.cli, '--config', s.config, '--out', join(s.scratch, 'host-configs.json')]);
    succeeded(result); requireThat(/^CONFIGS_OK forms=4 sha256=[a-f0-9]{64}\n$/.test(result.stdout), 'PACKAGE_CONFIGURATION');
  } else if (step === 'startup') {
    const r = await gateway(s, ['--version']); succeeded(r);
    requireThat(/^fireboat \S+ schema=0\.3 node=\S+ runtime=(recorded|unverified)\n$/.test(r.stdout), 'PACKAGE_VERSION');
    succeeded(await gateway(s, ['--help']));
    const guards = await runInstalledGuards(s);
    await save(join(s.scratch, 'guards.json'), guards);
    requireThat(guards.every(g => g.status === 'pass'), 'PACKAGE_GUARDS_FAILED');
  } else if (step === 'doctor') {
    const r = await gateway(s, ['--doctor', '--config', s.config]); succeeded(r);
    requireThat(r.stdout.startsWith('doctor: ready\n'), 'PACKAGE_DOCTOR');
  } else if (step === 'verification') {
    const before = new Set(await readdir(s.runDirectory));
    const result = await helper(s, ['verify', '--run-dir', s.runDirectory, '--node', s.node, '--cli', s.cli, '--config', s.config], 300_000);
    const created = (await readdir(s.runDirectory)).filter(name => !before.has(name) && /^verify-[A-Za-z0-9_-]+$/.test(name));
    requireThat(created.length === 1, 'PACKAGE_REPORT_MISSING');
    const directory = join(s.runDirectory, created[0]!), report: VerifyReport = await json(join(directory, 'verify-report.json'));
    await save(join(s.scratch, 'task-report.json'), report);
    requireThat(report.launch.cliSha256 === hash(await readFile(s.cli)) && report.launch.configSha256 === hash(await readFile(s.config))
      && report.evidenceSha256 === hash(await readFile(join(directory, 'verify-evidence.ndjson'))), 'PACKAGE_EVIDENCE_BINDING');
    requireThat(result.bounded && result.code === 0 && result.stderr === ''
      && /^VERIFY_OK runs=18 passed=18 failed=0 limitations=[A-Z_,a-z]+ evidence=[a-f0-9]{64}\n$/.test(result.stdout), 'PACKAGE_VERIFY_FAILED');
    assertOnboarding(report, await json(join(s.scratch, 'guards.json')));
  } else if (step === 'cleanup') {
    // Processes and temporary negative mutations are restored by their finally blocks. The supplied HAPI remains root-owned.
    for (const name of ['runtime-negative.cjs', 'seam-negative.json']) await rm(join(s.scratch, name), { force: true });
    await assertNoLinks(s.gateway); await assertNoLinks(s.helper);
  }
}

/** All steps persist fixed status codes. Output never includes npm logs, raw frames, paths or synthetic identifiers. */
async function worker(step: InstallStep, statePath: string): Promise<number> {
  const state: InstallState = await json(statePath);
  let code = 'ok', status: 'pass' | 'fail' = 'pass';
  try { await runStep(state, step); }
  catch (e) { status = 'fail'; code = e instanceof PackageQuickstartFault ? e.code : 'PACKAGE_STAGE_FAILED'; }
  await save(join(state.scratch, `${step}.json`), { stage: step, status, code });
  process.stdout.write(`PACKAGE_STAGE ${step} ${status} ${code}\n`);
  return status === 'pass' ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , flag, step, stateFlag, statePath, ...extra] = process.argv;
  try {
    if (flag !== '--step' || !INSTALL_STEPS.includes(step as InstallStep) || stateFlag !== '--state' || !statePath || !isAbsolute(statePath) || extra.length) throw fault('PACKAGE_USAGE');
    process.exitCode = await worker(step as InstallStep, statePath);
  } catch { process.stderr.write('PACKAGE_WORKER_FAILED\n'); process.exitCode = 1; }
}
