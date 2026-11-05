import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { hostConfigurations } from '../examples/quickstart/configs.js';

test('quickstart configs: all four forms preserve the same absolute launch tuple', () => {
  const tuple = { node: '/Node space/a\'"\\\n$;`b', cli: '/CLI space/cli\'"\\\n$;`.js', config: '/Config space/a\'"\\\n$;`.json' };
  const forms = JSON.parse(JSON.stringify(hostConfigurations(tuple))) as ReturnType<typeof hostConfigurations>;
  const entry = { command: tuple.node, args: [tuple.cli, '--config', tuple.config] };
  assert.deepEqual(forms.claudeDesktop.mcpServers.fireboat, entry);
  assert.deepEqual(forms.cursor.mcpServers.fireboat, entry);
  assert.deepEqual(forms.vsCode.servers.fireboat, { type: 'stdio', ...entry });
  assert.deepEqual(forms.claudeCode.entry, entry);
  assert.deepEqual(forms.claudeCode.argv.slice(-4), [tuple.node, tuple.cli, '--config', tuple.config]);
  assert.equal(forms.guidance.verification, 'unverified'); assert.equal(forms.guidance.delivery, 'full-text-v1');
});
test('quickstart configs: relative node bin or config is refused', () => {
  const tuple = { node: '/node', cli: '/cli.js', config: '/config.json' };
  for (const key of Object.keys(tuple)) assert.throws(() => hostConfigurations({ ...tuple, [key]: 'relative' }), { code: 'LAUNCH_NOT_ABSOLUTE' });
  assert.throws(() => hostConfigurations({ ...tuple, cli: '/bad\0path' }), { code: 'LAUNCH_INVALID' });
});
test('quickstart configs: POSIX command delivers inert exact argv through a recording executable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quickstart-argv-'));
  try {
    await writeFile(join(root, 'claude'), `#!${process.execPath}\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o755 });
    const tuple = { node: `/Node space/'double"\\\n$(touch ${root}/UNSAFE);\`id\``,
      cli: '/CLI space/"a\'\\\n$HOME;&|<>.js', config: '/Config/\'"\\\n$(printf unsafe);.json' };
    const forms = hostConfigurations(tuple);
    const result = spawnSync('/bin/sh', ['-c', forms.claudeCode.command], { encoding: 'utf8', env: { PATH: root } });
    assert.equal(result.status, 0, 'quoted command must execute the recording stub');
    assert.deepEqual(JSON.parse(result.stdout), forms.claudeCode.argv.slice(1));
    const { existsSync } = await import('node:fs'); assert.equal(existsSync(join(root, 'UNSAFE')), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
