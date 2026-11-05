import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { GENERATOR_PINS } from '../examples/quickstart/manifest.js';

type Command = { file: string; args: string[] };
type SpawnOptions = { stdio: 'ignore'; env: Record<string, string> };
type RecordingSpawn = (file: string, args: string[], options: SpawnOptions) => EventEmitter & { kill: (signal: string) => boolean };
type Executor = ReturnType<typeof fake>['executor'];
const generator = await import(new URL('../scripts/quickstart/generate-synthea.mjs', import.meta.url).href) as {
  generateSynthea: (options: { jarPath: string; outputRoot: string; pins?: unknown }, executor: Executor) => Promise<{ runs: number; files: { name: string; sha256: string }[] }>;
  createLocalExecutor: (spawnCommand: RecordingSpawn, environment: NodeJS.ProcessEnv) => { run: (command: Command) => Promise<{ code: number | null }> };
};
const input = { jarPath: '/synthetic/already-acquired.jar', outputRoot: '/synthetic/new-output' };
function fake() {
  const commands: Command[] = [], properties: string[] = [];
  const executor = {
    async inspectJar(_path: string) { return { path: input.jarPath, bytes: GENERATOR_PINS.synthea.bytes, sha256: GENERATOR_PINS.synthea.sha256 }; },
    async createWorkspace(root: string) { return { first: `${root}/first`, second: `${root}/second`, config: `${root}/generation.properties` }; },
    async writeProperties(_path: string, text: string) { properties.push(text); },
    async run(command: Command) { commands.push(command); return { code: 0 }; },
    async readExports(_path: string) { return new Map([['fhir/synthetic.json', Buffer.from('{"value":7.00}')]]); }
  };
  return { executor, commands, properties };
}

