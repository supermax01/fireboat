// Arm registry: every server the benchmark compares, with its pin, install directory and exact launch command.
// Install is in servers/install.ts, launch (recording stdio transport) in servers/launch.ts, and the per-arm adapters
// and parsers in servers/adapters.ts and servers/parsers.ts.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { Client } from '@modelcontextprotocol/client';
import { byFamily, REPO, SERVERS_DIR, slotPorts } from '../lib/paths.js';
import { nodeBin, nodeBinDir } from '../lib/toolchain.js';
import { EGRESS_PROFILE, SANDBOX_EXEC as INFRA_SANDBOX_EXEC } from '../infra/egress.js';
import { medplumTokenFor, wso2MedplumEnv } from './medplum.js';
import { AH_CONFIG_FILE, ahAwsConfig, ahEnv } from './healthlake.js';
import type { ArmId, CallRecord, LaunchContext, ParsedResult, SearchParams, ServerCommand, ToolCall } from '../lib/types.js';

/** Node 24.22.0 through mise (lib/toolchain.ts), resolved once at import. */
export const NODE_BIN_DIR = nodeBinDir();
export const NODE_BIN = nodeBin();

export interface ArmPin {
  name: string;
  version: string;
  source: string;
  commit?: string;
  /**
   * fireboat arms built from this repository: 'HEAD' (the enclosing checkout at HEAD, the default), 'FB_COMMIT' (the
   * commit the FB_COMMIT environment variable names) or 'fixed' (FB0's fixed commit).
   */
  commitFrom?: 'HEAD' | 'FB_COMMIT' | 'fixed';
  /**
   * With commitFrom 'HEAD': whether the checkout had uncommitted changes when the commit was resolved. The build is
   * always a clean clone at `commit`, so such changes are not in it.
   */
  treeDirty?: boolean;
  artifactSha256?: string; // wheel sha256
  npmIntegrity?: string;
  runtime: string;
}

export interface Refusal { refused: string } // the adapter cannot express the operation with this server's tools

export interface Adapter {
  capabilities(type: string | null): ToolCall | Refusal;
  read(type: string, id: string): ToolCall | Refusal;
  /** pageSize: HAPI's recorded max_page_size for W, M, H; 100 for fireboat. */
  search(type: string, params: SearchParams, pageSize: number): { call: ToolCall; flags: string[] } | Refusal;
  /** Only the server's documented paging mechanism. W and M: always cannot_continue in the default cell. */
  next(previous: ParsedResult): ToolCall | { cannot_continue: string };
}

/** Shape only: never filters, deduplicates, re-sorts, repairs units or fetches. */
export interface Parser { parse(call: CallRecord): ParsedResult }

export type CallOutcome = Omit<CallRecord, 'seq' | 'op_index' | 'op'>;

export interface ArmSession {
  client: Client;
  pid: number | null;
  coldStartMs: number;
  protocolVersion: string | null;
  serverInfo: unknown;
  instructionsBytes: number;
  toolsListBytes: number;
  toolNames: string[];
  /** Calls one tool and returns the raw response line, bytes and timing. Never throws for server-side failures. */
  call(call: ToolCall, timeoutMs: number): Promise<CallOutcome>;
  close(): Promise<{ code: number | null; signal: string | null }>;
}

export interface ArmSpec {
  id: ArmId;
  /** 'deferred': registered but not implemented. 'unavailable': implemented, but cannot be built here (see `unavailable`). */
  status: 'active' | 'deferred' | 'unavailable';
  /** With status 'unavailable': one sentence saying why, printed when the arm is skipped. */
  unavailable?: string;
  pin: ArmPin | null; // null for NT
  installDir: string | null;
  command: ((ctx: LaunchContext) => ServerCommand) | null; // null for NT
}

/** Runs git in the repository that holds this harness. Throws when git fails. */
export type GitRunner = (args: readonly string[]) => string;
export const repoGit: GitRunner = args =>
  execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/** The fireboat source an arm builds: a commit of this repository and how it was chosen. */
