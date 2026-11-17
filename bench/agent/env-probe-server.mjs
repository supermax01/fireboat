// Harness self-test MCP server (agent mock runs only, never a benchmark arm). On start it writes the NAMES of its
// environment variables (never their values) to ./env-names.json, then answers initialize, tools/list (no tools) and
// ping over stdio, so Claude Code connects. Used to check that a stdio server sees only the arm's declared environment.
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const names = Object.keys(process.env).sort();
writeFileSync('env-names.json', JSON.stringify({ names, anthropic_api_key_present: names.includes('ANTHROPIC_API_KEY') }) + '\n');

const send = msg => process.stdout.write(JSON.stringify(msg) + '\n');
for await (const line of createInterface({ input: process.stdin })) {
  let m;
  try { m = JSON.parse(line); } catch { continue; }
  if (m.id === undefined) continue; // notifications
  if (m.method === 'initialize') {
    send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'env-probe', version: '0' } } });
  } else if (m.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: m.id, result: { tools: [] } });
  } else if (m.method === 'ping') {
    send({ jsonrpc: '2.0', id: m.id, result: {} });
  } else {
    send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'method not found' } });
  }
}
