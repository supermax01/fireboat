import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { resolve } from 'node:path';
import { removeStoredGrant } from '../../auth/src/token-store.js';
import { CallbackFault, LoginFault, type CallbackListener } from '../../auth/src/smart-standalone.js';
import { FhirGateway, type GatewayConfig } from '../../core/src/index.js';
import { CONFIG_DEPRECATION_NOTE, reportProxyRisk, resolveConfig } from './main.js';

// This module is loaded only by `fireboat login` and `fireboat logout` (a lazy import in cli.js). The serving graph
// reached from main.js never imports it, so the serving process has no listener and no browser launcher.

// Static and neutral: it never echoes the code or state, and it claims nothing before the code exchange has run.
const CALLBACK_PAGE = '<!doctype html><html><head><meta charset="utf-8"><title>fireboat</title></head><body><p>Return to the terminal to see the result.</p></body></html>\n';

/**
 * The `fireboat login` redirect listener: 127.0.0.1 only (port 0 picks an ephemeral port), exact `Host`, only
 * `GET /callback`. Only a callback that `accept` admits (the login's exact state) completes it; any other request is
 * refused and does not consume it. After the accepted callback, later callbacks get 410 until `close()` (the login
 * closes it as soon as the code exchange ends) or the timeout.
 */
export function listenLoopbackCallback(port: number, timeoutMs: number, accept: (params: URLSearchParams) => boolean): Promise<CallbackListener> {
  return new Promise<CallbackListener>((resolveListener, rejectListener) => {
    let accepted = false, closed = false, listening = false, boundPort = 0;
    let deliver!: (params: URLSearchParams) => void, fail!: (error: CallbackFault) => void;
    const result = new Promise<URLSearchParams>((resolvePromise, rejectPromise) => { deliver = resolvePromise; fail = rejectPromise; });
    result.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const server = createHttpServer((req, res) => {
      res.setHeader('cache-control', 'no-store');
      res.setHeader('referrer-policy', 'no-referrer');
      const expectedHost = `127.0.0.1:${boundPort}`;
      if (req.headers.host !== expectedHost) { res.statusCode = 400; res.end(); return; }
      let url: URL;
      try { url = new URL(req.url ?? '/', `http://${expectedHost}`); } catch { res.statusCode = 400; res.end(); return; }
      if (req.method !== 'GET') { res.statusCode = 404; res.end(); return; }
      if (url.pathname !== '/callback') { res.statusCode = 404; res.end(); return; }
      if (accepted) { res.statusCode = 410; res.end(); return; }
      const params = new URLSearchParams(url.search);
      let admitted = false;
      try { admitted = accept(params); } catch { admitted = false; }
      if (!admitted) { res.statusCode = 400; res.end(); return; }
      accepted = true;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.setHeader('content-security-policy', "default-src 'none'");
      res.setHeader('x-content-type-options', 'nosniff');
      res.end(CALLBACK_PAGE);
      deliver(params);
    });
    const close = (): void => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      server.close();
      server.closeAllConnections();
      if (!accepted) fail(new CallbackFault('LISTENER_CLOSED'));
    };
    server.on('error', () => {
      if (!listening) { closed = true; rejectListener(new CallbackFault('LISTENER_UNAVAILABLE')); return; }
      close();
    });
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
      listening = true;
      const address = server.address();
      if (!address || typeof address === 'string') { closed = true; server.close(); rejectListener(new CallbackFault('LISTENER_UNAVAILABLE')); return; }
      boundPort = address.port;
      timer = setTimeout(() => { if (!accepted) fail(new CallbackFault('CALLBACK_TIMEOUT')); close(); }, timeoutMs);
      resolveListener({ host: address.address, port: boundPort, redirectUri: `http://127.0.0.1:${boundPort}/callback`, result, close });
    });
  });
}

interface AccountOptions { command: 'login' | 'logout'; configPath?: string; deprecatedConfig: boolean; browser: boolean; timeoutSeconds: number }
const DEFAULT_TIMEOUT_S = 300;
const CODE = /^[A-Z][A-Z_]{1,63}$/;

