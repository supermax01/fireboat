// Synthetic-only loopback FHIR fixture for B2 gap verification (G1-G3).
// Semantically honest search execution over a fixed A/B dataset; metadata and
// unknown-reference behavior are configurable to model source variation.
import { createServer, type Server } from 'node:http';
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { FhirGateway, type GatewayEnvelope, type ToolName } from '../packages/core/src/index.js';

type R = Record<string, any>;
export type Twin = 'positive' | 'b-code' | 'b-performer' | 'b-absent';
export type MissingRef = 'empty' | '404' | '400' | 'oo-warning' | 'oo-info';
export interface Options {
  twin?: Twin;
  missingRef?: MissingRef;
  // type -> declared search parameters (name + optional type)
  declare: Record<string, { name: string; type?: string }[]>;
  // types advertised with read interaction as well
  readable?: string[];
  metadata?: (value: R) => R;
  records?: R[];
  paginate?: boolean;
}

export function dataset(twin: Twin): R[] {
  const pats = [
    { resourceType: 'Patient', id: 'pat-a', active: true, name: [{ family: 'Alphasynth', given: ['Ann'] }], managingOrganization: { reference: 'Organization/org-a' } },
    { resourceType: 'Patient', id: 'pat-b', active: true, name: [{ family: 'Bravosynth', given: ['Ben'] }], managingOrganization: { reference: 'Organization/org-b' } },
  ];
  const pracs = [
    { resourceType: 'Practitioner', id: 'prac-1', active: true, name: [{ family: 'Sharedone' }] },
    { resourceType: 'Practitioner', id: 'prac-2', active: true, name: [{ family: 'Aonlytwo' }] },
    { resourceType: 'Practitioner', id: 'prac-3', active: true, name: [{ family: 'Twinthree' }] },
  ];
  const orgs = [
    { resourceType: 'Organization', id: 'org-a', active: true, name: 'Synthetic Clinic A' },
    { resourceType: 'Organization', id: 'org-b', active: true, name: 'Synthetic Clinic B' },
  ];
  const encs = [
    { resourceType: 'Encounter', id: 'enc-a', status: 'finished', class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB' }, subject: { reference: 'Patient/pat-a' } },
    { resourceType: 'Encounter', id: 'enc-b', status: 'finished', class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB' }, subject: { reference: 'Patient/pat-b' } },
  ];
  const obs = (id: string, pat: string, code: string, prac: string, enc: string) => ({
    resourceType: 'Observation', id, status: 'final', subject: { reference: `Patient/${pat}` },
    code: { coding: [{ system: 'http://loinc.org', code }] }, performer: [{ reference: `Practitioner/${prac}` }],
    encounter: { reference: `Encounter/${enc}` }, effectiveDateTime: '2025-01-01T10:00:00Z', valueQuantity: { value: 7, unit: '%' },
  });
  const observations = [obs('obs-a1', 'pat-a', '1111-1', 'prac-1', 'enc-a'), obs('obs-a2', 'pat-a', '2222-2', 'prac-2', 'enc-a')];
  if (twin === 'positive') observations.push(obs('obs-b1', 'pat-b', '9999-9', 'prac-1', 'enc-b'));
  if (twin === 'b-code') observations.push(obs('obs-b1', 'pat-b', '8888-8', 'prac-1', 'enc-b'));
  if (twin === 'b-performer') observations.push(obs('obs-b1', 'pat-b', '9999-9', 'prac-3', 'enc-b'));
  const lists = [{ resourceType: 'List', id: 'list-b', status: 'current', mode: 'working', subject: { reference: 'Patient/pat-b' }, entry: [{ item: { reference: `Practitioner/${twin === 'b-performer' ? 'prac-3' : 'prac-1'}` } }] }];
  return [...pats, ...pracs, ...orgs, ...encs, ...observations, ...lists];
}

// param name -> element holding the reference, per type
const REF_PARAMS: Record<string, Record<string, string>> = {
  Observation: { patient: 'subject', subject: 'subject', performer: 'performer', encounter: 'encounter' },
  Encounter: { patient: 'subject', subject: 'subject' },
  Patient: { organization: 'managingOrganization' },
  List: { patient: 'subject', subject: 'subject' },
};
const refsOf = (resource: R, field: string): string[] => {
  const v = resource[field];
  return (Array.isArray(v) ? v : v ? [v] : []).map((x: R) => x?.reference).filter((x: unknown): x is string => typeof x === 'string');
};

export async function startFixture(options: Options) {
  const db = options.records ?? dataset(options.twin ?? 'positive');
  const byRef = (ref: string) => db.find(r => `${r.resourceType}/${r.id}` === ref);
  const requests: string[] = [];
  let base = '';
  let missingTargetSeen = false;

  const refMatches = (ref: string, value: string): boolean => {
    if (value.includes('/')) return ref === value || ref.endsWith(`/${value}`);
    return ref.split('/').pop() === value;
  };
  const targetExists = (value: string, sourceType: string, param: string): boolean => {
    if (value.includes('/')) return Boolean(byRef(value.replace(base, '')));
    // bare id: any type
    return db.some(r => r.id === value);
  };
  const matches = (resource: R, name: string, rawValue: string): boolean => {
    const alternatives = rawValue.split(',');
    const has = /^_has:([A-Za-z]+):([A-Za-z-]+):(.+)$/.exec(name);
    if (has) {
      const [, t, refParam, rest] = has as unknown as [string, string, string, string];
      const field = REF_PARAMS[t]?.[refParam];
      if (!field) return false;
      return db.some(r2 => r2.resourceType === t && refsOf(r2, field).includes(`${resource.resourceType}/${resource.id}`) && matches(r2, rest, rawValue));
    }
    const dot = name.indexOf('.');
    if (dot > 0) {
      const head = name.slice(0, dot); const rest = name.slice(dot + 1);
      const [refParam, targetType] = head.split(':');
      const field = REF_PARAMS[resource.resourceType]?.[refParam!];
      if (!field) return false;
      return refsOf(resource, field).map(byRef).some(t => t && (!targetType || t.resourceType === targetType) && matches(t, rest, rawValue));
    }
    const plain = name.split(':')[0]!;
    if (plain === '_id') return alternatives.includes(resource.id);
    if (plain === '_list') return db.some(l => l.resourceType === 'List' && alternatives.includes(l.id) && (l.entry ?? []).some((e: R) => e.item?.reference === `${resource.resourceType}/${resource.id}`));
    const field = REF_PARAMS[resource.resourceType]?.[plain];
    if (field) {
      for (const v of alternatives) if (!targetExists(v, resource.resourceType, plain)) missingTargetSeen = true;
      return refsOf(resource, field).some(ref => alternatives.some(v => refMatches(ref, v)));
    }
    if (plain === 'code') return (resource.code?.coding ?? []).some((c: R) => alternatives.some(v => v === c.code || v === `${c.system}|${c.code}`));
    if (plain === 'date' || plain === '_lastUpdated') return true;
    if (plain === 'name' || plain === 'family') {
      const names = Array.isArray(resource.name) ? resource.name.map((n: R) => [n.family, ...(n.given ?? [])].join(' ')) : [String(resource.name ?? '')];
      return names.some((n: string) => alternatives.some(v => n.toLowerCase().includes(v.toLowerCase())));
    }
    // custom relationship parameter declared by a source on Practitioner:
    // practitioners who performed an Observation for a patient whose family matches.
    if (plain === 'patient-family' && resource.resourceType === 'Practitioner') return matches(resource, '_has:Observation:performer:subject:Patient.family', rawValue);
    return false;
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url!, base);
    requests.push(`${req.method} ${url.pathname}${url.search}`);
    res.setHeader('content-type', 'application/fhir+json');
    if (url.pathname === '/fhir/metadata') {
      res.end(JSON.stringify((options.metadata ?? (v => v))({
        resourceType: 'CapabilityStatement', status: 'active', kind: 'instance', fhirVersion: '4.0.1', format: ['json'],
        rest: [{ mode: 'server', resource: Object.entries(options.declare).map(([type, params]) => ({
          type, interaction: [{ code: 'search-type' }, ...((options.readable ?? []).includes(type) ? [{ code: 'read' }] : [])],
          searchParam: params.map(p => ({ ...p })),
        })) }],
      })));
      return;
    }
    const parts = url.pathname.replace(/^\/fhir\//, '').split('/');
    if (parts.length === 2) { // read
      const r = byRef(`${parts[0]}/${parts[1]}`);
      if (!r) { res.statusCode = 404; res.end(JSON.stringify({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'not-found' }] })); return; }
      res.end(JSON.stringify(r)); return;
    }
    const type = parts[0]!;
    missingTargetSeen = false;
    let selected = db.filter(r => r.resourceType === type);
    for (const [name, value] of url.searchParams) {
      if (['_count', '_sort', '_format'].includes(name)) continue;
      selected = selected.filter(r => matches(r, name, value));
    }
    // reference targets are checked even when no candidate survives (honest servers resolve the target up front)
    for (const [name, value] of url.searchParams) {
      const field = REF_PARAMS[type]?.[name.split(':')[0]!];
      if (field) for (const v of value.split(',')) if (!targetExists(v, type, name)) missingTargetSeen = true;
    }
    const mode = options.missingRef ?? 'empty';
    if (missingTargetSeen && (mode === '404' || mode === '400')) {
      res.statusCode = Number(mode);
      res.end(JSON.stringify({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: mode === '404' ? 'not-found' : 'invalid', diagnostics: 'Resource is not known' }] }));
      return;
    }
    const outcome = missingTargetSeen && (mode === 'oo-warning' || mode === 'oo-info')
      ? [{ resource: { resourceType: 'OperationOutcome', issue: [{ severity: mode === 'oo-warning' ? 'warning' : 'information', code: 'not-found', diagnostics: 'Reference target is not known' }] }, search: { mode: 'outcome' } }]
      : [];
    res.end(JSON.stringify({
      resourceType: 'Bundle', type: 'searchset', total: selected.length,
      link: [{ relation: 'self', url: url.href }, ...(options.paginate && !url.searchParams.has('_offset') ? [{ relation: 'next', url: `${url.href}&_offset=1` }] : [])],
      entry: [...selected.map(resource => ({ resource, search: { mode: 'match' } })), ...outcome],
    }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  base = `http://127.0.0.1:${address.port}/fhir/`;
  return {
    base, requests,
    close: async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); },
  };
}