test('quickstart generation: cached JAR pinned child no pull no network and two identical runs', async () => {
  const f = fake(), result = await generator.generateSynthea(input, f.executor);
  assert.equal(result.runs, 2); assert.equal(result.files.length, 1); assert.equal(f.commands.length, 2);
  for (const { file, args } of f.commands) {
    assert.equal(file, 'docker'); assert.equal(args[0], 'run');
    assert.equal(args[args.indexOf('--pull') + 1], 'never');
    assert.equal(args[args.indexOf('--network') + 1], 'none');
    assert.equal(args[args.indexOf('--platform') + 1], 'linux/arm64');
    assert(args.includes(`eclipse-temurin@${GENERATOR_PINS.jdk.childDigest}`));
    assert(args.includes('-Duser.timezone=UTC')); assert(args.includes('-Dfile.encoding=UTF-8'));
    assert.deepEqual(args.slice(args.indexOf('-s')), ['-s', '42', '-cs', '42', '-p', '1', '-a', '60-85', '-r', '20260101', '-e', '20260101', '-c', '/generation.properties', 'Massachusetts']);
    assert(!args.some(a => /latest|https?:/.test(a)));
  }
  assert(f.commands[0]!.args.includes(`type=bind,src=${input.outputRoot}/first,dst=/output`));
  assert(f.commands[1]!.args.includes(`type=bind,src=${input.outputRoot}/second,dst=/output`));
  assert.equal(f.properties.length, 1); assert.match(f.properties[0]!, /generate.log_patients.detail=none\n/);
  assert.match(f.properties[0]!, /exporter.fhir.export=true\n/);
});
test('quickstart generation: end date and reference date are pinned in both runs', async () => {
  const f = fake();
  await generator.generateSynthea(input, f.executor);
  assert.equal(f.commands.length, 2);
  for (const { args } of f.commands) {
    assert.equal(args.filter(arg => arg === '-e').length, 1);
    assert.equal(args[args.indexOf('-e') + 1], '20260101');
    assert.equal(args.filter(arg => arg === '-r').length, 1);
    assert.equal(args[args.indexOf('-r') + 1], '20260101');
  }
});
test('quickstart generation: properties disable nondeterministic metadata export', async () => {
  const f = fake();
  await generator.generateSynthea(input, f.executor);
  assert.equal(GENERATOR_PINS.generation.properties['exporter.metadata.export'], false);
  assert.equal(f.properties.length, 1);
  assert.deepEqual(f.properties[0]!.split('\n').filter(line => line.startsWith('exporter.metadata.export=')),
    ['exporter.metadata.export=false']);
});
test('quickstart generation: executor passes exactly the Docker client environment allowlist', async () => {
  const allowed = { PATH: '/synthetic/bin', DOCKER_HOST: 'unix:///synthetic/docker.sock', DOCKER_CONTEXT: 'synthetic-context',
    DOCKER_CONFIG: '/synthetic/docker-config', HOME: '/synthetic/home' };
  const cases: { environment: NodeJS.ProcessEnv; expected: Record<string, string> }[] = [
    { environment: { ...allowed, HTTP_PROXY: 'http://proxy.invalid', NODE_OPTIONS: '--require=unreviewed',
      DOCKER_TLS_VERIFY: '1', DOCKER_CERT_PATH: '/synthetic/certs', JAVA_TOOL_OPTIONS: '-Dunreviewed=true', UNREVIEWED: 'canary' }, expected: allowed },
    { environment: { PATH: '', DOCKER_CONTEXT: '', DOCKER_HOST: undefined, UNREVIEWED: 'canary' }, expected: { PATH: '', DOCKER_CONTEXT: '' } },
    { environment: {}, expected: {} }
  ];
  for (const { environment, expected } of cases) {
    const calls: { file: string; args: string[]; options: SpawnOptions }[] = [];
    const spawnCommand: RecordingSpawn = (file, args, options) => {
      calls.push({ file, args, options });
      const child = Object.assign(new EventEmitter(), { kill: (_signal: string): boolean => { assert.fail('unexpected fake child kill'); } });
      queueMicrotask(() => child.emit('exit', 0));
      return child;
    };
    const executor = generator.createLocalExecutor(spawnCommand, environment);
    const command = { file: 'docker', args: ['run', '--pull', 'never', '--network', 'none'] };
    assert.deepEqual(await executor.run(command), { code: 0 });
    assert.deepEqual(calls, [{ ...command, options: { stdio: 'ignore', env: expected } }]);
  }
});
test('quickstart generation: missing or inconsistent end date refuses before executor calls', async () => {
  const f = fake(); let inspections = 0;
  const inspect = f.executor.inspectJar;
  f.executor.inspectJar = async path => { inspections++; return inspect(path); };
  const missing = structuredClone(GENERATOR_PINS);
  delete (missing.generation as Partial<typeof missing.generation>).endDate;
  await assert.rejects(generator.generateSynthea({ ...input, pins: missing }, f.executor), { code: 'PIN_MISSING', message: 'PIN_MISSING' });
  const mismatched = structuredClone(GENERATOR_PINS); mismatched.generation.endDate = '20260102';
  await assert.rejects(generator.generateSynthea({ ...input, pins: mismatched }, f.executor), { code: 'PIN_MISMATCH', message: 'PIN_MISMATCH' });
  assert.equal(inspections, 0); assert.deepEqual(f.commands, []); assert.deepEqual(f.properties, []);
});
test('quickstart generation: second raw numeric lexeme change refuses freeze', async () => {
  const f = fake(); let reads = 0;
  f.executor.readExports = async () => new Map([['fhir/synthetic.json', Buffer.from(++reads === 1 ? '{"value":7.00}' : '{"value":7.0}')]]);
  await assert.rejects(generator.generateSynthea(input, f.executor), { code: 'EXPORTS_DIFFER' });
  assert.equal(f.commands.length, 2);
});
test('quickstart generation: changed raw file set refuses', async () => {
  const f = fake(); let reads = 0;
  f.executor.readExports = async () => new Map([[++reads === 1 ? 'fhir/first.json' : 'fhir/second.json', Buffer.from('{}')]]);
  await assert.rejects(generator.generateSynthea(input, f.executor), { code: 'EXPORTS_DIFFER' });
});
test('quickstart generation: absent pins or mismatched local JAR cannot execute', async () => {
  const f = fake();
  await assert.rejects(generator.generateSynthea({ ...input, pins: {} }, f.executor), { code: 'PIN_MISSING' });
  f.executor.inspectJar = async () => ({ path: input.jarPath, bytes: GENERATOR_PINS.synthea.bytes, sha256: 'a'.repeat(64) });
  await assert.rejects(generator.generateSynthea(input, f.executor), { code: 'JAR_MISMATCH' });
  f.executor.inspectJar = async () => ({ path: input.jarPath, bytes: 1, sha256: GENERATOR_PINS.synthea.sha256 });
  await assert.rejects(generator.generateSynthea(input, f.executor), { code: 'JAR_MISMATCH' });
  assert.equal(f.commands.length, 0); assert.equal(f.properties.length, 0);
});
test('quickstart generation: empty foreign failed and unsafe inputs have fixed faults', async () => {
  const f = fake(); f.executor.readExports = async () => new Map();
  await assert.rejects(generator.generateSynthea(input, f.executor), { code: 'EXPORT_INVALID' });
  f.executor.readExports = async () => new Map([['../escape.json', Buffer.from('{}')]]);
  await assert.rejects(generator.generateSynthea(input, f.executor), { code: 'EXPORT_INVALID' });
  f.executor.run = async () => ({ code: 1 });
  await assert.rejects(generator.generateSynthea(input, f.executor), { code: 'GENERATION_FAILED' });
  await assert.rejects(generator.generateSynthea({ ...input, jarPath: '/bad,path' }, f.executor), { code: 'GENERATION_PATH_INVALID' });
  f.executor.inspectJar = async () => { throw new Error('secret /private/path https://foreign.test'); };
  await assert.rejects(generator.generateSynthea(input, f.executor), { code: 'GENERATION_IO', message: 'GENERATION_IO' });
  const native = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/quickstart/generate-synthea.mjs', import.meta.url))], { env: { PATH: '' }, encoding: 'utf8' });
  assert.equal(native.status, 1); assert.equal(native.stdout, ''); assert.equal(native.stderr, 'GENERATION_ARGUMENTS\n');
});
