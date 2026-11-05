// The S10 SessionFactory adapter for the INSTALLED helper's verify() oracle.
// SDK/client and rawMember are loaded only from that separate installed tree.
import { spawn } from 'node:child_process';
import { channel } from 'node:diagnostics_channel';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { dockerEnvironment, runArgs } from './commands.mjs';
import { fail } from './inventory.mjs';

const keys = ['metadata', 'auth', 'clinical'];
const zero = () => ({ metadata: 0, auth: 0, clinical: 0 });
const rec = v => v !== null && typeof v === 'object' && !Array.isArray(v);
export async function installedClient(helper) {
  const require = createRequire(join(helper, 'package.json'));
  const { Client } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/client')).href);
  const { rawMember } = await import(pathToFileURL(join(helper, 'dist/packages/evals/src/evidence-oracle.js')).href);
  return { Client, rawMember };
}

/** How the attached `docker run --rm -i` child ended: Docker passes the container's exit code through. */
export const exitStatus = child => new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal, timedOut: false })));
export const SHUTDOWN_DEADLINE_MS = 1000;
/**
 * Ends stdin, records the exit status observed within the deadline (or a timed-out status), then always runs the
 * owned cleanup and forced termination. Cleanup is independent of acceptance; acceptance is judgeShutdowns.
 */
export async function shutdownChild({ child, exited, finish, name, before = async () => {}, deadlineMs = SHUTDOWN_DEADLINE_MS }) {
  await before(); child.stdin.end();
  let timer;
  const status = await Promise.race([exited, new Promise(resolve => {
    timer = setTimeout(() => resolve({ code: null, signal: null, timedOut: true }), deadlineMs);
  })]); clearTimeout(timer);
  // Docker rm is guarded by the run's exact ownership label, including on failures.
  try { await finish(name); } finally {
    child.kill('SIGTERM'); child.stdout.destroy(); child.stderr.destroy();
    await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, deadlineMs); })]); clearTimeout(timer);
  }
  return status;
}
/** Every opened session must have been closed and must have exited normally (code 0, no signal) after stdin EOF in time. */
export function judgeShutdowns(statuses, opened) {
  if (!Array.isArray(statuses) || statuses.length === 0 || statuses.length !== opened ||
    statuses.some(s => s?.timedOut !== false || s.code !== 0 || s.signal !== null)) fail('OCI_STDIO_SHUTDOWN');
  return { status: 'every SDK session exited 0 with no signal after stdin close, within the deadline', sessions: statuses.length,
    deadlineMs: SHUTDOWN_DEADLINE_MS };
}