// Seeded from Claude's /tmp/b2gap13 fixture/runner and G5 sourcedoc probe.
// No test queries an external service. Twin comparisons include both MCP channels.
type Pair = { name: string; value: string };
const params = (names: string[]) => names.map(name => ({ name }));
const declared = () => ({
  Observation: params(['patient', 'subject', 'code', 'date', 'encounter', 'performer', 'focus']),
  Patient: params(['link', 'organization']), Practitioner: params(['name']), Organization: params(['name', 'partof', 'endpoint']),
});
const output = { format: 'fhir', max_bytes: 24000 } as const;
const normalize = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (key, child) => {
  if (['request_id', 'elapsed_ms', 'bytes_returned', 'retrieved_at', 'expires_at', 'handle', 'cursor', 'next_cursor'].includes(key)) return '<generated>';
  if (typeof child === 'string' && key === 'text') {
    try { return normalize(JSON.parse(child)); } catch { return child; }
  }
  return child;
}));
async function fixture(t: TestContext, options: Options) {
  const f = await startFixture(options);
  const gateway = new FhirGateway({ mode: 'synthetic', source: { alias: 's3-fixture', baseUrl: f.base }, patientId: 'pat-a', contextId: 's3-fixed-context' });
  t.after(async () => { gateway.close(); await f.close(); });
  return { ...f, gateway, clinical: () => f.requests.filter(r => !r.includes('/metadata')) };
}
async function probe(t: TestContext, options: Options, resource_type: string, pairs: Pair[], tool: ToolName = 'fhir_search') {
  const f = await fixture(t, options);
  const envelope = await f.gateway.execute(tool, { resource_type, ...(tool === 'fhir_read' ? { id: 'conformance-1' } : { params: pairs }), output });
  const result = f.gateway.toToolResult(envelope);
  return { ...f, envelope, wire: normalize(result) };
}
async function twins(t: TestContext, resourceType: string, pair: Pair, options: Partial<Options> = {}, expected?: string) {
  const declarations = declared();
  declarations[resourceType as keyof typeof declarations] ??= [];
  declarations[resourceType as keyof typeof declarations].push({ name: pair.name });
  const first = await probe(t, { declare: declarations, ...options, twin: 'positive' }, resourceType, [pair]);
  const second = await probe(t, { declare: declarations, ...options, twin: 'b-performer' }, resourceType, [pair]);
  for (const candidate of [second,
    await probe(t, { declare: declarations, ...options, twin: 'b-code' }, resourceType, [pair]),
    await probe(t, { declare: declarations, ...options, twin: 'b-absent' }, resourceType, [pair]),
  ]) {
    assert.deepEqual(first.wire, candidate.wire, 'entire structured/text outputs equal across B variants');
    if (expected) { assert.equal(candidate.envelope.error?.code, expected); assert.equal(candidate.clinical().length, 0); }
  }
  if (expected) {
    assert.equal(first.envelope.error?.code, expected);
    assert.equal(second.envelope.error?.code, expected);
    assert.deepEqual(first.envelope.data, {});
    assert.equal(first.clinical().length, 0);
    assert.equal(second.clinical().length, 0);
  }
  return [first, second] as const;
}
const ids = (env: GatewayEnvelope) => ((env.data as { resources?: R[] }).resources ?? []).map(r => r.id);

