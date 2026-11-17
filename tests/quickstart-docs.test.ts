import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { hostConfigurations } from '../examples/quickstart/configs.js';
import { validateSeedManifest } from '../examples/quickstart/manifest.js';
import { jsonBytes } from '../examples/quickstart/run-state.js';
import { boundConfig } from '../examples/quickstart/verify.js';
import { FhirGateway, type GatewayConfig } from '../packages/core/src/index.js';

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const guide = read('docs/QUICKSTART.md');
const operatorConfig = JSON.parse(read('examples/quickstart/config.json')) as GatewayConfig;
const manifest = validateSeedManifest(JSON.parse(read('examples/quickstart/seed-manifest.json')));
const target = `${manifest.target.origin}${manifest.target.basePath}`;
const main = read('examples/quickstart/main.ts');

function stringArray(literal: string): string[] {
  const values: unknown = JSON.parse(literal.replaceAll("'", '"'));
  assert.ok(Array.isArray(values) && values.every(value => typeof value === 'string' && /^--[a-z]+(?:-[a-z]+)*$/.test(value)), 'literal CLI flag array');
  return values as string[];
}

/** Read the implemented branches and their required value flags/optional switches, rather than maintaining a second CLI list. */
function commandContract(): Map<string, { flags: string[]; switches: string[] }> {
  const commands = new Map<string, { flags: string[]; switches: string[] }>();
  const branches = [...main.matchAll(/\bcommand\s*===\s*'([^']+)'/g)].map(match => match[1]!);
  // Fail closed if a branch no longer declares its parser in this literal form.
  const pattern = /if\s*\(command\s*===\s*'([^']+)'\)\s*\{\s*const flags = argumentsFor\(args,\s*(\[[^\]]*\])(?:,\s*(\[[^\]]*\]))?\);/g;
  for (const [, command, flags, switches] of main.matchAll(pattern)) {
    assert.ok(!commands.has(command!), 'unique CLI command');
    commands.set(command!, { flags: stringArray(flags!), switches: switches ? stringArray(switches) : [] });
  }
  assert.ok(commands.size > 0, 'found implemented commands in main.ts');
  assert.deepEqual([...commands.keys()].sort(), branches.sort(), 'read every implemented branch and its parser');
  return commands;
}
const commands = commandContract();

/** Tokenize the guide's quoted shell words without executing a shell or expanding operator variables. */
function shellWords(line: string): string[] {
  const words: string[] = [];
  const pattern = /\s*(?:"([^"\n]*)"|'([^'\n]*)'|([^\s"';|&<>]+))/y;
  let offset = 0;
  while (line.slice(offset).trim()) {
    pattern.lastIndex = offset;
    const match = pattern.exec(line);
    assert.ok(match, `unsupported shell syntax in guide command: ${line}`);
    words.push(match[1] ?? match[2] ?? match[3]!);
    offset = pattern.lastIndex;
  }
  return words;
}
function assertGuideCommands(doc: string): void {
  const blocks = [...doc.matchAll(/^```[^\n]*\n([\s\S]*?)^```\s*$/gm)].map(match => match[1]!);
  const seen = new Set<string>();
  for (const block of blocks) for (const line of block.replace(/\\\r?\n[ \t]*/g, ' ').split('\n')) {
    if (!/^\s*fireboat-quickstart(?:\s|$)/.test(line)) continue;
    const [, command, ...args] = shellWords(line);
    const contract = commands.get(command ?? '');
    assert.ok(contract, `unimplemented guide command: ${command}`);
    seen.add(command!);
    const flags = new Set<string>();
    for (let index = 0; index < args.length; index++) {
      const flag = args[index]!;
      assert.ok(!flags.has(flag), `${command}: duplicate flag ${flag}`);
      flags.add(flag);
      if (contract.switches.includes(flag)) continue;
      assert.ok(contract.flags.includes(flag), `${command}: unsupported flag ${flag}`);
      const value = args[++index];
      assert.ok(value && !value.startsWith('--'), `${command}: missing value for ${flag}`);
    }
    for (const flag of contract.flags) assert.ok(flags.has(flag), `${command}: missing required flag ${flag}`);
  }
  assert.deepEqual([...seen].sort(), [...commands.keys()].sort(), 'guide demonstrates every implemented command');
}

