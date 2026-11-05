#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GENERATOR_PINS, QuickstartFault, sha256, validateGeneratorPins } from '../../examples/quickstart/manifest.ts';

/** @typedef {'GENERATION_PATH_INVALID' | 'JAR_MISMATCH' | 'GENERATION_FAILED' | 'EXPORT_INVALID' | 'EXPORTS_DIFFER' | 'GENERATION_IO' | 'GENERATION_ARGUMENTS'} GenerationFaultCode */
const GENERATION_FAULT_CODES = Object.freeze(['GENERATION_PATH_INVALID', 'JAR_MISMATCH', 'GENERATION_FAILED', 'EXPORT_INVALID',
  'EXPORTS_DIFFER', 'GENERATION_IO', 'GENERATION_ARGUMENTS']);
export class GenerationFault extends Error {
  /** @param {GenerationFaultCode} code */
  constructor(code) {
    code = GENERATION_FAULT_CODES.includes(code) ? code : 'GENERATION_IO';
    super(code); this.name = 'GenerationFault'; this.code = code;
  }
}
const fault = code => new GenerationFault(code);
const safeMountPath = value => typeof value === 'string' && isAbsolute(value) && !/[,\0\r\n]/.test(value);
const MAX_EXPORT_BYTES = 268_435_456;
const MAX_EXPORT_FILES = 4096;

export function generationProperties(pins) {
  return Object.entries(pins.generation.properties).sort(([a], [b]) => a.localeCompare(b, 'en'))
    .map(([key, value]) => `${key}=${value}\n`).join('');
}

export function generationCommand(pins, jar, config, output) {
  if (![jar, config, output].every(safeMountPath)) throw fault('GENERATION_PATH_INVALID');
  const g = pins.generation;
  return {
    file: 'docker',
    args: ['run', '--rm', '--pull', 'never', '--network', 'none', '--platform', pins.jdk.platform,
      '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=128m',
      '--env', `TZ=${g.timezone}`, '--env', `LANG=${g.locale}`, '--env', `LC_ALL=${g.locale}`,
      '--mount', `type=bind,src=${jar},dst=/synthea.jar,readonly`,
      '--mount', `type=bind,src=${config},dst=/generation.properties,readonly`,
      '--mount', `type=bind,src=${output},dst=/output`,
      `eclipse-temurin@${pins.jdk.childDigest}`,
      'java', '-Duser.timezone=UTC', '-Duser.language=en', '-Duser.country=US', '-Dfile.encoding=UTF-8',
      '-jar', '/synthea.jar', '-s', String(g.seed), '-cs', String(g.clinicianSeed),
      '-p', String(g.population), '-a', `${g.ages.min}-${g.ages.max}`,
      '-r', g.referenceDate, '-e', g.endDate, '-c', '/generation.properties', g.state]
  };
}

function validExports(exports) {
  if (!(exports instanceof Map) || exports.size < 1 || exports.size > MAX_EXPORT_FILES) return false;
  let total = 0;
  for (const [name, bytes] of exports) {
    if (typeof name !== 'string' || !/^fhir\/[A-Za-z0-9_.-]+\.json$/.test(name) ||
      !(bytes instanceof Uint8Array)) return false;
    total += bytes.byteLength;
    if (total > MAX_EXPORT_BYTES) return false;
  }
  return true;
}
export function sameExports(first, second) {
  return first.size === second.size && [...first].every(([name, bytes]) =>
    second.has(name) && Buffer.from(bytes).equals(Buffer.from(second.get(name))));
}