test('S3-G1 shared admission and its inherited syntax controls', async t => {
await t.test('S3-G1 directory lookup twins work, custom shared search and unsafe pinned targets never send', async t => {
  const [a, b] = await twins(t, 'Practitioner', { name: 'name', value: 'Sharedone' });
  assert.equal(a.envelope.error, undefined); assert.deepEqual(ids(a.envelope), ['prac-1']);
  assert.equal(b.clinical().length, 1);
  assert.equal(new URL(a.clinical()[0]!.slice(4), a.base).searchParams.has('patient'), false);
  await twins(t, 'Practitioner', { name: 'patient-family', value: 'Bravosynth' }, {}, 'SEARCH_PARAMETER_UNRESOLVED');
  // Medication.ingredient has Substance as a possible target; it is not directory-intrinsic.
  const d = { ...declared(), Medication: params(['ingredient']) };
  const denied = await probe(t, { declare: d }, 'Medication', [{ name: 'ingredient', value: 'Substance/s-b' }]);
  assert.equal(denied.envelope.error?.code, 'UNSUPPORTED_SEARCH'); assert.equal(denied.clinical().length, 0);
});

for (const [name, value] of [
  ['_list', 'list-b'], ['name:exact', 'Sharedone'], ['name.family', 'Sharedone'], ['_has:Observation:performer:code', '9999-9'],
  ['_has:Observation:performer:subject:Patient.family', 'Bravosynth'],
  ['_has:Observation:performer:subject', 'Patient/pat-b'],
] as const) await t.test(`S3-G1 declared shared join ${name} is refused across twins`, async t => {
  await twins(t, 'Practitioner', { name, value }, {}, name === 'name:exact' ? 'UNSUPPORTED_MODIFIER' : 'UNSUPPORTED_SEARCH');
});
await t.test('S3-G1 source token/omitted/reference types cannot enable bare-id reverse joins', async t => {
  for (const type of ['reference', 'token', undefined]) {
    const name = '_has:Observation:performer:subject';
    await twins(t, 'Practitioner', { name, value: 'pat-b' }, { declare: { ...declared(), Practitioner: [{ name, ...(type ? { type } : {}) }] } }, 'UNSUPPORTED_SEARCH');
  }
  const undeclared = await probe(t, { declare: declared() }, 'Practitioner', [{ name: '_has:Observation:performer:code', value: '9999-9' }]);
  assert.equal(undeclared.envelope.error?.code, 'UNSUPPORTED_SEARCH'); assert.equal(undeclared.clinical().length, 0);
});

});