const faultUnion = /export type QuickstartFaultCode\s*=([\s\S]*?);/.exec(read('examples/quickstart/manifest.ts'))?.[1];
assert.ok(faultUnion, 'manifest fault-code union');
const faultCodes = [...faultUnion.matchAll(/'([A-Z][A-Z0-9_]+)'/g)].map(match => match[1]!);
assert.ok(faultCodes.length > 0 && faultUnion.replace(/'[A-Z][A-Z0-9_]+'|[|\s]/g, '') === '', 'closed literal manifest fault union');
const limitations = new Set([...read('examples/quickstart/verify.ts').matchAll(/'([A-Z][A-Z0-9_]*_UNVERIFIED)'/g)].map(match => match[1]!));
function assertGuideFaults(doc: string): void {
  for (const [, code] of doc.matchAll(/`([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)`/g))
    assert.ok(faultCodes.includes(code!) || limitations.has(code!), `undocumented source code named as a fault/limitation: ${code}`);
  const troubleshooting = /^## Troubleshooting fixed fault codes\n([\s\S]*)$/m.exec(doc)?.[1];
  assert.ok(troubleshooting, 'fixed-fault troubleshooting table');
  const rows = [...troubleshooting.matchAll(/^\| `([A-Z][A-Z0-9_]+)` \| ([^|\n]+) \| ([^|\n]+) \|$/gm)];
  for (const [, code, cause, remedy] of rows) {
    assert.ok(faultCodes.includes(code!), `unknown troubleshooting fault: ${code}`);
    assert.ok(cause!.trim() && remedy!.trim(), `${code}: cause and remedy`);
  }
  assert.deepEqual(rows.map(row => row[1]!).sort(), [...faultCodes].sort(), 'every manifest fault has exactly one cause/remedy row');
}

const compose = read('compose.quickstart.yaml');
const image = /^\s+image:\s+(\S+)\s*$/m.exec(compose)?.[1];
const binding = /^\s+- "(127\.0\.0\.1:\d+:\d+)"\s*$/m.exec(compose)?.[1];
assert.ok(image && binding, 'checked-in Compose image and port binding');
assert.ok(image.endsWith(`@${manifest.backend.imageIndexDigest}`), 'Compose image is the manifest pin');
assert.equal(manifest.target.origin, `http://${binding.split(':').slice(0, 2).join(':')}`, 'Compose publishes the manifest target');
function assertGuidePins(doc: string): void {
  const images = doc.match(/\bhapiproject\/hapi(?:@|:)[A-Za-z0-9:._-]+/g) ?? [];
  assert.ok(images.length > 0, 'guide names the pinned image');
  for (const named of images) assert.equal(named, image, 'guide image must equal Compose pin');
  const bindings = doc.match(/\b127\.0\.0\.1:\d+:\d+\b/g) ?? [];
  assert.ok(bindings.length > 0, 'guide names the exact Compose port binding');
  for (const named of bindings) assert.equal(named, binding, 'guide port must equal Compose binding');
  assert.ok(doc.includes(`\`${target}\``), 'guide names the manifest target exactly');
}

function assertOperatorConfig(config: unknown): void {
  boundConfig(config, manifest, target);
  // The gateway constructor is the CLI's authoritative validator; construction and close do not perform HTTP calls.
  const gateway = new FhirGateway(config as GatewayConfig);
  gateway.close();
}
const placeholders = {
  node: '/ABSOLUTE/PATH/TO/node',
  cli: '/ABSOLUTE/PATH/TO/fireboat/dist/packages/server/src/cli.js',
  config: '/ABSOLUTE/PATH/TO/fireboat/examples/quickstart/config.json',
};
const hostExample = read('examples/quickstart/host-config.example.json');
const assertHostExample = (bytes: string): void => assert.equal(bytes, jsonBytes(hostConfigurations(placeholders)).toString('utf8'));

