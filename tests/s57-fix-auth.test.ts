import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { FhirGateway } from '../packages/core/src/index.js';
import { ClientCredentialsProvider, LocalWorkRefusal } from '../packages/auth/src/client-credentials.js';
import { lab, output } from './s57-sdk-helpers.js';

test('S57fix S5H-05 token acquisition preserves typed local refusal identity for every waiter', async () => {
  const refusal = new LocalWorkRefusal();
  const provider = new ClientCredentialsProvider('http://127.0.0.1:1/fhir', {
    type: 'client_credentials', tokenUrl: 'http://127.0.0.1:1/token', clientId: 'synthetic', clientSecretEnv: 'S57FIX_SECRET',
  }, { env: { S57FIX_SECRET: 'synthetic-secret' }, onRequest: () => { throw refusal; }, fetchFn: async () => { assert.fail('refused work cannot send'); } });
  try {
    const url = new URL('http://127.0.0.1:1/fhir/Observation');
    const results = await Promise.allSettled([provider.authorizationFor(url), provider.authorizationFor(url)]);
    assert.ok(results.every(result => result.status === 'rejected' && result.reason === refusal));
  } finally { provider.close(); }
});

for (const era of ['modern', 'legacy'] as const) for (const concurrent of [false, true]) {
  test(`S57fix S5H-05/S57-R05 ${era} token work refusal preserves epochs, handles and cursors (${concurrent ? 'shared joiner' : 'single caller'})`, async () => {
    const counts = { auth: 0, metadata: 0, clinical: 0 };
    let base = '';
    const source = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/token') { counts.auth++; req.resume(); res.end(JSON.stringify({ access_token: 'synthetic-token', token_type: 'Bearer', expires_in: 3600 })); return; }
      if (req.url === '/fhir/metadata') {
        counts.metadata++;
        res.end(JSON.stringify({ resourceType: 'CapabilityStatement', fhirVersion: '4.0.1', rest: [{ mode: 'server', resource: [{ type: 'Observation',
          interaction: [{ code: 'read' }, { code: 'search-type' }], searchParam: [{ name: 'subject', type: 'reference' }] }] }] })); return;
      }
      counts.clinical++;
      if (req.url?.startsWith('/fhir/Observation?')) {
        const self = new URL(req.url, base).href;
        res.end(JSON.stringify({ resourceType: 'Bundle', type: 'searchset', link: [{ relation: 'self', url: self }],
          entry: Array.from({ length: 12 }, (_, i) => lab(`synthetic-row-${i}`)).map(resource => ({ search: { mode: 'match' }, resource })) }));
      } else res.end(JSON.stringify(lab()));
    });
    await new Promise<void>(resolve => source.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(source.address() as { port: number }).port}`;
    const previous = process.env.S57FIX_AUTH_SECRET; process.env.S57FIX_AUTH_SECRET = 'synthetic-secret';
    const gateway = new FhirGateway({ mode: 'synthetic', source: { alias: 'synthetic', baseUrl: `${base}/fhir`, auth: {
      type: 'client_credentials', tokenUrl: `${base}/token`, clientId: 'synthetic', clientSecretEnv: 'S57FIX_AUTH_SECRET',
    } }, patientId: 'synthetic-a' });
    const g = gateway as any;
    try {
      const first = await gateway.execute('fhir_search', { resource_type: 'Observation', page_size: 1, output: { format: 'fhir', max_bytes: 8192 } }, { era });
      assert.equal(first.error, undefined); assert.ok(first.result); assert.ok(first.pagination?.next_cursor);
      const metadata = await gateway.execute('fhir_capabilities', { topic: 'support', limit: 1, output }, { era });
      assert.ok(metadata.data.next_cursor);
      const before = { epoch: g.authEpoch, generation: g.stateGeneration, clinical: g.store.size, discovery: g.discoveryStore.size };
      const countsBefore = { ...counts };
      const get = g.transport.get.bind(g.transport), observer = g.credentials.onRequest;
      const args = { resource_type: 'Observation', id: 'synthetic-lab', output };
      let joiner: ReturnType<FhirGateway['execute']> | undefined;
      let repeating = true;
      g.transport.get = async (...params: any[]) => {
        if (!repeating) return get(...params);
        repeating = false;
        let result;
        for (let i = 0; i < 21; i++) { g.credentials.invalidate(); result = await get(...params); }
        return result;
      };
      // Timing-only seam: queue a real second library call before the refused
      // provider flight settles. No token/error/storage behavior is replaced.
      g.credentials.onRequest = () => {
        try { observer(); }
        catch (error) {
          if (concurrent) queueMicrotask(() => { joiner = gateway.execute('fhir_read', args, { era }); });
          throw error;
        }
      };
      const refused = await gateway.execute('fhir_read', args, { era });
      assert.equal(refused.error?.code, 'NOT_FOUND'); assert.equal(refused.budget.upstream_calls, 20);
      if (concurrent) {
        assert.ok(joiner);
        const joined = await joiner;
        assert.equal(joined.error?.code, 'UPSTREAM_LIMIT'); assert.equal(joined.budget.upstream_calls, 0);
      }
      assert.deepEqual({ epoch: g.authEpoch, generation: g.stateGeneration, clinical: g.store.size, discovery: g.discoveryStore.size }, before);
      assert.deepEqual({ auth: counts.auth - countsBefore.auth, metadata: counts.metadata - countsBefore.metadata, clinical: counts.clinical - countsBefore.clinical }, { auth: 10, metadata: 0, clinical: 10 });
      g.transport.get = get; g.credentials.onRequest = observer;
      const inspect = await gateway.execute('fhir_result', { handle: first.result.handle, action: 'inspect', output }, { era });
      assert.equal(inspect.error, undefined);
      const page = await gateway.execute('fhir_page', { cursor: first.pagination.next_cursor, output }, { era });
      assert.equal(page.error, undefined); assert.ok(Array.isArray(page.data.resources) && page.data.resources.length > 0);
      const discovery = await gateway.execute('fhir_capabilities', { topic: 'support', cursor: metadata.data.next_cursor, limit: 1, output }, { era });
      assert.equal(discovery.error, undefined);
    } finally {
      gateway.close(); source.closeAllConnections(); await new Promise<void>(resolve => source.close(() => resolve()));
      if (previous === undefined) delete process.env.S57FIX_AUTH_SECRET; else process.env.S57FIX_AUTH_SECRET = previous;
    }
  });
}