test('S3-G2 typed pre-send syntax and A-confined join controls', async t => {
await t.test('S3-G2 all source-advertised syntax stays closed, including already-refused include controls', async t => {
for (const [name, value] of [
  ['performer._has:Observation:performer:code', '9999-9'],
  ['performer._has:Observation:performer:subject:Patient.family', 'Bravosynth'],
  ['subject:Patient.family', 'Bravosynth'], ['encounter:Encounter.subject', 'pat-b'],
  ['_has', '9999-9'], ['_filter', 'name eq Sharedone'], ['_list', 'list-b'], ['_query', 'synthetic-named'],
  ['_type', 'Observation'], ['_contained', 'true'], ['_containedType', 'both'],
  ['_include', 'Observation:subject'], ['_include:iterate', 'Observation:subject'], ['_revinclude', 'Provenance:target'],
  ['code:not', '9999-9'], ['code:exact', '9999-9'], ['code:missing', 'false'], ['code:text', 'glucose'],
  ['subject:identifier', 'urn:synthetic|mrn-b'], ['code-value-quantity', '4548-4$ge5'],
] as const) await t.test(`source advertisement cannot grant ${name}`, async t => {
  const code = name.includes(':') && !name.includes('.') && !name.startsWith('_include') && !name.startsWith('_revinclude') ? 'UNSUPPORTED_MODIFIER' : 'UNSUPPORTED_SEARCH';
  await twins(t, 'Observation', { name, value }, {}, code);
});
});
await t.test('S3-G2 even A-confined Patient reverse joins are unsupported', async t => {
  for (const value of ['1111-1', '9999-9']) await twins(t, 'Patient', { name: '_has:Observation:patient:code', value }, {}, 'UNSUPPORTED_SEARCH');
});

});

