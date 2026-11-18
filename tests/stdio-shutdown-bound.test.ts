import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import type { JSONRPCMessage, Transport } from '@modelcontextprotocol/client';
import { FhirGateway } from '../packages/core/src/index.js';
import { listenLoopbackCallback } from '../packages/server/src/login.js';
import { readTokenFile, writeTokenFile } from '../packages/auth/src/token-store.js';
import { approve, standaloneConfig, startSmartStub } from './smart-helpers.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(repoRoot, 'packages', 'server', 'src', 'cli.ts');

/** A client transport over a child the test spawned itself, so the test decides when standard output stops being read. */
class ChildTransport implements Transport {
  onmessage?: Transport['onmessage'];
  onclose?: () => void;
  onerror?: (error: Error) => void;
  private buffer = '';
  constructor(private readonly child: ChildProcessWithoutNullStreams) {}
  async start(): Promise<void> {
    this.child.stdout.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      for (let end = this.buffer.indexOf('\n'); end >= 0; end = this.buffer.indexOf('\n')) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        if (line.trim()) this.onmessage?.(JSON.parse(line) as JSONRPCMessage);
      }
    });
  }
  async send(message: JSONRPCMessage): Promise<void> {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  async close(): Promise<void> { this.onclose?.(); }
}

// The Node.js documentation ("A note on process I/O", https://nodejs.org/docs/latest-v24.x/api/process.html#a-note-on-process-io)
// says writes to process.stdout through pipes (and sockets) are synchronous on Windows and asynchronous on POSIX. Where
// they are synchronous, a full pipe blocks the process inside the write, before any timer or signal handler can run, so
// no timer can bound that shutdown. Only macOS has been run.
const asyncPipes = process.platform !== 'win32';

test('stdio CLI: a client that stops reading standard output cannot keep the server alive past the shutdown bound', { skip: asyncPipes ? false : 'standard output pipes are synchronous on Windows' }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'fireboat-shutdown-bound-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = join(dir, 'config.json');
  // No upstream request is made: the source is never contacted by tools/list.
  await writeFile(configPath, JSON.stringify({ mode: 'synthetic', source: { alias: 'unused', baseUrl: 'http://127.0.0.1:9/fhir' }, patientId: 'synthetic-patient-a' }));
  const child = spawn(process.execPath, ['--import', 'tsx', cliPath, '--config', configPath], { cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { child.kill('SIGKILL'); });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)));
  const client = new Client({ name: 'shutdown-bound', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  await client.connect(new ChildTransport(child));
  // Closing the client rejects the requests left unanswered, so none keeps this test process waiting for its timeout.
  t.after(() => client.close().catch(() => undefined));
  // An open listen subscription is answered when the connection closes, and that answer waits for standard output to drain.
  await client.listen({ toolsListChanged: true });
  assert.equal((await client.listTools()).tools.length, 5);
  // Stop reading, then queue far more output than the pipe holds.
  child.stdout.pause();
  for (let i = 0; i < 400; i++) client.listTools().catch(() => undefined);
  await sleep(1_500);
  const startedAt = Date.now();
  child.kill('SIGTERM');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const code = await Promise.race([exited, new Promise<'running'>(resolve => { timer = setTimeout(() => resolve('running'), 8_000); })]);
  clearTimeout(timer);
  assert.equal(code, 0, `the server exits 0 although its standard output is never drained; stderr: ${stderr}`);
  assert.ok(Date.now() - startedAt < 6_000, `exited after ${Date.now() - startedAt} ms`);
});

test('stdio CLI: shutdown releases a grant lock held by a refresh even while the connection close waits for a client that stopped reading', { skip: asyncPipes ? false : 'standard output pipes are synchronous on Windows' }, async t => {
  let refreshing!: () => void;
  const arrived = new Promise<void>(resolve => { refreshing = resolve; });
  // The token endpoint takes the refresh request and never answers, so the refresh holds the grant lock at shutdown.
  const stub = await startSmartStub({ holdToken: request => request.form.get('grant_type') === 'refresh_token' ? (refreshing(), new Promise<void>(() => undefined)) : undefined });
  t.after(stub.close);
  const dir = await mkdtemp(join(tmpdir(), 'fireboat-shutdown-lock-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const tokenFile = join(dir, 'grant.json'), lock = `${tokenFile}.lock`;
  const config = standaloneConfig(stub, tokenFile, { offlineAccess: true });
  // Sign in as `fireboat login` would, then let the access token expire so the server must refresh.
  const signer = new FhirGateway(config as never);
  let pending: Promise<unknown> = Promise.resolve();
  try { await signer.smartLogin({ listen: listenLoopbackCallback, timeoutMs: 5_000, onAuthorizeUrl: url => { pending = approve(url.href).catch(error => error); } }); }
  finally { await pending; signer.close(); }
  const grant = (await readTokenFile(tokenFile))!;
  await writeTokenFile(tokenFile, { ...grant, issuedAt: Date.now() - 7_200_000, expiresAt: Date.now() - 3_600_000 });
  const expired = await readTokenFile(tokenFile);
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify(config));
  const child = spawn(process.execPath, ['--import', 'tsx', cliPath, '--config', configPath], { cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { child.kill('SIGKILL'); });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)));
  const client = new Client({ name: 'shutdown-lock', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  await client.connect(new ChildTransport(child));
  t.after(() => client.close().catch(() => undefined));
  await client.listen({ toolsListChanged: true });
  client.callTool({ name: 'fhir_capabilities', arguments: { topic: 'server' } }).catch(() => undefined);
  await arrived;
  await lstat(lock);
  // Stop reading, so closing the connection waits for a drain that never comes.
  child.stdout.pause();
  for (let i = 0; i < 400; i++) client.listTools().catch(() => undefined);
  await sleep(1_500);
  const startedAt = Date.now();
  child.kill('SIGTERM');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const code = await Promise.race([exited, new Promise<'running'>(resolve => { timer = setTimeout(() => resolve('running'), 8_000); })]);
  clearTimeout(timer);
  assert.equal(code, 0, `the server exits 0; stderr: ${stderr}`);
  assert.ok(Date.now() - startedAt < 6_000, `exited after ${Date.now() - startedAt} ms`);
  await assert.rejects(lstat(lock), 'the grant lock was released before the process exited');
  assert.deepEqual(await readTokenFile(tokenFile), expired, 'the unanswered refresh stored nothing');
});
