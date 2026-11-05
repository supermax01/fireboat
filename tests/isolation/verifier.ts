import assert from 'node:assert/strict';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
/** Separate verifier fixture, never substituted for a gateway execution. It plants server
 * traffic and proves the inbound observer detects it. Legacy callbacks are dispatched by
 * the SDK; modern unsolicited push is rejected by its codec, so raw observation is required. */
export async function serverTrafficLiveness() {
  const reports = [];
  for (const era of ['modern', 'legacy'] as const) {
    const handled: string[] = []; const observed: string[] = [];
    const client = new Client({ name: 'b2-verifier-only', version: '1' }, { capabilities: { roots: {}, sampling: {}, elicitation: {} }, ...(era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {}) } as never);
    for (const method of ['roots/list', 'sampling/createMessage', 'elicitation/create']) client.setRequestHandler(method as never, (async () => {
      handled.push(method);
      return method === 'roots/list' ? { roots: [] } : method === 'elicitation/create' ? { action: 'decline' } : { model: 'offline-stub', role: 'assistant', content: { type: 'text', text: 'offline verifier' } };
    }) as never);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const server = serveStdio(() => new McpServer({ name: 'b2-verifier-fixture', version: '1' }), { transport: st });
    await client.connect(ct);
    try {
      const receive = ct.onmessage;
      ct.onmessage = message => { const m = message as { method?: string }; if (m.method) observed.push(m.method); receive?.(message); };
      let id = 100;
      const vectors = [
        { method: 'roots/list', params: {} },
        { method: 'sampling/createMessage', params: { maxTokens: 1, messages: [{ role: 'user', content: { type: 'text', text: 'offline' } }] } },
        { method: 'elicitation/create', params: { message: 'offline', requestedSchema: { type: 'object', properties: {} } } },
        { method: 'notifications/message', params: { level: 'info', data: 'offline verifier diagnostic' } },
      ];
      for (const v of vectors) await st.send({ jsonrpc: '2.0', ...(v.method.startsWith('notifications/') ? {} : { id: id++ }), method: v.method, params: v.params } as never);
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.deepEqual(observed, vectors.map(v => v.method), 'all planted server traffic observed before codec');
      if (era === 'legacy') assert.equal(handled.length, 3, 'all live legacy callbacks dispatched');
      reports.push({ era, raw_observer_hits: observed.length, sdk_callback_hits: handled.length, modern_push: era === 'modern' ? 'unsolicited push rejected by SDK; raw observer still detects all four vectors' : 'not_applicable' });
    } finally { await client.close(); await server.close(); }
  }
  return { verdict: 'PASS', fixture_only: true, reports };
}