for (const mode of ['empty', '404', '400', 'oo-warning', 'oo-info'] as const) test(`S3-G3 existing/missing Encounter twins never send (${mode})`, async t => {
  for (const type of ['reference', 'token', undefined]) {
    const options = { declare: { ...declared(), Observation: [...params(['patient', 'code']), { name: 'encounter', ...(type ? { type } : {}) }] }, missingRef: mode };
    for (const form of ['typed', 'bare']) {
      const first = await probe(t, options, 'Observation', [{ name: 'encounter', value: form === 'typed' ? 'Encounter/enc-b' : 'enc-b' }]);
      const second = await probe(t, options, 'Observation', [{ name: 'encounter', value: form === 'typed' ? 'Encounter/enc-zz' : 'enc-zz' }]);
      assert.deepEqual(first.wire, second.wire);
      assert.equal(first.envelope.error?.code, type === 'token' ? 'SEARCH_PARAMETER_UNRESOLVED' : 'POLICY_DENIED');
      assert.equal(first.clinical().length, 0); assert.equal(second.clinical().length, 0);
    }
  }
});

test('S3-G3 relative pinned shared targets admit A rows; every other reference form uniformly denies', async t => {
  const [first] = await twins(t, 'Observation', { name: 'performer', value: 'Practitioner/prac-1' });
  assert.equal(first.envelope.error, undefined); assert.deepEqual(ids(first.envelope), ['obs-a1']);
  for (const value of ['prac-1', 'pat-a', 'CareTeam/ct-b', 'RelatedPerson/rp-b', 'Location/loc-b', 'Practitioner/prac-1/_history/1', 'Practitioner/prac-1?x=1', 'Practitioner/prac-1#x', 'Practitioner/prac-1,Practitioner/prac-2', 'Practitioner/prac\\-1', 'Encounter/enc-a']) {
    const name = value.startsWith('Encounter/') ? 'encounter' : 'performer';
    await twins(t, 'Observation', { name, value }, {}, value.includes('\\') ? 'INVALID_ARGUMENTS' : 'POLICY_DENIED');
  }
  const f = await fixture(t, { declare: declared() });
  for (const value of [new URL('Practitioner/prac-1', f.base).href, 'https://outside.example/Practitioner/prac-1']) {
    const result = await f.gateway.execute('fhir_search', { resource_type: 'Observation', params: [{ name: 'performer', value }], output });
    assert.equal(result.error?.code, 'POLICY_DENIED');
  }
  assert.equal(f.clinical().length, 0);
});

