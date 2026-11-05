// Test-only stdio bridge, mounted read-only; not an image layer or product entry.
// stdout is the gateway's unchanged JSON-RPC. A separate stderr channel carries
// the installed helper observer's fd-3 barriers, never gateway diagnostics.
import { spawn } from 'node:child_process';
import { CLI } from './inventory.mjs';

const child = spawn(process.execPath, ['--import', '/s10/observer.mjs', CLI,
  '--config', '/run/fireboat/config.json'], { stdio: ['pipe', 'pipe', 'ignore', 'pipe'], env: { PATH: process.env.PATH ?? '' } });
child.stdout.pipe(process.stdout);
let input = '', observer = '';
const stop = () => { child.kill('SIGTERM'); process.stdin.destroy(); };
process.stdin.setEncoding('utf8');
process.stdin.on('data', text => {
  input += text;
  if (Buffer.byteLength(input) > 8 * 1024 * 1024) { stop(); return; }
  let end;
  while ((end = input.indexOf('\n')) >= 0) {
    const line = input.slice(0, end + 1); input = input.slice(end + 1);
    try {
      const value = JSON.parse(line);
      if (value.fireboatS10 && Object.keys(value).length === 1) child.stdio[3].write(JSON.stringify(value.fireboatS10) + '\n');
      else if (value.jsonrpc === '2.0') child.stdin.write(line);
      else stop();
    } catch { stop(); }
  }
});
child.stdio[3].setEncoding('utf8');
child.stdio[3].on('data', text => {
  observer += text;
  if (Buffer.byteLength(observer) > 8192) { stop(); return; }
  let end;
  while ((end = observer.indexOf('\n')) >= 0) {
    const line = observer.slice(0, end); observer = observer.slice(end + 1);
    try { process.stderr.write(JSON.stringify({ fireboatS10: JSON.parse(line) }) + '\n'); } catch { stop(); }
  }
});
for (const stream of [child.stdin, child.stdout, child.stdio[3]]) stream.on('error', stop);
process.stdin.on('end', () => { child.stdin.end(); child.stdio[3].end(); });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('error', () => { process.exitCode = 1; stop(); });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); process.stdin.destroy(); });