export interface FireboatSource { commit: string; commitFrom: 'HEAD' | 'FB_COMMIT'; treeDirty: boolean; version: string }

/** fireboat's package version at `commit`, read from its package.json; 'unknown' when it cannot be read. */
function versionAt(commit: string, git: GitRunner): string {
  try {
    const v = (JSON.parse(git(['show', `${commit}:package.json`])) as { version?: unknown }).version;
    return typeof v === 'string' && v ? v : 'unknown';
  } catch { return 'unknown'; }
}

/**
 * Which fireboat the FB, FBd, FBt, FBh and FBdh arms build. By default the enclosing checkout at HEAD: the fireboat
 * source this harness ships with. FB_COMMIT (environment) names another commit of this repository instead (a full or
 * abbreviated hash, a tag or a branch; resolved to a full hash). The build is always a clean clone at the resolved
 * commit; with HEAD, `treeDirty` records whether the checkout had uncommitted changes, which the build does not contain.
 * Returns a reason instead when git cannot resolve the commit (not a git checkout, or an unknown FB_COMMIT).
 */
export function resolveFireboatSource(env: NodeJS.ProcessEnv = process.env, git: GitRunner = repoGit): FireboatSource | { unavailable: string } {
  const requested = env.FB_COMMIT?.trim();
  try {
    if (requested) {
      const commit = git(['rev-parse', '--verify', '--quiet', `${requested}^{commit}`]);
      return { commit, commitFrom: 'FB_COMMIT', treeDirty: false, version: versionAt(commit, git) };
    }
    const commit = git(['rev-parse', '--verify', 'HEAD^{commit}']);
    return { commit, commitFrom: 'HEAD', treeDirty: git(['status', '--porcelain']).length > 0, version: versionAt(commit, git) };
  } catch {
    return { unavailable: requested
      ? `FB_COMMIT=${requested} is not a commit of this repository (${REPO})`
      : `cannot read the git HEAD of ${REPO}; the fireboat arms build from a git checkout` };
  }
}

/**
 * FB0: fireboat as first published, commit ad7f9f2. That commit is not part of every copy of the repository (the public
 * repository starts later), so FB0 is skipped with one message when it is absent.
 */
export const FB0_COMMIT = 'ad7f9f2cc980f7380631f9aec5c0ea11f709f0b6';
export function fb0Availability(git: GitRunner = repoGit): string | null {
  try { git(['cat-file', '-e', `${FB0_COMMIT}^{commit}`]); return null; } catch {
    return `FB0 builds fireboat as first published (commit ${FB0_COMMIT.slice(0, 7)}), which is not in this repository; skipping FB0`;
  }
}

/** Resolved once at import. */
export const FIREBOAT_SOURCE = resolveFireboatSource();
const fbSource = 'commit' in FIREBOAT_SOURCE ? FIREBOAT_SOURCE : null;
/** The full hash the FB arms build, or '' when it could not be resolved (the arms are then unavailable). */
export const FB_COMMIT: string = fbSource?.commit ?? '';
const FB_DIR = join(SERVERS_DIR, `fb-${FB_COMMIT.slice(0, 12) || 'unresolved'}`);

export const INSTALL_DIRS = {
  FB0: join(SERVERS_DIR, 'fb0-ad7f9f2'),
  FB: FB_DIR,
  FBd: FB_DIR, // FB's build, default privacy lists
  FBt: FB_DIR, // FB's build, FB's lists plus a dataset-specific one
  FBh: FB_DIR, // FB's build and lists, against HealthLake
  FBdh: FB_DIR, // FB's build, default lists, against HealthLake
  AH: join(SERVERS_DIR, 'healthlake-mcp-0.0.21'),
  W: join(SERVERS_DIR, 'wso2-0.11.0'),
  M: join(SERVERS_DIR, 'momentum-0.1.0'),
  H: join(SERVERS_DIR, 'fhirhydrant-0.17.3'),
  momentumHfHome: join(SERVERS_DIR, 'momentum-hf-home'),
} as const;