test('S3 typed HbA1c and escape controls preserve ordered once-encoded pairs; invalid syntax never sends', async t => {
  const d = declared();
  const f = await fixture(t, { declare: d, records: dataset('positive').map(r => r.id === 'obs-a1' ? { ...r, code: { coding: [{ system: 'http://loinc.org', code: '4548-4' }] } } : r) });
  const query = [{ name: 'code', value: 'http://loinc.org|4548-4' }, { name: 'date', value: 'ge2020-01-01' }, { name: 'date', value: 'lt2026-01-01' }, { name: '_sort', value: '-date' }];
  const hba = await f.gateway.execute('fhir_search', { resource_type: 'Observation', params: query, output });
  assert.equal(hba.error, undefined); assert.deepEqual(ids(hba), ['obs-a1']);
  const material = query.slice(0, -1);
  const expected = [...material, { name: 'patient', value: 'Patient/pat-a' }, query.at(-1)!, { name: '_count', value: '20' }];
  assert.deepEqual([...new URL(f.clinical()[0]!.slice(4), f.base).searchParams], expected.map(p => [p.name, p.value]));
  assert.deepEqual(hba.coverage.constraints?.map(({ name, value }) => ({ name, value })), expected.filter(p => !['_sort', '_count'].includes(p.name)));
  assert.equal(hba.coverage.sort?.order, 'requested_unverified');
  assert.notEqual(hba.coverage.state, 'complete_for_query');
  for (const value of ['comma\\,literal', 'pipe\\|literal', 'back\\\\slash', '|4548-4', '4548-4', 'http://loinc.org|', '%2C', Array.from({ length: 33 }, () => '4548-4').join(',')]) {
    const pairs = [{ name: 'code', value }, { name: 'code', value }];
    const result = await f.gateway.execute('fhir_search', { resource_type: 'Observation', params: pairs, output });
    assert.equal(result.error, undefined, value);
    const last = new URL(f.clinical().at(-1)!.slice(4), f.base);
    assert.deepEqual(last.searchParams.getAll('code'), [value, value]);
    assert.deepEqual((result.coverage.constraints?.map(({ name, value }) => ({ name, value })) as Pair[]).slice(0, 2), pairs);
    if (value === '%2C') assert.ok(last.search.includes('%252C'));
  }
  for (const [name, value, expectedCode] of [['_sort', ' -date', 'UNSUPPORTED_SORT'], ['_sort', '-date ', 'UNSUPPORTED_SORT'], ['date', 'ge2025-02-30', 'INVALID_ARGUMENTS'], ['date', '2025-13', 'INVALID_ARGUMENTS'], ['date', 'ge2025-01-01T25:00:00Z', 'INVALID_ARGUMENTS'], ['code', 'bad\\q', 'INVALID_ARGUMENTS'], ['code', Array.from({ length: 34 }, () => '4548-4').join(','), 'INVALID_ARGUMENTS']] as const) {
    const before = f.clinical().length;
    const result = await f.gateway.execute('fhir_search', { resource_type: 'Observation', params: [{ name, value }], output });
    assert.equal(result.error?.code, expectedCode, value); assert.equal(f.clinical().length, before);
  }
});

