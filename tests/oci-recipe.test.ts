import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const commands = await import(new URL('../packaging/oci/commands.mjs', import.meta.url).href);
const inv = await import(new URL('../packaging/oci/inventory.mjs', import.meta.url).href);
const recipe = (name: string) => readFile(new URL(`../packaging/oci/${name}`, import.meta.url), 'utf8');

test('OCI recipe: one approved immutable base, verified payload only and numeric stdio entrypoint', async () => {
  const text = await recipe('Dockerfile'), lines = text.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  assert.deepEqual(lines.filter(line => line.startsWith('FROM ')), [`FROM ${inv.BASE}`]);
  assert.deepEqual(lines.filter(line => line.startsWith('COPY ')), ['COPY --chown=0:0 runtime/ /opt/fireboat/']);
  assert.deepEqual(lines.filter(line => line.startsWith('RUN ')), ['RUN ln -s /opt/fireboat/node_modules/@fireboat/gateway/dist/packages/server/src/cli.js /usr/local/bin/fireboat']);
  assert.ok(lines.includes('USER 1000:1000'));
  assert.ok(lines.includes('ENTRYPOINT ["/usr/local/bin/fireboat"]'));
  assert.ok(lines.includes('CMD []'));
  assert.ok(lines.indexOf('USER 1000:1000') < lines.indexOf('ENTRYPOINT ["/usr/local/bin/fireboat"]'));
  assert.equal(lines.some(line => /^(?:EXPOSE|ADD|ARG|VOLUME|HEALTHCHECK|ONBUILD)\b/.test(line)), false);
  assert.equal(/\b(?:npm|npx|apt|curl|wget|tsc|tsx)\b/.test(lines.join('\n')), false);
});

test('OCI recipe: helper namespace overlay has no gateway publication and all hardening flags', async () => {
  const text = await recipe('compose.yaml'), hapi = await readFile(new URL('../compose.quickstart.yaml', import.meta.url), 'utf8');
  for (const line of ['    platform: linux/arm64', '    pull_policy: never', '    user: "1000:1000"', '    read_only: true',
    '    cap_drop: [ALL]', '    security_opt: ["no-new-privileges:true"]', '    network_mode: service:hapi', '    stdin_open: true', '    tty: false'])
    assert.ok(text.split('\n').includes(line), line);
  assert.match(text, /\$\{FIREBOAT_OCI_IMAGE:\?verified local image digest required\}/);
  assert.match(text, /\/run\/fireboat\/config\.json:ro/);
  assert.equal(/^\s*(?:ports|expose|build|privileged|cap_add|devices|hapi):/m.test(text), false);
  assert.equal(/host\.docker\.internal|network_mode: host/.test(text), false);
  assert.match(hapi, /image: hapiproject\/hapi@sha256:0ff86aac4c7bd13a1ee226444a70263bb46ed1c28ef543c30a44f865b80ca04e/);
  assert.deepEqual([...hapi.matchAll(/^\s+- "([^"\n]*:\d+)"$/gm)].map(m => m[1]), ['127.0.0.1:18080:8080']);
});

test('OCI recipe: local build disables pull and networking, never tags or pushes', () => {
  assert.deepEqual(commands.buildArgs('/scratch/context', '/scratch/output'), ['build', '--network', 'none', '--pull=false',
    '--platform', 'linux/arm64', '--iidfile', '/scratch/output/image-id', '--file', '/scratch/context/Dockerfile', '/scratch/context']);
  const env = commands.dockerEnvironment({ PATH: '/bin', DOCKER_HOST: 'unix:///synthetic.sock', DOCKER_CONFIG: '/scratch/docker',
    HTTP_PROXY: 'canary', NODE_OPTIONS: 'canary', TOKEN: 'canary' });
  assert.deepEqual(env, { PATH: '/bin', DOCKER_HOST: 'unix:///synthetic.sock', DOCKER_CONFIG: '/scratch/docker', DOCKER_BUILDKIT: '0' });
});

test('OCI recipe: actual-image launch is read-only non-root capability-free and cannot publish a port', () => {
  const image = `sha256:${'a'.repeat(64)}`, network = `container:${'b'.repeat(64)}`;
  assert.deepEqual(commands.runArgs(image, network, [['/scratch/config.json', '/run/fireboat/config.json']]), [
    'run', '--rm', '--pull=never', '--platform', 'linux/arm64', '--network', network, '--user', '1000:1000', '--read-only',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--log-driver', 'none',
    '--mount', 'type=bind,src=/scratch/config.json,dst=/run/fireboat/config.json,readonly']);
  assert.ok(commands.runArgs(image, 'none').includes('none'));
  for (const bad of ['host', 'bridge', 'container:hapi', 'container:../foreign']) assert.throws(() => commands.runArgs(image, bad), { code: 'OCI_RUN_OPTIONS' });
  assert.throws(() => commands.runArgs('mutable:tag', 'none'), { code: 'OCI_RUN_OPTIONS' });
  for (const source of ['relative', '/scratch,a', '/scratch\npath']) assert.throws(() => commands.runArgs(image, 'none', [[source, '/config']]), { code: 'OCI_MOUNT' });
});