/** Per family (lib/paths.ts byFamily): synthea-dev and synthea-holdout share every Synthea list below. */
export const PATIENT_IDENTIFIER_SYSTEMS = byFamily<readonly string[]>({
  mimic: ['http://mimic.mit.edu/fhir/mimic/identifier/patient'],
  synthea: [
    'http://hl7.org/fhir/sid/us-ssn',
    'http://hospital.smarthealthit.org',
    'urn:oid:2.16.840.1.113883.4.3.25',
    'http://standardhealthrecord.org/fhir/StructureDefinition/passportNumber',
    'https://github.com/synthetichealth/synthea',
  ],
});

const baseEnv = (ctx: LaunchContext, pathDirs: string[]): Record<string, string> => ({
  PATH: [...pathDirs, '/usr/bin', '/bin'].join(':'),
  HOME: ctx.runDir,
  LANG: 'C.UTF-8',
  TMPDIR: ctx.runTmp,
});

/**
 * Product and organization identifier systems a deployment lists for shared records (fireboat config
 * privacy.sharedIdentifierSystems). Arms FB, FBt and FBh only: FB0 has no such setting, and FBd and FBdh use the
 * default (empty) lists. MIMIC Medication records carry NDC, formulary code and drug-name identifiers; none is a
 * patient identifier. The medication-mix system is not here: it is specific to one dataset (TUNED_SHARED_IDENTIFIER_SYSTEMS).
 */
export const SHARED_IDENTIFIER_SYSTEMS = byFamily<readonly string[]>({
  mimic: [
    'http://mimic.mit.edu/fhir/mimic/CodeSystem/mimic-medication-ndc',
    'http://mimic.mit.edu/fhir/mimic/CodeSystem/mimic-medication-formulary-drug-cd',
    'http://mimic.mit.edu/fhir/mimic/CodeSystem/mimic-medication-name',
  ],
  synthea: [],
});

/**
 * Arm FBt only: listings written for one dataset, so FBt is reported separately and labelled as tuned. MIMIC-IV
 * medication mixes carry this identifier system, and its value names the component products.
 */
export const TUNED_SHARED_IDENTIFIER_SYSTEMS = byFamily<readonly string[]>({
  mimic: ['http://mimic.mit.edu/fhir/mimic/identifier/medication-mix'],
  synthea: [],
});

/**
 * Profile canonicals a deployment lists for shared records (fireboat config privacy.sharedProfiles). Arms FB, FBt and
 * FBh only. Taken from the meta.profile values the loaded shared records carry.
 */
export const SHARED_PROFILES = byFamily<readonly string[]>({
  mimic: [
    'http://mimic.mit.edu/fhir/mimic/StructureDefinition/mimic-medication',
    'http://mimic.mit.edu/fhir/mimic/StructureDefinition/mimic-location',
    'http://mimic.mit.edu/fhir/mimic/StructureDefinition/mimic-organization',
  ],
  synthea: ['http://hl7.org/fhir/us/core/StructureDefinition/us-core-medication'],
});

/**
 * Optional size sweep: BENCH_FB_DEFAULT_BYTES (environment) sets fireboat's limits.defaultBytes for arm FB in the default
 * cell, changing nothing else. Use a campaign named after the size, so results at different sizes stay apart.
 */
const FB_SIZE_SWEEP_BYTES = (() => {
  const v = process.env.BENCH_FB_DEFAULT_BYTES;
  if (v === undefined || v === '') return null;
  if (!/^[1-9][0-9]{3,6}$/.test(v)) throw new Error('BENCH_FB_DEFAULT_BYTES must be a byte count');
  return Number(v);
})();

/** fireboat's settings in the best-effort cell: larger response and handle limits (the default cell sets no limits). */
export const FIREBOAT_BEST_EFFORT_LIMITS = { defaultBytes: 131072, maxHandles: 1000 } as const;

/**
 * Privacy lists: 'none' (FB0, FBd: fireboat's default), 'operator' (FB: the deployment's general shared-record lists) or
 * 'tuned' (FBt: FB's lists plus TUNED_SHARED_IDENTIFIER_SYSTEMS). patientIdentifierSystems is required deployment identity
 * and is always set.
 */
