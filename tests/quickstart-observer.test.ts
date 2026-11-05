import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import test from 'node:test';

test('quickstart observer: cumulative barrier survives a lagging pipe, classifies exact routes and emits counts only', { timeout: 15000 }, async t => {
  const canary = 'PRIVATE-OBSERVER-BODY-ID-PATH';
  const server = createServer((req, res) => {
    if (req.url === '/failure') { req.socket.destroy(); return; }
    res.end(canary);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const directory = await mkdtemp(join(tmpdir(), 'qs-observer-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const preload = join(directory, 'observer.mjs'), driver = join(directory, 'driver.mjs');
  const code = stripTypeScriptTypes(await readFile(new URL('../examples/quickstart/request-observer.ts', import.meta.url), 'utf8'));
  const imports = [...code.matchAll(/from ['"]([^'"]+)['"]/g)].map(m => m[1]);
  assert.deepEqual(imports.sort(), ['node:diagnostics_channel', 'node:net']);
  await writeFile(preload, code);
  await writeFile(driver, `
    import { request } from 'node:http';
    for (const [method, path] of [['GET','/fhir/metadata?x=1'],['POST','/token'],['GET','/fhir/Patient/metadata'],['GET','/fhir/Observation/${canary}'],['GET','/failure']]) {
      await new Promise(resolve => {
        const req = request('${origin}'+path, {method}, res => { res.resume(); res.on('end',resolve); }); req.on('error',resolve); req.end('${canary}');
      });
    }
    process.stdout.write('done\\n');
  `);
  const child = spawn(process.execPath, ['--import', preload, driver], { stdio: ['pipe', 'pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH } });
  const pipe = child.stdio[3] as Duplex;
  t.after(() => { pipe.destroy(); child.kill('SIGKILL'); });
  let stderr = '', stdout = '', text = '';
  const messages: Record<string, unknown>[] = [];
  let notify: (() => void) | undefined;
  pipe.setEncoding('utf8'); pipe.on('data', (chunk: string) => {
    text += chunk; let end: number;
    while ((end = text.indexOf('\n')) >= 0) { messages.push(JSON.parse(text.slice(0, end))); text = text.slice(end + 1); }
    notify?.();
  });
  child.stderr.on('data', chunk => { stderr += chunk; }); child.stdout.on('data', chunk => { stdout += chunk; notify?.(); });
  const until = async (condition: () => boolean) => {
    while (!condition()) await new Promise<void>(resolve => { notify = resolve; }); notify = undefined;
  };
  pipe.write(JSON.stringify({ kind: 'setup', metadata: { origin, pathname: '/fhir/metadata' }, auth: { origin, pathname: '/token' } }) + '\n');
  await until(() => messages.length === 1);
  assert.deepEqual(messages[0], { kind: 'ready', version: 1 });
  pipe.pause(); await until(() => stdout === 'done\n');
  // stdout has completed while counter delivery is explicitly stopped. The barrier must include all five attempts.
  pipe.write('{"kind":"barrier","sequence":1}\n');
  await new Promise<void>(resolve => setTimeout(resolve, 60));
  assert.equal(messages.length, 1); pipe.resume(); await until(() => messages.length === 2);
  assert.deepEqual(messages[1], { kind: 'snapshot', sequence: 1, metadata: 1, auth: 1, clinical: 3 });
  pipe.write('{"kind":"barrier","sequence":2}\n'); await until(() => messages.length === 3);
  assert.deepEqual(messages[2], { kind: 'snapshot', sequence: 2, metadata: 1, auth: 1, clinical: 3 });
  assert.equal(stderr, ''); assert.equal(stdout, 'done\n'); assert.equal(text, '');
  assert.doesNotMatch(JSON.stringify(messages), /PRIVATE|\/fhir|\/token|127\.0\.0\.1|access_token|Bearer/);
});
