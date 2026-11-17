import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { FhirGateway } from '../packages/core/src/index.js';
import { createMcpServer } from '../packages/server/src/index.js';
import { withGateway, withSdk, output } from './s57-sdk-helpers.js';
import { validateDeliverable02 } from '../packages/core/src/contracts.js';
import { assertCountOnce } from './count-once-helpers.js';

for (const era of ['modern','legacy'] as const) test(`S57b ${era} drained declared-only shared searches remain unknown and gate-valid, including empty constraints`, async () => {
  // Organization is not searched source-wide (shared-directory reachability), so the unconfined shared-search property
  // is pinned on Medication, a catalog type that keeps it.
  await withGateway({ shared: true, pages: [[{ resourceType: 'Medication', id: 'synthetic-catalog', code: { coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '1000001' }] } }]] }, g => withSdk(g, era, async sdk => {
    for (const params of [[], [{name:'_id',value:'synthetic-catalog'}]]) {
      const {e,wire,capture} = await sdk.call('fhir_search',{resource_type:'Medication',params,output});
      assert.equal(e.error,undefined); assert.equal(e.data.resources.length,1);
      assert.equal(e.coverage.query_evidence,'declared_and_self_link_only');
      assert.equal(e.coverage.state,'unknown'); assert.equal(e.coverage.query_exhausted,true); assert.equal(e.pagination.has_more,false);
      assert.equal(e.coverage.constraints.length,params.length);
      assert.deepEqual(validateDeliverable02('fhir_search',wire.structuredContent,capture),{ok:true});
      const falseComplete = { ...wire.structuredContent, coverage: {...e.coverage,state:'complete_for_query'} };
      assert.deepEqual(validateDeliverable02('fhir_search',falseComplete,capture),{ok:false,reason:'INVALID_CROSS_FIELDS'});
    }
  }));
});

for (const era of ['modern', 'legacy'] as const) {
  // Count once (schema 0.4): eight server rows now fit the 4096-byte model copy, so forty advertised types drive the truncation.
  test(`S57 ${era} sole production SDK path delivers minimal read/search at 4096 and truncates a forty-type server safely`, async () => {
    const row = { resourceType: 'Observation', id: 'synthetic-o1', status: 'final',
      code: { coding: [{ system: 'http://loinc.org', code: '4548-4' }] },
      subject: { reference: 'Patient/synthetic-patient-a' },
      valueQuantity: { value: 7.1, unit: '%', system: 'http://unitsofmeasure.org', code: '%' } };
    const source = createServer((req, res) => {
      res.setHeader('content-type', 'application/fhir+json');
      const url = new URL(req.url!, `http://${req.headers.host}`);
      if (url.pathname.endsWith('/metadata')) res.end(JSON.stringify({ resourceType: 'CapabilityStatement', fhirVersion: '4.0.1',
        rest: [{ mode: 'server', resource: ['Patient', 'Observation', 'Condition', 'AllergyIntolerance', 'MedicationRequest', 'DiagnosticReport', 'DocumentReference', 'Procedure',
          'Encounter', 'Immunization', 'CarePlan', 'CareTeam', 'Goal', 'Device', 'Specimen', 'ServiceRequest', 'Location', 'Organization', 'Practitioner', 'Medication',
          'Account', 'Appointment', 'Basic', 'Binary', 'BodyStructure', 'Claim', 'Communication', 'Composition', 'Consent', 'Coverage', 'DetectedIssue', 'DeviceRequest',
          'EpisodeOfCare', 'FamilyMemberHistory', 'Flag', 'Group', 'ImagingStudy', 'Invoice', 'List', 'MedicationAdministration'].map(type => ({
          type, interaction: [{ code: 'read' }, { code: 'search-type' }], searchParam: type === 'Observation' ? [{ name: 'subject', type: 'reference' }] : [] })) }] }));
      else if (url.pathname.endsWith('/synthetic-o1')) res.end(JSON.stringify(row));
      else res.end(JSON.stringify({ resourceType: 'Bundle', type: 'searchset', link: [{ relation: 'self', url: url.href }], entry: [{ search: { mode: 'match' }, resource: row }] }));
    });
    await new Promise<void>(r => source.listen(0, '127.0.0.1', r));
    const gateway = new FhirGateway({ mode: 'synthetic', source: { alias: 'local-synthetic', baseUrl: `http://127.0.0.1:${(source.address() as { port: number }).port}/fhir` },
      patientId: 'synthetic-patient-a', contextId: 'ctx_00000000-0000-4000-8000-000000000001' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const frames: Record<string, any>[] = [];
    const send = b.send.bind(b); b.send = async (message, opts) => { if ('result' in message) frames.push(message.result as Record<string, any>); await send(message, opts); };
    const server = serveStdio(() => createMcpServer(gateway, { era }), { transport: b });
    const client = new Client({ name: 's57-synthetic', version: '1' }, era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : undefined);
    try {
      await client.connect(a);
      for (const tool of ['fhir_read', 'fhir_search'] as const) {
        const result = await client.callTool({ name: tool, arguments: { resource_type: 'Observation', ...(tool === 'fhir_read' ? { id: row.id } : {}), output: { max_bytes: 4096 } } });
        const env = result.structuredContent as Record<string, any>;
        assert.equal(env.error, undefined);
        assert.equal(env.schema_version, '0.4'); assert.deepEqual(env.data.resources, [row]);
        assert.equal(env.transform.format, 'fhir'); assert.equal(env.transform.delivery_profile, 'full-text-v1');
        assert.equal(env.warnings.some((w: any) => w.code === 'TEST_ENVELOPE_CORRUPTOR_ACTIVE'), false);
        // Count once: bytes_returned is the model copy and wire_bytes the complete frame result, each measured here.
        assertCountOnce(frames.at(-1)!, env.budget);
        assert.ok(env.budget.bytes_returned <= 4096);
      }
      const result = await client.callTool({ name: 'fhir_capabilities', arguments: { topic: 'server', output: { max_bytes: 4096 } } });
      const env = result.structuredContent as Record<string, any>;
      assert.equal(env.error, undefined); assert.equal(env.coverage.state, 'partial');
      assert.deepEqual(env.coverage.reasons, ['DECLARED_CAPABILITIES_NOT_PRODUCTION_VERIFICATION', 'CAPABILITY_SUMMARY_LIMIT']);
      assert.ok(env.data.resources.length < 40); assert.equal(env.data.resource_count, 40);
      assert.equal(env.pagination, undefined); assert.ok(!env.coverage.reasons.includes('MORE_PAGES'));
      assertCountOnce(frames.at(-1)!, env.budget as never);
      const listed = await client.listTools();
      assert.ok(JSON.stringify(listed).includes('"support"') && JSON.stringify(listed).includes('"search_parameter"'), 'the catalog advertises both implemented discovery topics');
    } finally { await client.close(); await server.close(); gateway.close(); source.closeAllConnections(); await new Promise<void>(r => source.close(() => r())); }
  });
}