export type FireboatLists = 'none' | 'operator' | 'tuned';
const sharedIdentifierSystems = (lists: FireboatLists, d: LaunchContext['dataset']): string[] =>
  lists === 'none' ? [] : [...SHARED_IDENTIFIER_SYSTEMS[d], ...(lists === 'tuned' ? TUNED_SHARED_IDENTIFIER_SYSTEMS[d] : [])];
type FireboatBuild = { commit: string; version: string; commitFrom: NonNullable<ArmPin['commitFrom']>; treeDirty?: boolean };
const fireboatArm = (id: 'FB0' | 'FB' | 'FBd' | 'FBt' | 'FBh' | 'FBdh', build: FireboatBuild | { unavailable: string }, installDir: string, lists: FireboatLists): ArmSpec => {
  if (!('commit' in build)) return { id, status: 'unavailable', unavailable: build.unavailable, pin: null, installDir: null, command: null };
  const { commit } = build;
  return {
    id,
    status: 'active',
    pin: {
      name: 'fireboat',
      version: build.version,
      source: 'git clone of this repository at `commit`; npm ci && npm run build (Node 24.22.0)',
      commit,
      commitFrom: build.commitFrom,
      ...(build.treeDirty !== undefined ? { treeDirty: build.treeDirty } : {}),
      runtime: 'node 24.22.0',
    },
    installDir,
    command: ctx => ({
      command: NODE_BIN,
      args: [join(installDir, 'dist/packages/server/src/cli.js'), '--config', join(ctx.runDir, 'fireboat.json')],
      env: baseEnv(ctx, [NODE_BIN_DIR]),
      cwd: ctx.runDir,
      files: {
        'fireboat.json': JSON.stringify({
          mode: 'synthetic',
          source: { alias: 'bench', baseUrl: ctx.fhirBaseUrl,
            // HealthLake pages carry no self link and page with an echoed query plus an opaque `page` token. These two
            // fireboat settings (off by default) accept such sources. Only the HealthLake arms set them.
            ...(id === 'FBh' || id === 'FBdh' ? { selfLinkOptional: true, continuationTokenParameter: 'page' } : {}) },
          patientId: ctx.patientId,
          privacy: {
            patientIdentifierSystems: PATIENT_IDENTIFIER_SYSTEMS[ctx.dataset],
            ...(sharedIdentifierSystems(lists, ctx.dataset).length ? { sharedIdentifierSystems: sharedIdentifierSystems(lists, ctx.dataset) } : {}),
            ...(lists !== 'none' && SHARED_PROFILES[ctx.dataset].length ? { sharedProfiles: SHARED_PROFILES[ctx.dataset] } : {}),
          },
          ...(ctx.cell === 'best_effort' ? { limits: FIREBOAT_BEST_EFFORT_LIMITS }
            : id === 'FB' && FB_SIZE_SWEEP_BYTES ? { limits: { defaultBytes: FB_SIZE_SWEEP_BYTES } } : {}),
        }, null, 2) + '\n',
      },
    }),
  };
};

const fb0Missing = fb0Availability();
/** Arm FB0: fireboat as first published (FB0_COMMIT), default configuration. */
const fb0 = fireboatArm('FB0', fb0Missing ? { unavailable: fb0Missing } : { commit: FB0_COMMIT, version: '0.2.0-alpha.1', commitFrom: 'fixed' }, INSTALL_DIRS.FB0, 'none');
/** The build every current-fireboat arm shares (FIREBOAT_SOURCE). */
const fbBuild: FireboatBuild | { unavailable: string } = fbSource
  ? { commit: fbSource.commit, version: fbSource.version, commitFrom: fbSource.commitFrom, treeDirty: fbSource.treeDirty }
  : FIREBOAT_SOURCE as { unavailable: string };
/** Arm FB: the current fireboat with the operator's general shared-record lists. */
const fb = fireboatArm('FB', fbBuild, INSTALL_DIRS.FB, 'operator');
/**
 * Arm FBd: FB's commit and install with fireboat's default privacy configuration: patientIdentifierSystems as FB
 * (required deployment identity), no sharedIdentifierSystems and no sharedProfiles. What a new user gets without
 * data-specific lists. The best_effort cell uses FB's limits; the size sweep applies to FB only.
 */