test('S3 retained foreign veto stays active and pinned token types do not become source-typed references', async t => {
  const f = await fixture(t, { declare: declared() });
  const positive = await f.gateway.execute('fhir_search', { resource_type: 'Observation', params: [{ name: 'code', value: '1111-1' }], output });
  assert.equal(positive.error, undefined); assert.deepEqual(ids(positive), ['obs-a1']);
  const before = f.clinical().length;
  // Typed single-pass syntax sees one token; the retained legacy raw-comma veto adds a conservative refusal.
  const result = await f.gateway.execute('fhir_search', { resource_type: 'Observation', params: [{ name: 'code', value: 'literal\\,Patient/pat-b' }], output });
  assert.equal(result.error?.code, 'POLICY_DENIED'); assert.equal(f.clinical().length, before);
  // Baseline lacked typed date validation: this also proves this combined regression test red on S2.
  const invalid = await f.gateway.execute('fhir_search', { resource_type: 'Observation', params: [{ name: 'date', value: '2025-02-30' }], output });
  assert.equal(invalid.error?.code, 'INVALID_ARGUMENTS');
});

test('S3 confinement resolution fails before constructing any clinical URL', async t => {
  for (const declaration of [{ name: 'patient', type: 'token' }, { name: 'patient', definition: 'http://example.test/unknown' }, { name: 'patient', definition: 42 }, undefined]) {
    const f = await fixture(t, { declare: { Observation: declaration ? [declaration] : [] } } as Options);
    const internal = f.gateway as unknown as { transport: { url: (path: string) => URL } };
    const original = internal.transport.url.bind(internal.transport);
    const clinicalUrls: string[] = [];
    internal.transport.url = path => { if (path !== 'metadata') clinicalUrls.push(path); return original(path); };
    const result = await f.gateway.execute('fhir_search', { resource_type: 'Observation', output });
    assert.equal(result.error?.code, declaration ? 'SEARCH_PARAMETER_UNRESOLVED' : 'UNSUPPORTED_CONFINEMENT');
    assert.equal(f.requests.length, 1, 'metadata is allowed and counted separately');
    assert.equal(f.clinical().length, 0); assert.deepEqual(clinicalUrls, []);
  }
});

test('S3 frozen continuation reuses preparation and refuses corrupted original state before clinical fetch', async t => {
  const f = await fixture(t, { declare: declared(), paginate: true });
  const first = await f.gateway.execute('fhir_search', { resource_type: 'Observation', params: [{ name: 'code', value: '1111-1' }], page_size: 1, output });
  assert.equal(first.error, undefined); assert.ok(first.pagination?.next_cursor);
  const internal = f.gateway as unknown as { store: { get(key: string): { value: { query: Pair[] } } } };
  const frozen = internal.store.get(first.pagination.next_cursor).value.query;
  assert.throws(() => { frozen[0] = { name: 'encounter', value: 'Encounter/enc-b' }; }, TypeError);
  // Fault injection replaces immutable backing metadata rather than mutating it.
  const store = (f.gateway as unknown as { store: { get(key: string): { value: object }; update(key: string, value: object): void } }).store;
  store.update(first.pagination.next_cursor, { ...store.get(first.pagination.next_cursor).value, query: [{ name: 'encounter', value: 'Encounter/enc-b' }, ...frozen.slice(1)] });
  const before = f.clinical().length;
  const next = await f.gateway.execute('fhir_page', { cursor: first.pagination.next_cursor, output });
  assert.equal(next.error?.code, 'POLICY_DENIED'); assert.equal(f.clinical().length, before);
});

