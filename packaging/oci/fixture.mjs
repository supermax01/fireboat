// Deferred S10 negatives only. No host publication. All listeners are literal
// loopback inside the already verified helper-owned HAPI network namespace.
import { createServer, get, request } from 'node:http';
import { readlink } from 'node:fs/promises';

const control = method => new Promise((resolve, reject) => {
  const req = request(`http://127.0.0.1:19083/control/${method === 'POST' ? 'reset' : 'status'}`, { method, agent: false, timeout: 2000 }, res => {
    let body = ''; res.setEncoding('utf8'); res.on('data', text => { body += text; if (body.length > 8192) req.destroy(); });
    res.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(new Error('FIXTURE_STATUS')); } });
  }); req.on('timeout', () => req.destroy()); req.on('error', reject); req.end();
});
if (process.argv[2] === 'status' || process.argv[2] === 'reset') {
  console.log(JSON.stringify(await control(process.argv[2] === 'reset' ? 'POST' : 'GET')));
} else {
  const metadata = await new Promise((resolve, reject) => {
    const req = get('http://127.0.0.1:8080/fhir/metadata', { agent: false, timeout: 5000 }, res => {
      const chunks = []; let size = 0;
      if (res.statusCode !== 200) { req.destroy(); reject(new Error('FIXTURE_METADATA')); return; }
      res.on('data', b => { chunks.push(b); size += b.length; if (size > 5 * 1024 * 1024) req.destroy(); });
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }); req.on('error', reject); req.on('timeout', () => req.destroy());
  });
  const namespace = await readlink('/proc/self/ns/net');
  let stats = { redirects: 0, trap: 0, proxy: 0, hanging: 0, hangClosed: 0 };
  const servers = [
    [19080, (req, res) => {
      if (req.url === '/redirect/fhir/metadata') {
        stats.redirects++; res.writeHead(302, { location: 'http://127.0.0.1:19081/trap' }); res.end();
      } else if (req.url === '/hang/fhir/metadata') {
        res.writeHead(200, { 'content-type': 'application/fhir+json' }); res.end(metadata);
      } else if (req.url?.startsWith('/hang/fhir/Patient/')) {
        stats.hanging++; res.on('close', () => { stats.hangClosed++; });
      } else { res.writeHead(404); res.end(); }
    }],
    [19081, (_req, res) => { stats.trap++; res.writeHead(418); res.end(); }],
    [19082, (_req, res) => { stats.proxy++; res.writeHead(418); res.end(); }],
    [19083, (req, res) => {
      if (req.method === 'POST' && req.url === '/control/reset') stats = { redirects: 0, trap: 0, proxy: 0, hanging: 0, hangClosed: 0 };
      else if (req.method !== 'GET' || req.url !== '/control/status') { res.writeHead(404); res.end(); return; }
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ...stats, namespace }));
    }],
  ].map(([port, handler]) => {
    const server = createServer(handler);
    server.listen(port, '127.0.0.1');
    return server;
  });
  const stop = () => { for (const server of servers) { server.closeAllConnections(); server.close(); } };
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, stop);
}