const fbd = fireboatArm('FBd', fbBuild, INSTALL_DIRS.FBd, 'none');
/**
 * Arm FBt: FB's commit, install and configuration plus a listing written for one dataset (MIMIC medication mixes;
 * Synthea unchanged). Reported separately and labelled as tuned.
 */
const fbt = fireboatArm('FBt', fbBuild, INSTALL_DIRS.FBt, 'tuned');
/**
 * Arms FBh and FBdh: FB and FBd unchanged (same commit, install and configuration), with ctx.fhirBaseUrl the slot's
 * HealthLake recording proxy, whose upstream is the loopback SigV4 signing proxy (servers/healthlake.ts).
 */
const fbh = fireboatArm('FBh', fbBuild, INSTALL_DIRS.FBh, 'operator');
const fbdh = fireboatArm('FBdh', fbBuild, INSTALL_DIRS.FBdh, 'none');

/**
 * Arm AH: the AWS HealthLake MCP server 0.0.21, --readonly, from the sha256-pinned PyPI wheel and a hashed lock
 * (servers/install.ts). Credentials come from AWS profile `fireboat` through the local AWS CLI (servers/healthlake.ts);
 * no key is placed in the environment or in files.
 */
const ah: ArmSpec = {
  id: 'AH',
  status: 'active',
  pin: {
    name: 'awslabs.healthlake-mcp-server',
    version: '0.0.21',
    source: 'PyPI wheel, hash-checked, in a uv venv; launched with --readonly',
    commit: '6a2cd75824426dff2d798e252f07c59ae7890b12',
    artifactSha256: '3a56ed34776a860ca3d284555c2e1bbe071b6380aeb6f8f29a21c9c0a36519e4',
    runtime: 'python 3.12',
  },
  installDir: INSTALL_DIRS.AH,
  command: ctx => {
    const venvBin = join(INSTALL_DIRS.AH, 'venv/bin');
    return {
      command: join(venvBin, 'awslabs.healthlake-mcp-server'),
      args: ['--readonly'],
      env: { ...baseEnv(ctx, [venvBin]), ...ahEnv(ctx.runDir) },
      cwd: ctx.runDir,
      files: { [AH_CONFIG_FILE]: ahAwsConfig() },
    };
  },
};

const w: ArmSpec = {
  id: 'W',
  status: 'active',
  pin: {
    name: 'fhir-mcp-server (WSO2)',
    version: '0.11.0',
    source: 'PyPI wheel, hash-checked, in a uv venv',
    commit: 'fbb3a74e2cb63eee0eaa50eebaf4887183b6e4a0',
    artifactSha256: 'a96e65d5a8962948fd4b68f2a997fdd0b2d797af51cd6dadc21eec8078526b6b',
    runtime: 'python 3.12',
  },
  installDir: INSTALL_DIRS.W,
  command: ctx => {
    const venvBin = join(INSTALL_DIRS.W, 'venv/bin');
    return {
      command: join(venvBin, 'fhir-mcp-server'),
      args: ['--transport', 'stdio', '--log-level', 'WARN'],
      env: { ...baseEnv(ctx, [venvBin]), FHIR_SERVER_BASE_URL: ctx.fhirBaseUrl, FHIR_SERVER_DISABLE_AUTHORIZATION: 'true' },
      cwd: ctx.runDir,
      files: {},
    };
  },
};

/**
 * Arms Ws and Wm: W's pin, install and launch against the bench Medplum (servers/medplum.ts), authorization on
 * (FHIR_SERVER_DISABLE_AUTHORIZATION unset) with a static token: Ws the run patient's scoped client (Medplum AccessPolicy,
 * backend-enforced), Wm the project's system-level client. ctx.fhirBaseUrl is the slot's Medplum recording proxy.
 */