export async function openImageSession({ helper, observer, recipe, image, network, config, era, observe = true, name, owner, finish }) {
  const { Client, rawMember } = await installedClient(helper);
  const setupConfig = JSON.parse(await readFile(config, 'utf8')), base = new URL(setupConfig.source.baseUrl.replace(/\/$/, '') + '/');
  const metadata = new URL('metadata', base);
  const mounts = [[config, '/run/fireboat/config.json']];
  if (observe) mounts.push([observer, '/s10/observer.mjs'], [recipe, '/s10/recipe']);
  const args = [...runArgs(image, network, mounts), '-i', '--name', name, '--label', `io.fireboat.s10.run=${owner}`];
  if (observe) args.push('--entrypoint', '/usr/local/bin/node');
  args.push(image, ...(observe ? ['/s10/recipe/bridge.mjs'] : ['--config', '/run/fireboat/config.json']));
  const child = spawn('docker', args, { env: dockerEnvironment(), shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = exitStatus(child);
  let closed = false, closing, broken, transport, client, active, sequence = 0, frames = [], buffer = Buffer.alloc(0), diagnostics = '', pendingSnapshot, onReady;
  const pending = new Map(), seen = new Set(), ready = new Promise(resolve => { onReady = resolve; });
  let rejectBroken;
  const failed = new Promise((_, reject) => { rejectBroken = reject; }); void failed.catch(() => {});
  const breakSession = () => { if (!closed && !broken) { broken = new Error('OCI_STDIO_INVALID'); rejectBroken(broken); transport?.onerror?.(broken); } };
  let clientHttp = 0;
  const channels = ['http.client.request.start', 'undici:request:create', 'http2.client.stream.start'].map(channel);
  const count = () => { clientHttp++; }; channels.forEach(c => c.subscribe(count));
  const deadline = async operation => {
    let timer;
    try { return await Promise.race([operation(), failed, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('OCI_STDIO_DEADLINE')), 20_000);
    })]); } finally { clearTimeout(timer); }
  };
  const write = line => new Promise((resolve, reject) => child.stdin.write(line, error => error ? reject(new Error('OCI_STDIO_CLOSED')) : resolve()));
  const control = data => write(JSON.stringify({ fireboatS10: data }) + '\n');
  const barrier = () => !observe ? Promise.resolve(zero()) : new Promise((resolve, reject) => {
    if (pendingSnapshot) { reject(new Error('OCI_OBSERVER_BUSY')); return; }
    pendingSnapshot = { sequence: ++sequence, resolve };
    void control({ kind: 'barrier', sequence }).catch(reject);
  });
  // Resolves to the child's exit status ({ code, signal, timedOut }); the caller judges it.
  const close = () => closing ??= (async () => {
    closed = true; channels.forEach(c => c.unsubscribe(count));
    return shutdownChild({ child, exited, finish, name, before: () => client?.close().catch(() => {}) });
  })();
  transport = {
    async start() {},
    async send(message) {
      if (closed || broken) fail('OCI_STDIO_CLOSED');
      const line = JSON.stringify(message) + '\n';
      if (Buffer.byteLength(line) > 2 * 1024 * 1024 || frames.length > 1024) fail('OCI_STDIO_LIMIT');
      if (typeof message.method === 'string' && message.id !== undefined) {
        if (pending.has(message.id) || seen.has(message.id)) fail('OCI_STDIO_ID');
        pending.set(message.id, message.method);
        if (message.method === 'tools/call') { if (!active || active.id !== undefined) fail('OCI_STDIO_ID'); active.id = message.id; }
      }
      frames.push({ direction: 'sent', text: line }); await write(line);
    },
    async close() { child.stdin.end(); transport.onclose?.(); },
  };
  const decoder = new TextDecoder('utf-8', { fatal: true });
  child.stdout.on('data', chunk => {
    if (closed) return;
    buffer = Buffer.concat([buffer, chunk]); let end;
    while ((end = buffer.indexOf(10)) >= 0) {
      const bytes = buffer.subarray(0, end + 1); buffer = buffer.subarray(end + 1);
      try {
        if (bytes.length > 2 * 1024 * 1024 || frames.length > 1024) throw 0;
        const line = decoder.decode(bytes), message = JSON.parse(line);
        if (!rec(message) || message.jsonrpc !== '2.0') throw 0;
        frames.push({ direction: 'received', text: line });
        if ('id' in message && ('result' in message || 'error' in message)) {
          if (!pending.has(message.id) || seen.has(message.id) || ('result' in message) === ('error' in message)) throw 0;
          const method = pending.get(message.id); pending.delete(message.id); seen.add(message.id);
          if (method === 'tools/call') {
            if (active?.id !== message.id) throw 0;
            const rawText = rawMember(line, 'result');
            active.response = { message, rawFrame: line, rawText, resultBytes: rawText === undefined ? 0 : Buffer.byteLength(rawText), frameBytes: bytes.length };
          }
        } else if (typeof message.method !== 'string' || 'id' in message) throw 0;
        transport.onmessage?.(message);
      } catch { breakSession(); return; }
    }
    if (buffer.length >= 2 * 1024 * 1024) breakSession();
  });
  child.stderr.setEncoding('utf8'); child.stderr.on('data', text => {
    if (!observe || closed) return; // clean launch diagnostics are drained, never logged.
    diagnostics += text; if (Buffer.byteLength(diagnostics) > 16384) { breakSession(); return; }
    let end;
    while ((end = diagnostics.indexOf('\n')) >= 0) {
      const line = diagnostics.slice(0, end); diagnostics = diagnostics.slice(end + 1);
      try {
        const outer = JSON.parse(line), value = outer.fireboatS10;
        if (!rec(outer) || Object.keys(outer).length !== 1 || !rec(value)) throw 0;
        if (value.kind === 'ready' && value.version === 1 && Object.keys(value).length === 2 && onReady) { onReady(); onReady = undefined; }
        else if (value.kind === 'snapshot' && pendingSnapshot && value.sequence === pendingSnapshot.sequence && Object.keys(value).length === 5 &&
          keys.every(k => Number.isSafeInteger(value[k]) && value[k] >= 0)) {
          const snapshot = pendingSnapshot; pendingSnapshot = undefined; snapshot.resolve(Object.fromEntries(keys.map(k => [k, value[k]])));
        } else throw 0;
      } catch { breakSession(); return; }
    }
  });
  child.on('error', breakSession); child.on('exit', breakSession); child.stdin.on('error', breakSession);
  client = new Client({ name: 'fireboat-s10', version: '0.1.0' }, era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : undefined);
  let previous = zero(), busy = false, calls = 0;
  try {
    await deadline(async () => {
      if (observe) { await control({ kind: 'setup', metadata: { origin: metadata.origin, pathname: metadata.pathname } }); await ready; }
      await client.connect(transport, { timeout: 15_000 });
      if (client.getProtocolEra() !== era || client.getNegotiatedProtocolVersion() !== (era === 'modern' ? '2026-07-28' : '2025-11-25')) fail('OCI_STDIO_ERA');
      const tools = await client.listTools(undefined, { timeout: 15_000 });
      if (JSON.stringify(tools.tools.map(t => t.name).sort()) !== JSON.stringify(['fhir_capabilities', 'fhir_page', 'fhir_read', 'fhir_result', 'fhir_search'])) fail('OCI_STDIO_TOOLS');
      previous = await barrier();
      if (keys.some(k => previous[k] !== 0) || clientHttp) fail('OCI_STDIO_UNSCOPED_WORK');
    });
  } catch (error) { await close(); throw error; }
  return {
    negotiatedVersion: client.getNegotiatedProtocolVersion(),
    async call(tool, input) {
      if (busy || ++calls > 128 || closed || broken) fail('OCI_STDIO_CALL');
      busy = true; active = {};
      try { return await deadline(async () => {
        const before = await barrier();
        if (keys.some(k => before[k] !== previous[k]) || clientHttp) fail('OCI_STDIO_UNSCOPED_WORK');
        let rejected = false;
        try { await client.callTool({ name: tool, arguments: input }, { timeout: 15_000 }); } catch { rejected = true; }
        if (broken || !active.response || active.id === undefined) fail('OCI_STDIO_RESPONSE');
        const after = await barrier();
        if (keys.some(k => after[k] < before[k]) || clientHttp) fail('OCI_STDIO_OBSERVER');
        previous = after;
        const { message, ...response } = active.response, captured = frames; frames = [];
        const work = Object.fromEntries(keys.map(k => [k, after[k] - before[k]]));
        const result = message.result, envelope = rec(result?.structuredContent) && typeof result.structuredContent.schema_version === 'string' && rec(result.structuredContent.data) ? result.structuredContent : undefined;
        const outcome = rec(message.error) ? { class: 'json_rpc_error', code: message.error.code }
          : rejected ? { class: 'sdk_text_error', code: 'SDK_RESULT_INVALID' }
          : envelope?.error ? { class: 'application_error', code: envelope.error.code }
          : !envelope ? { class: 'sdk_text_error', code: 'sdk_text_error' } : undefined;
        return { requestId: active.id, ...response, frames: captured, work, ...(envelope ? { envelope } : {}), ...(outcome ? { outcome } : {}) };
      }); } catch (error) { await close(); throw error; } finally { active = undefined; busy = false; }
    },
    // afterStarted runs while the request is upstream and uncancelled (the control window); abortedAt times the abort.
    async cancel(afterStarted, requestTimeoutMs = 15_000) {
      active = {}; const controller = new AbortController();
      const request = client.callTool({ name: 'fhir_read', arguments: { resource_type: 'Patient', id: setupConfig.patientId } }, { signal: controller.signal, timeout: requestTimeoutMs });
      let rejected = false; void request.catch(() => {});
      await afterStarted(); const abortedAt = Date.now(); controller.abort();
      try { await request; } catch { rejected = true; }
      await client.listTools(undefined, { timeout: 5_000 });
      if (!rejected || clientHttp) fail('OCI_CANCELLATION');
      return { cancelled: true, responsive: true, abortedAt };
    },
    close,
  };
}