// The adapter is the only effect boundary. Unit tests supply a fake adapter;
// the CLI always uses localExecutor and has no acquisition/pull operation.
export async function generateSynthea({ jarPath, outputRoot, pins = GENERATOR_PINS }, executor = localExecutor) {
  pins = validateGeneratorPins(pins);
  if (![jarPath, outputRoot].every(safeMountPath)) throw fault('GENERATION_PATH_INVALID');
  try {
    const jar = await executor.inspectJar(jarPath);
    if (jar.sha256 !== pins.synthea.sha256 || jar.bytes !== pins.synthea.bytes) throw fault('JAR_MISMATCH');
    const dirs = await executor.createWorkspace(outputRoot);
    const properties = generationProperties(pins);
    await executor.writeProperties(dirs.config, properties);
    const snapshots = [];
    for (const output of [dirs.first, dirs.second]) {
      const result = await executor.run(generationCommand(pins, jar.path, dirs.config, output));
      if (result.code !== 0) throw fault('GENERATION_FAILED');
      const snapshot = await executor.readExports(output);
      if (!validExports(snapshot)) throw fault('EXPORT_INVALID');
      // Snapshot immediately so a reused/mutated fake buffer cannot hide drift.
      snapshots.push(new Map([...snapshot].map(([name, bytes]) => [name, Buffer.from(bytes)])));
    }
    const [first, second] = snapshots;
    if (!sameExports(first, second)) throw fault('EXPORTS_DIFFER');
    const files = [...first].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([name, bytes]) => ({ name, bytes: bytes.byteLength, sha256: sha256(bytes) }));
    return { schema: 1, configSha256: sha256(properties), files,
      rawExportsSha256: sha256(JSON.stringify(files)), runs: 2 };
  } catch (error) {
    if (error instanceof GenerationFault) throw error;
    throw fault('GENERATION_IO');
  }
}

// Tests inject a recording spawner; the CLI uses the native spawner. Docker
// client routing/configuration stays outside the container's fixed environment.
export function createLocalExecutor(spawnCommand = spawn, environment = process.env) {
  return {
    async inspectJar(path) {
      const actual = await realpath(path), info = await lstat(actual);
      if (!safeMountPath(actual) || !info.isFile() || info.size !== GENERATOR_PINS.synthea.bytes) throw fault('JAR_MISMATCH');
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(actual)) hash.update(chunk);
      return { path: actual, bytes: info.size, sha256: hash.digest('hex') };
    },
    async createWorkspace(root) {
      await mkdir(root, { mode: 0o700 });
      const actual = await realpath(root);
      if (!safeMountPath(actual)) throw fault('GENERATION_PATH_INVALID');
      const first = join(actual, 'first'), second = join(actual, 'second');
      await mkdir(first, { mode: 0o700 }); await mkdir(second, { mode: 0o700 });
      return { first, second, config: join(actual, 'generation.properties') };
    },
    async writeProperties(path, content) { await writeFile(path, content, { flag: 'wx', mode: 0o600 }); },
    async run({ file, args }) {
      return new Promise((accept, reject) => {
        // Ignore child diagnostics: generator output must not become ordinary logs.
        const env = Object.fromEntries(['PATH', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'HOME']
          .filter(key => environment[key] !== undefined).map(key => [key, environment[key]]));
        const child = spawnCommand(file, args, { stdio: 'ignore', env });
        const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(fault('GENERATION_FAILED')); }, 600_000);
        child.once('error', () => { clearTimeout(timeout); reject(fault('GENERATION_FAILED')); });
        child.once('exit', code => { clearTimeout(timeout); accept({ code }); });
      });
    },
    async readExports(root) {
      const files = new Map(); let total = 0;
      const visit = async (directory, prefix, depth) => {
        if (depth > 2) throw fault('EXPORT_INVALID');
        for (const name of (await readdir(directory)).sort()) {
          const path = join(directory, name), info = await lstat(path), relative = `${prefix}${name}`;
          if (info.isDirectory()) await visit(path, `${relative}/`, depth + 1);
          else {
            if (!info.isFile() || files.size >= MAX_EXPORT_FILES || (total += info.size) > MAX_EXPORT_BYTES) throw fault('EXPORT_INVALID');
            files.set(relative, await readFile(path));
          }
        }
      };
      await visit(root, '', 0);
      return files;
    }
  };
}
const localExecutor = createLocalExecutor();

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  try {
    if (args.length !== 4 || args[0] !== '--jar' || args[2] !== '--out') throw fault('GENERATION_ARGUMENTS');
    const result = await generateSynthea({ jarPath: args[1], outputRoot: args[3] });
    process.stdout.write(`${JSON.stringify({ schema: result.schema, runs: result.runs, files: result.files.length,
      configSha256: result.configSha256, rawExportsSha256: result.rawExportsSha256 })}\n`);
  } catch (error) {
    const code = error instanceof GenerationFault || error instanceof QuickstartFault ? error.code : 'GENERATION_IO';
    process.stderr.write(`${code}\n`); process.exitCode = 1;
  }
}