const wso2Medplum = (id: 'Ws' | 'Wm'): ArmSpec => ({
  id,
  status: 'active',
  pin: w.pin,
  installDir: INSTALL_DIRS.W,
  command: ctx => {
    const venvBin = join(INSTALL_DIRS.W, 'venv/bin');
    return {
      command: join(venvBin, 'fhir-mcp-server'),
      args: ['--transport', 'stdio', '--log-level', 'WARN'],
      env: wso2MedplumEnv(baseEnv(ctx, [venvBin]), ctx.fhirBaseUrl, medplumTokenFor(id, ctx.dataset, ctx.patientId)),
      cwd: ctx.runDir,
      files: {},
    };
  },
});
const ws = wso2Medplum('Ws');
const wm = wso2Medplum('Wm');

const m: ArmSpec = {
  id: 'M',
  status: 'active',
  pin: {
    name: 'the-momentum/fhir-mcp-server',
    version: '0.1.0',
    source: 'github.com/the-momentum/fhir-mcp-server at the tag commit; uv sync --frozen --no-dev',
    commit: 'df048bc8d4e8a784f2dd3e690d43e535355ea7ef',
    runtime: 'python 3.13.18',
  },
  installDir: INSTALL_DIRS.M,
  command: ctx => {
    const venvBin = join(INSTALL_DIRS.M, '.venv/bin');
    return {
      command: join(venvBin, 'fastmcp'),
      args: ['run', join(INSTALL_DIRS.M, 'app/main.py'), '--transport', 'stdio'],
      env: {
        ...baseEnv(ctx, [venvBin]),
        UV_OFFLINE: '1',
        HF_HOME: INSTALL_DIRS.momentumHfHome,
        HF_HUB_OFFLINE: '1',
        TRANSFORMERS_OFFLINE: '1',
        TRANSPORT_MODE: 'stdio',
        FHIR_SERVER_HOST: `http://127.0.0.1:${slotPorts(ctx.slot).tokenShim}`, // token shim -> slot proxy
        FHIR_BASE_URL: '/fhir',
        FHIR_SERVER_CLIENT_ID: 'bench',
        FHIR_SERVER_CLIENT_SECRET: 'bench',
        PINECONE_API_KEY: '',
        LOINC_ENDPOINT: 'http://127.0.0.1:9/loinc',
        PYTHONPATH: INSTALL_DIRS.M, // so app.* imports resolve with cwd = runDir
      },
      cwd: ctx.runDir,
      files: {},
    };
  },
};

const h: ArmSpec = {
  id: 'H',
  status: 'active',
  pin: {
    name: 'fhirhydrant',
    version: '0.17.3',
    source: 'npm install --ignore-scripts fhirhydrant@0.17.3, integrity checked',
    commit: 'caba5aa0cc782c71f9ebe78bd79cfdcfee6fa221',
    npmIntegrity: 'sha512-dHolSX7gDnmV0BxdQC/aJbMWjAmtCpjiv4TrWYnV+KpFym6V1BBlK+sbla4AVDEo5r/yi1k7JkGf9m/AgP2h+Q==',
    runtime: 'node 24.22.0',
  },
  installDir: INSTALL_DIRS.H,
  command: ctx => ({
    command: NODE_BIN,
    args: [join(INSTALL_DIRS.H, 'node_modules/fhirhydrant/bin/server.js')],
    env: { ...baseEnv(ctx, [NODE_BIN_DIR]), MCP_TRANSPORT: 'stdio', FHIR_AUTH: 'none', FHIR_SERVER_URL: ctx.fhirBaseUrl, NODE_ENV: 'production' },
    cwd: ctx.runDir,
    files: {},
  }),
};

const nt: ArmSpec = { id: 'NT', status: 'active', pin: null, installDir: null, command: null };
const deferred = (id: ArmId): ArmSpec => ({ id, status: 'deferred', pin: null, installDir: null, command: null });

export const ARMS: Readonly<Record<ArmId, ArmSpec>> = {
  FB0: fb0, W: w, M: m, H: h, NT: nt,
  FB: fb, FBd: fbd, FBt: fbt, Ws: ws, Wm: wm, Wn: deferred('Wn'), L: deferred('L'), FBh: fbh, FBdh: fbdh, AH: ah,
};

