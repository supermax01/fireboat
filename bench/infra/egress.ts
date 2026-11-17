// Egress sandbox for MCP server processes: deny every outbound connection except loopback.
// probeEgressSandbox() checks that sandbox-exec works here: a loopback connect succeeds and a connect to 192.0.2.1
// (RFC 5737 TEST-NET-1, never routed, so no real host is contacted) fails at once with EPERM. Unsandboxed, that
// connect times out instead, which is how the two cases are told apart.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { HAPI_PORT } from '../lib/paths.js';

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
export const EGRESS_PROFILE = [
  '(version 1)',
  '(allow default)',
  '(deny network-outbound)',
  '(allow network-outbound (remote ip "localhost:*"))',
  '(allow network-outbound (remote unix-socket))',
].join('');

/** Wraps a command so it runs under the deny-non-loopback profile. */
export function egressWrap(command: string, args: readonly string[]): { command: string; args: string[] } {
  return { command: SANDBOX_EXEC, args: ['-p', EGRESS_PROFILE, command, ...args] };
}

const PROBE = `
const net = require('net');
const t = (host, port) => new Promise(r => {
  const s = net.connect({ host, port });
  const to = setTimeout(() => { s.destroy(); r('timeout'); }, 3000);
  s.on('connect', () => { clearTimeout(to); s.destroy(); r('connected'); });
  s.on('error', e => { clearTimeout(to); r(e.code || 'error'); });
});
(async () => { process.stdout.write(JSON.stringify({ loopback: await t('127.0.0.1', ${HAPI_PORT}), external: await t('192.0.2.1', 9) })); })();
`;

export interface EgressProbe { works: boolean; sandbox_exec: string; profile: string; loopback: string; external: string; error?: string }

export function probeEgressSandbox(): Promise<EgressProbe> {
  const base = { sandbox_exec: SANDBOX_EXEC, profile: EGRESS_PROFILE };
  if (!existsSync(SANDBOX_EXEC)) return Promise.resolve({ ...base, works: false, loopback: '', external: '', error: 'sandbox-exec not found' });
  const { command, args } = egressWrap(process.execPath, ['-e', PROBE]);
  return new Promise(resolve => {
    execFile(command, args, { timeout: 20_000 }, (err, stdout) => {
      try {
        const r = JSON.parse(String(stdout)) as { loopback: string; external: string }; // the probe's own output
        resolve({ ...base, ...r, works: r.loopback === 'connected' && r.external === 'EPERM' });
      } catch {
        resolve({ ...base, works: false, loopback: '', external: '', error: err?.message ?? `unparseable probe output: ${String(stdout)}` });
      }
    });
  });
}
