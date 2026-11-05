import assert from 'node:assert/strict';
import { channel } from 'node:diagnostics_channel';
import { EventEmitter } from 'node:events';
import { createServer, get } from 'node:http';
import test, { type TestContext } from 'node:test';
import { gzipSync } from 'node:zlib';
import { FhirGateway } from '../packages/core/src/index.js';
import { startQueryCapture, verifyDuplicateQueries } from '../scripts/query-evidence-capture.js';

type Trace = ReturnType<typeof startQueryCapture>;
type FixtureOptions = {
  collapsePatient?: boolean;
  collapseId?: boolean;
  gzip?: boolean;
  trailingNext?: boolean;
  ignoreCount?: boolean;
  sequence?: 'reordered' | 'missing' | 'extra';
};

async function fixture(t: TestContext, options: FixtureOptions = {}) {
  const patient = 'synthetic-trace-patient';
  const expected = ['synthetic-trace-1', 'synthetic-trace-2', 'synthetic-trace-3'];
  const reference = `Patient/${patient}`;
  const requests: URL[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://127.0.0.1');
    requests.push(url);
    let value: unknown;
    if (url.pathname === '/fhir/metadata') {
      value = { resourceType: 'CapabilityStatement', fhirVersion: '4.0.1', rest: [{ mode: 'server', resource: [
        { type: 'Patient', interaction: [{ code: 'search-type' }], searchParam: [{ name: '_id', type: 'token' }] },
        { type: 'Observation', interaction: [{ code: 'search-type' }], searchParam: [
          { name: 'patient', type: 'reference' }, { name: 'subject', type: 'reference' },
          { name: 'code', type: 'token' }, { name: 'date', type: 'date' },
        ] },
      ] }] };
    } else {
      const self = new URL(req.url!, `http://${req.headers.host}`);
      if (options.collapsePatient || options.collapseId) {
        const seen = new Set<string>();
        const pairs = [...self.searchParams].filter(([name, value]) => {
          const collapse = name === '_id' ? options.collapseId : !name.startsWith('_') && options.collapsePatient;
          if (!collapse) return true;
          const key = JSON.stringify([name, value]);
          if (seen.has(key)) return false;
          seen.add(key); return true;
        });
        self.search = new URLSearchParams(pairs).toString();
      }
      const observationIds = options.sequence === 'reordered' ? [expected[0]!, expected[2]!, expected[1]!]
        : options.sequence === 'missing' ? expected.slice(0, 2)
        : options.sequence === 'extra' ? [...expected, 'synthetic-trace-extra'] : expected;
      const resources = url.pathname === '/fhir/Patient'
        ? [{ resourceType: 'Patient', id: patient }]
        : observationIds.map((id, index) => ({ resourceType: 'Observation', id, status: 'final',
          subject: { reference }, code: { coding: [{ system: 'http://loinc.org', code: '4548-4' }] },
          effectiveDateTime: `2026-01-0${index + 1}T00:00:00Z` }));
      const offset = Number(url.searchParams.get('_offset') ?? 0);
      const pageSize = options.ignoreCount ? resources.length : Number(url.searchParams.get('_count') ?? 1);
      const links = [{ relation: 'self', url: self.href }];
      const page = resources.slice(offset, offset + pageSize);
      if (options.trailingNext ? page.length === pageSize : offset + pageSize < resources.length) {
        const next = new URL(self); next.searchParams.set('_offset', String(offset + pageSize));
        links.push({ relation: 'next', url: next.href });
      }
      value = { resourceType: 'Bundle', type: 'searchset', link: links,
        entry: page.map(resource => ({ resource })) };
    }
    const body = Buffer.from(JSON.stringify(value));
    res.writeHead(200, { 'content-type': 'application/fhir+json', ...(options.gzip ? { 'content-encoding': 'gzip' } : {}) });
    res.end(options.gzip ? gzipSync(body) : body);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const base = new URL(`http://127.0.0.1:${address.port}/fhir/`);
  const trace = startQueryCapture(base);
  const gateway = new FhirGateway({ mode: 'synthetic', source: { alias: 'trace', baseUrl: base.href }, patientId: patient });
  t.after(async () => { trace.stop(); gateway.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { patient, expected, requests, trace, gateway };
}

for (const collapse of [false, true]) {
  test(`live query recorder verifies actual multipage wire/self/record evidence (${collapse ? 'collapsed gzip' : 'preserved plain'})`, async t => {
    const { patient, expected, requests, trace, gateway } = await fixture(t, {
      collapsePatient: collapse, collapseId: collapse, gzip: collapse,
    });
    const evidence = await verifyDuplicateQueries(gateway, trace, patient, expected, collapse);
    assert.equal(evidence.duplicate_initial_wire_verified, true);
    assert.equal(evidence.duplicate_source_self_verified, true);
    assert.equal(evidence.duplicate_upstream_pages, 3);
    assert.equal(evidence.self_link_duplicates_collapsed, collapse);
    assert.equal(trace.counts.metadata, 1);
    assert.equal(trace.counts.auth, 0);
    assert.equal(requests.length, 5, 'metadata, three Observation pages and one Patient page');
    assert.ok(requests.every(url => url.pathname.startsWith('/fhir/')), 'all observed requests stay in the fixed fixture base');
  });
}

const labels = {
  patientMultiplicity: 'observed source confinement multiplicity matches the reviewed backend cell',
  idMultiplicity: 'observed source id multiplicity matches the reviewed backend cell',
  deliveredSequence: 'duplicate query returns the independently seeded ordered record sequence',
  sourceSequence: 'actual source page sequence independently matches the seeded oracle',
  pages: 'duplicate query really crosses multiple upstream pages',
  wire: 'actual initial HTTP request retains every caller pair and the trusted append',
  patientWire: 'actual Patient HTTP request contains the trusted append',
  self: 'source preserves every distinct exact predicate',
  continuation: 'ordinary next request retains every distinct frozen predicate',
};

// Match the fixed label exactly; assert.equal may append its numeric comparison.
// A different, earlier failure cannot satisfy a control.
async function rejectsWithLabel(run: () => Promise<unknown>, label: string) {
  await assert.rejects(run, error => {
    assert.ok(error instanceof assert.AssertionError);
    assert.equal(error.message.split('\n')[0], label);
    return true;
  });
}

for (const [name, options, expectCollapse, label] of [
  ['collapsed source when repetition expected', { collapsePatient: true, collapseId: true }, false, labels.patientMultiplicity],
  ['repeated source when collapse expected', {}, true, labels.patientMultiplicity],
  ['collapsed patient with repeated _id', { collapsePatient: true }, true, labels.idMultiplicity],
  ['repeated patient with collapsed _id', { collapseId: true }, false, labels.idMultiplicity],
  ['ignored _count yields too few upstream pages', { ignoreCount: true }, false, labels.pages],
] as const) {
  test(`live verification rejects ${name}`, async t => {
    const { patient, expected, trace, gateway } = await fixture(t, options);
    await rejectsWithLabel(() => verifyDuplicateQueries(gateway, trace, patient, expected, expectCollapse), label);
  });
}

for (const sequence of ['reordered', 'missing', 'extra'] as const) {
  test(`live verification rejects ${sequence} delivered records`, async t => {
    const { patient, expected, trace, gateway } = await fixture(t, { sequence });
    await rejectsWithLabel(() => verifyDuplicateQueries(gateway, trace, patient, expected, false), labels.deliveredSequence);
  });
}

// Deliberately corrupt only the synthetic recording after native HTTP has settled.
// Gateway delivery remains valid, so each independent recorder assertion is reached.
function alterRecording(trace: Trace, patient: boolean, alter: (rows: Trace['rows']) => void) {
  const flush = trace.flush;
  let altered = false;
  trace.flush = async () => {
    await flush();
    const rows = trace.rows.filter(row => row.outbound.some(pair => pair.name === '_id') === patient);
    if (!altered && rows.length > 0) {
      alter(rows);
      altered = true;
    }
  };
}

const recordingCases: {
  name: string;
  patient?: boolean;
  label: string;
  alter: (rows: Trace['rows'], trace: Trace) => void;
}[] = [
  { name: 'missing trusted patient append on wire', label: labels.wire, alter: rows => {
    rows[0]!.outbound.splice(rows[0]!.outbound.findLastIndex(pair => pair.name === 'patient'), 1);
  } },
  { name: 'missing trusted _id append on wire', patient: true, label: labels.patientWire, alter: rows => {
    rows[0]!.outbound.splice(rows[0]!.outbound.findLastIndex(pair => pair.name === '_id'), 1);
  } },
  { name: 'altered outbound _count', label: labels.wire, alter: rows => {
    rows[0]!.outbound.find(pair => pair.name === '_count')!.value = '2';
  } },
  { name: 'self missing a distinct requested predicate', label: labels.self, alter: rows => {
    rows[0]!.self = rows[0]!.self!.filter(pair => pair.value !== 'lt2026-02-01');
  } },
  { name: 'self with an extra distinct value', label: labels.self, alter: rows => {
    rows[0]!.self!.push({ name: 'date', value: 'ge2025-01-01' });
  } },
  { name: 'continuation missing a distinct frozen predicate', label: labels.continuation, alter: rows => {
    rows[1]!.outbound = rows[1]!.outbound.filter(pair => pair.value !== 'lt2026-02-01');
  } },
  { name: 'reordered source records', label: labels.sourceSequence, alter: rows => {
    [rows[0]!.sourceIds, rows[1]!.sourceIds] = [rows[1]!.sourceIds, rows[0]!.sourceIds];
  } },
  { name: 'missing source record', label: labels.sourceSequence, alter: rows => {
    rows[1]!.sourceIds = [];
  } },
  { name: 'extra source record', label: labels.sourceSequence, alter: rows => {
    rows[1]!.sourceIds.push('synthetic-trace-extra');
  } },
  { name: 'fewer than three recorded upstream pages', label: labels.pages, alter: (rows, trace) => {
    // Preserve the full source sequence while coalescing the synthetic trace.
    rows[0]!.sourceIds.push(...rows[1]!.sourceIds, ...rows[2]!.sourceIds);
    trace.rows.splice(1, 2);
  } },
];
for (const cell of recordingCases) {
  test(`live verification rejects ${cell.name}`, async t => {
    const { patient, expected, trace, gateway } = await fixture(t);
    alterRecording(trace, cell.patient ?? false, rows => {
      cell.alter(rows, trace);
    });
    await rejectsWithLabel(() => verifyDuplicateQueries(gateway, trace, patient, expected, false), cell.label);
  });
}

test('Patient control tolerates a source next link whenever a page is full', async t => {
  const { patient, expected, requests, trace, gateway } = await fixture(t, { trailingNext: true });
  const evidence = await verifyDuplicateQueries(gateway, trace, patient, expected, false);
  assert.equal(evidence.duplicate_upstream_pages, 4, 'Observation chain drains its trailing empty page');
  const patientRequests = requests.filter(url => url.pathname === '/fhir/Patient');
  assert.equal(patientRequests.length, 1);
  assert.equal(patientRequests[0]!.searchParams.get('_count'), '2');
  assert.equal(evidence.duplicate_self_id_occurrences, 2);
});

test('live recorder resolves a request closed before a response and refuses incomplete evidence', async () => {
  const base = new URL('http://127.0.0.1:1/fhir/');
  const trace = startQueryCapture(base);
  try {
    const request = Object.assign(new EventEmitter(), { method: 'GET', path: '/fhir/Observation', getHeader: () => base.host });
    channel('http.client.request.start').publish({ request });
    assert.equal(trace.rows.length, 1);
    request.emit('close');
    await assert.rejects(trace.flush(), /every observed search response is a valid bounded Bundle/);
  } finally { trace.stop(); }
});

test('live recorder bounds flush even if a captured completion never settles', async t => {
  const trace = startQueryCapture(new URL('http://127.0.0.1:1/fhir/'));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    trace.rows.push({ outbound: [], self: null, sourceIds: [], opaque: false, valid: true, done: new Promise<void>(() => {}) });
    const rejected = assert.rejects(trace.flush(), /bounded query recording timed out/);
    t.mock.timers.tick(30_000);
    await rejected;
  } finally { trace.stop(); }
});

test('live recorder refuses a compressed response exceeding its decoded bound', async t => {
  const wire = gzipSync(Buffer.from(' '.repeat(5 * 1024 * 1024 + 1)));
  const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/fhir+json', 'content-encoding': 'gzip' }); res.end(wire); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = new URL(`http://127.0.0.1:${(server.address() as { port: number }).port}/fhir/`);
  const trace = startQueryCapture(base);
  t.after(async () => { trace.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  await new Promise<void>((resolve, reject) => {
    get(new URL('Observation', base), response => { response.on('error', reject); response.resume(); response.on('end', resolve); }).on('error', reject);
  });
  await assert.rejects(trace.flush(), /bounded query recording succeeded/);
});