/**
 * Arms the scripted track runs. NT has no tools; it appears only in the agent track. Ws and Wm run against Medplum
 * only; FBh, FBdh and AH against HealthLake only (synthea-holdout). An unavailable arm stays listed and is skipped by
 * availableArms.
 */
export const SCRIPTED_ARMS: readonly ArmId[] = ['FB0', 'W', 'M', 'H', 'FB', 'FBd', 'FBt', 'FBh', 'FBdh', 'Ws', 'Wm', 'AH'];

/**
 * Arms used when a command is given no --arm: the current fireboat (built from this checkout) and WSO2, both of which
 * install from a fresh public checkout. FB0 is never a default: its commit is not in every copy of the repository.
 * run/baseline.sh and run/setup.sh use the same list (tests/servers.test.ts keeps them in agreement).
 */
export const DEFAULT_ARMS: readonly ArmId[] = ['FB', 'W'];

/** What a run record keeps about the arm's build (RunRecord.versions): its commit, else its version, and the dirty flag. */
export function armVersions(arm: ArmId, registry: Readonly<Record<ArmId, ArmSpec>> = ARMS): { arm_pin: string; arm_tree_dirty?: boolean } {
  const pin = registry[arm]?.pin;
  return { arm_pin: pin?.commit ?? pin?.version ?? '', ...(pin?.treeDirty !== undefined ? { arm_tree_dirty: pin.treeDirty } : {}) };
}

/**
 * The requested arms without the unavailable ones (FB0 when its commit is absent; the fireboat arms outside a git
 * checkout). Prints one line per skipped arm, so a run that names them goes on with the rest instead of failing.
 */
export function availableArms(arms: readonly ArmId[], say: (line: string) => void = l => process.stderr.write(`${l}\n`), registry: Readonly<Record<ArmId, ArmSpec>> = ARMS): ArmId[] {
  return arms.filter(a => {
    const spec = registry[a];
    if (spec?.status !== 'unavailable') return true;
    say(`${a}: ${spec.unavailable ?? 'unavailable'}`);
    return false;
  });
}

/** One loopback-only egress profile for the whole bench (infra/egress.ts, probed by bench:infra:up): a non-loopback
 *  connect fails, loopback works. Checked on macOS. */
export const SANDBOX_EXEC = INFRA_SANDBOX_EXEC;
export const SANDBOX_PROFILE = EGRESS_PROFILE;

/** The same command wrapped in the loopback-only egress sandbox. */
export function sandboxed(cmd: ServerCommand): ServerCommand {
  return { ...cmd, command: SANDBOX_EXEC, args: ['-p', SANDBOX_PROFILE, cmd.command, ...cmd.args] };
}

export const ENV_BIN = '/usr/bin/env';

/**
 * The command under `env -i K=V ...`: nothing inherited survives, only the arm's declared environment. Claude Code
 * merges its own environment (the Anthropic credential included) into a stdio server's
 * environment, so the agent track needs this; the scripted launch already spawns with exactly cmd.env.
 */
export function envIsolated(cmd: ServerCommand): ServerCommand {
  for (const k of Object.keys(cmd.env)) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`bad environment variable name ${k}`);
  return { ...cmd, command: ENV_BIN, args: ['-i', ...Object.entries(cmd.env).map(([k, v]) => `${k}=${v}`), cmd.command, ...cmd.args] };
}

/**
 * Claude Code --mcp-config for the agent track: the same command and environment as the scripted launch, run as
 * sandbox-exec -> env -i K=V ... -> command (sandboxed by default), server name "ehr".
 */
export function mcpConfig(cmd: ServerCommand | null, opts: { sandbox?: boolean } = {}): { mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> } {
  if (!cmd) return { mcpServers: {} };
  const isolated = envIsolated(cmd);
  const c = opts.sandbox === false ? isolated : sandboxed(isolated);
  return { mcpServers: { ehr: { command: c.command, args: c.args, env: cmd.env } } };
}