/** The config path follows the same rule as serving and doctor (`resolveConfig` in main.ts). */
function parseAccountArgs(argv: string[]): AccountOptions {
  const command = argv[0] === 'login' ? 'login' : argv[0] === 'logout' ? 'logout' : undefined;
  if (!command) throw new Error();
  let browser = true, timeoutSeconds = DEFAULT_TIMEOUT_S, timeoutSet = false;
  const choice = resolveConfig(argv.slice(1), (arg, next) => {
    if (command === 'login' && arg === '--no-browser' && browser) { browser = false; return 1; }
    if (command === 'login' && arg === '--timeout' && !timeoutSet && /^[1-9][0-9]{0,3}$/.test(next ?? '') && Number(next) <= 3_600) {
      timeoutSeconds = Number(next); timeoutSet = true; return 2;
    }
    return 0;
  });
  return { command, ...choice, browser, timeoutSeconds };
}

/** Opens the system browser with an argument array and no shell; a failure leaves the printed URL as the way in. */
function openBrowser(url: URL): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'linux' ? 'xdg-open' : undefined;
  if (!command) return;
  try {
    const child = spawn(command, [url.href], { stdio: 'ignore', detached: true, shell: false });
    child.on('error', () => undefined);
    child.unref();
  } catch { /* the URL is already on stderr */ }
}

const failure = (code: string, exit: number): number => { process.stderr.write(`fireboat: ${CODE.test(code) ? code : 'LOGIN_FAILED'}\n`); return exit; };

/**
 * `fireboat login` and `fireboat logout` for smart_standalone_launch. Login runs discovery, the one-shot loopback
 * listener and the code exchange, then writes the token file; it prints the authorization URL (state and PKCE
 * challenge only) to stderr. Neither command prints tokens, codes or verifiers. A failure is one stderr code line.
 */
export async function accountCommand(argv: string[]): Promise<number> {
  let opts: AccountOptions;
  try { opts = parseAccountArgs(argv); } catch { return failure('ARGUMENTS_INVALID', 2); }
  if (opts.deprecatedConfig) process.stderr.write(CONFIG_DEPRECATION_NOTE);
  reportProxyRisk();
  if (!opts.configPath) return failure('CONFIG_INVALID', 2);
  let gateway: FhirGateway;
  try {
    const parsed: unknown = JSON.parse(await readFile(resolve(opts.configPath), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    gateway = new FhirGateway(parsed as GatewayConfig);
  } catch { return failure('CONFIG_INVALID', 2); }
  try {
    const tokenFile = gateway.smartTokenFile();
    if (tokenFile === undefined) return failure('LOGIN_UNSUPPORTED', 2);
    if (opts.command === 'logout') {
      // Under the grant lock, so a refresh in progress in a serving process cannot write the grant back afterwards.
      const removed = await removeStoredGrant(tokenFile);
      process.stdout.write(`logout: ${removed ? 'removed' : 'absent'}\n`);
      return 0;
    }
    const browser = opts.browser;
    const result = await gateway.smartLogin({
      listen: listenLoopbackCallback,
      timeoutMs: opts.timeoutSeconds * 1_000,
      onAuthorizeUrl: url => {
        process.stderr.write(`fireboat: authorize: ${url.href}\n`);
        if (browser) openBrowser(url);
      },
    });
    for (const warning of result.warnings) process.stderr.write(`fireboat: warning: ${warning}\n`);
    process.stdout.write(`login: ok scope=${result.scope} granted_types=${result.grantedTypes}/${result.servedTypes} refresh=${result.refresh ? 'present' : 'absent'}\n`);
    return 0;
  } catch (error) {
    if (error instanceof LoginFault) return failure(error.code, 1);
    const code = (error as { code?: unknown } | null)?.code;
    return failure(typeof code === 'string' ? code : 'LOGIN_FAILED', 1);
  } finally {
    gateway.close();
  }
}