test('quickstart docs: operator config passes manifest binding and the gateway constructor', () => {
  assertOperatorConfig(operatorConfig);
});
test('quickstart docs witnesses: wrong mode, target, natural patient and gateway limits fail the config check', () => {
  const foreign = manifest.resources.find(row => row.type === 'Patient' && row.origin === 'edge');
  assert.ok(foreign, 'seed includes the wrong-patient control');
  for (const patch of [{ mode: 'clinical' }, { source: { ...operatorConfig.source, baseUrl: `${target}/wrong` } }, { patientId: foreign.id }])
    assert.throws(() => assertOperatorConfig({ ...operatorConfig, ...patch }), { code: 'VERIFY_CONFIG_INVALID' });
  assert.throws(() => assertOperatorConfig({ ...operatorConfig, limits: { defaultBytes: 1 } }), { code: 'VERIFY_CONFIG_INVALID' });
});

test('quickstart docs: placeholder host example equals the four generated forms byte for byte', () => {
  assertHostExample(hostExample);
});
test('quickstart docs witness: a host example that claims verification fails byte equality', () => {
  const wrong = hostExample.replace('"verification": "unverified"', '"verification": "verified"');
  assert.notEqual(wrong, hostExample);
  assert.throws(() => assertHostExample(wrong), assert.AssertionError);
});

test('quickstart docs: every fenced helper command uses exactly the flags derived from main.ts', () => {
  assertGuideCommands(guide);
});
test('quickstart docs witnesses: unknown commands, extra, missing, duplicate and valueless flags fail the guide check', () => {
  const mutations = [
    guide.replace('fireboat-quickstart prepare --run-dir', 'fireboat-quickstart up --run-dir'),
    guide.replace('fireboat-quickstart prepare --run-dir', 'fireboat-quickstart prepare --pull always --run-dir'),
    guide.replace(' --cli "$QUICKSTART_CLI"', ''),
    guide.replace('fireboat-quickstart prepare --run-dir', 'fireboat-quickstart prepare --run-dir /duplicate --run-dir'),
    guide.replace('fireboat-quickstart prepare --run-dir "$QUICKSTART_RUN"', 'fireboat-quickstart prepare --run-dir'),
  ];
  for (const wrong of mutations) {
    assert.notEqual(wrong, guide);
    assert.throws(() => assertGuideCommands(wrong), assert.AssertionError);
  }
});

test('quickstart docs: named faults belong to the manifest union and each has a cause/remedy row', () => {
  assertGuideFaults(guide);
});
test('quickstart docs witnesses: invented fault codes and missing troubleshooting rows fail the guide check', () => {
  const unknown = guide.replace('`CLI_USAGE`', '`INVENTED_FAULT`');
  const missing = guide.split('\n').filter(line => !line.startsWith('| `CLI_USAGE` |')).join('\n');
  for (const wrong of [unknown, missing, `${guide}\nAn unexpected failure is \`INVENTED_FAULT\`.\n`]) {
    assert.notEqual(wrong, guide);
    assert.throws(() => assertGuideFaults(wrong), assert.AssertionError);
  }
});

test('quickstart docs: image digest, port binding and target match Compose and the manifest', () => {
  assertGuidePins(guide);
});
test('quickstart docs witnesses: wrong image digest, moving tag, port and target fail the guide check', () => {
  const mutations = [
    guide.replace(image, image.replace(manifest.backend.imageIndexDigest, `sha256:${'a'.repeat(64)}`)),
    guide.replace(image, 'hapiproject/hapi:latest'),
    guide.replace(binding, binding.replace(/:8080$/, ':8081')),
    guide.replace(`\`${target}\``, `\`${target}/wrong\``),
  ];
  for (const wrong of mutations) {
    assert.notEqual(wrong, guide);
    assert.throws(() => assertGuidePins(wrong), assert.AssertionError);
  }
});


test('quickstart guide documents verification isolation, trusted response gates, retained evidence and complete-frame controls', () => {
  for (const term of ['verify.lock', 'verify-<unique>/', 'verificationId', 'artifactSha256', 'artifactFiles', 'verify-control.config.json', 'rawFrame', 'frames', 'controls',
    'min(output.max_bytes, limits.maxBytes)', '32,768', 'retrieval timestamps', 'numeric inventories', 'single-token provider', 'not a JavaScript sandbox'])
    assert.ok(guide.includes(term), term);
});