for (const resourceType of ['CapabilityStatement', 'SearchParameter', 'StructureDefinition', 'OperationDefinition']) test(`S3-G5 ${resourceType} read and search refuse before even metadata`, async t => {
  for (const tool of ['fhir_read', 'fhir_search'] as const) {
    const first = await probe(t, { declare: { [resourceType]: params(['url']) }, readable: [resourceType] }, resourceType, [], tool);
    assert.equal(first.envelope.error?.code, 'UNSUPPORTED_RESOURCE'); assert.deepEqual(first.envelope.data, {});
    assert.equal(first.requests.length, 0);
    const listing = await first.gateway.execute('fhir_capabilities', { topic: 'resource', resource_type: resourceType, output });
    assert.equal(listing.error, undefined);
    assert.deepEqual((listing.data as { implemented_interactions: string[] }).implemented_interactions, []);
    const schema = await first.gateway.execute('fhir_capabilities', { topic: 'schema', resource_type: resourceType, limit: 1, output });
    assert.equal(schema.error, undefined, 'local pinned schema discovery stays available');
  }
});

test('S3-G5 capability token canaries are withheld; pinned names and R4 interactions remain visible', async t => {
  const canary = 'BCanary7731G5RoeJaneMrn';
  const f = await fixture(t, { declare: declared(), metadata: value => {
    const resources = value.rest[0].resource as R[];
    resources.push({ type: 'BCanary7731G5Type', interaction: [{ code: 'read' }] });
    const obs = resources.find(r => r.type === 'Observation')!;
    obs.interaction.push({ code: 'BCanary7731G5Interaction' });
    obs.searchParam.push({ name: canary }, { name: 'B-CANARY-7731 G5 Roe Jane MRN' });
    return value;
  } });
  for (const topic of ['server', 'resource']) {
    const env = await f.gateway.execute('fhir_capabilities', { topic, ...(topic === 'resource' ? { resource_type: 'Observation' } : {}), output });
    assert.equal(env.error, undefined);
    const wire = JSON.stringify(f.gateway.toToolResult(env));
    assert.equal(wire.includes('BCanary'), false); assert.equal(wire.includes('B-CANARY'), false);
    if (topic === 'resource') {
      const data = env.data as { searchParameters: string[]; withheld_search_parameter_count: number; interactions: string[] };
      assert.ok(data.searchParameters.includes('patient')); assert.ok(data.searchParameters.includes('code'));
      assert.deepEqual(data.interactions, ['search-type']); assert.equal(data.withheld_search_parameter_count, undefined); assert.equal((f.gateway as any).capabilities.get('Observation').withheldNameCount, 1);
    }
  }
});

test('S3-G5 eval boundary remains measured above the floor in both eras with zero custom-name echo', async t => {
  const { runEvals } = await import('../packages/evals/src/runner.js');
  const { TASKS } = await import('../packages/evals/src/tasks.js');
  const task = TASKS.find(task => task.id === 'byte-ceiling-wire-boundary')!;
  const results: unknown[] = [];
  const original = FhirGateway.prototype.toToolResult;
  t.mock.method(FhirGateway.prototype, 'toToolResult', function (this: FhirGateway, ...args: Parameters<typeof original>) {
    const result = original.apply(this, args);
    results.push(result);
    return result;
  });
  for (const era of ['modern', 'legacy'] as const) {
    const report = await runEvals({ tasks: [task], era });
    assert.ok(report.results.every(result => result.status === 'pass'));
    assert.equal(report.summary.byte_accounting.under_reported_calls, 0);
    assert.equal(report.summary.byte_accounting.over_reported_calls, 0);
    for (const result of report.results) {
      const boundary = result.calls[1]!;
      assert.ok(boundary.requested_max_bytes! >= 4096, 'dynamic ceiling respects schema floor');
      assert.ok(boundary.requested_max_bytes! - boundary.wire_result_bytes >= 0);
      assert.ok(boundary.requested_max_bytes === 4096 || boundary.requested_max_bytes! - boundary.wire_result_bytes <= 32, 'above-floor dynamic requests remain within 32 bytes; minimum-clamped requests fit their independent ceiling');
    }
  }
  assert.ok(results.length >= 12);
  for (const result of results) assert.equal(JSON.stringify(result).includes('synthetic-wide-param-59'), false, 'both structuredContent and mirrored text are scanned');
});
