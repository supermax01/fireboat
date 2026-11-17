// Root-owned live-backend verification only. No requests are issued here.
import assert from 'node:assert/strict';
import { channel } from 'node:diagnostics_channel';
import type { ClientRequest } from 'node:http';
import { isDeepStrictEqual } from 'node:util';
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib';
import type { FhirGateway } from '../packages/core/src/index.js';

type EvidencePair = { name: string; value: string };
interface CapturedQuery {
  outbound: EvidencePair[];
  self: EvidencePair[] | null;
  sourceIds: string[];
  opaque: boolean;
  valid: boolean;
  done: Promise<void>;
}

export function startQueryCapture(sourceBase: URL, tokenEndpoint?: URL) {
  const rows: CapturedQuery[] = [];
  const counts = { metadata: 0, auth: 0, clinical: 0 };
  const topic = channel('http.client.request.start');
  let invalid = false;
  const pairs = (url: URL): EvidencePair[] =>
    [...url.searchParams].map(([name, value]) => ({ name, value }));

  const observer = (message: unknown) => {
    try {
      const request = (message as { request?: ClientRequest }).request;
      if (!request) return;
      const host = request.getHeader('host');

      if (
        tokenEndpoint && request.method === 'POST' &&
        host === tokenEndpoint.host &&
        request.path === tokenEndpoint.pathname + tokenEndpoint.search
      ) {
        counts.auth++;
        return;
      }
      if (request.method !== 'GET' || host !== sourceBase.host) return;

      const url = new URL(request.path, sourceBase);
      if (url.pathname === new URL('metadata', sourceBase).pathname) {
        counts.metadata++;
        return;
      }
      counts.clinical++;

      const root = sourceBase.pathname.replace(/\/$/, '');
      const opaque =
        (url.pathname === root || url.pathname === root + '/') &&
        url.searchParams.has('_getpages');
      if (
        !opaque &&
        !['Observation', 'Patient'].some(
          type => url.pathname === new URL(type, sourceBase).pathname
        )
      ) return;

      const row: CapturedQuery = {
        outbound: pairs(url), self: null, sourceIds: [],
        opaque, valid: false, done: Promise.resolve(),
      };

      row.done = new Promise<void>(resolve => {
        let chunks: Buffer[] = [];
        let bytes = 0;
        let responded = false;
        const limit = 5 * 1024 * 1024;
        const finish = () => { chunks = []; resolve(); };

        request.once('error', finish);
        request.once('close', () => { if (!responded) finish(); });
        request.once('response', response => {
          responded = true;
          response.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes <= limit) chunks.push(Buffer.from(chunk));
            else chunks = [];
          });
          response.once('error', finish);
          response.once('aborted', finish);
          response.once('close', finish);
          response.once('end', () => {
            try {
              if (bytes > limit || response.statusCode !== 200) return;
              let body: Buffer = Buffer.concat(chunks);
              const encoding = response.headers['content-encoding'] ?? '';
              if (typeof encoding !== 'string') return;

              const decoders: Record<
                string,
                (value: Uint8Array, options: { maxOutputLength: number }) => Buffer
              > = {
                gzip: gunzipSync, 'x-gzip': gunzipSync,
                deflate: inflateSync, br: brotliDecompressSync,
              };
              for (const coding of encoding.split(',')
                .map(value => value.trim().toLowerCase())
                .filter(value => value && value !== 'identity').reverse()) {
                const decode = decoders[coding];
                if (!decode) return;
                body = decode(body, { maxOutputLength: limit });
              }

              const bundle = JSON.parse(body.toString('utf8')) as {
                resourceType?: string;
                type?: string;
                link?: { relation?: string; url?: string }[];
                entry?: {
                  resource?: { resourceType?: string; id?: string };
                  search?: { mode?: string };
                }[];
              };
              if (
                bundle.resourceType !== 'Bundle' ||
                bundle.type !== 'searchset'
              ) return;

              const self = Array.isArray(bundle.link)
                ? bundle.link.find(link => link.relation === 'self')?.url
                : undefined;
              if (typeof self === 'string') {
                row.self = pairs(new URL(self, sourceBase));
              }
              row.sourceIds = (
                Array.isArray(bundle.entry) ? bundle.entry : []
              ).flatMap(entry =>
                entry.search?.mode !== 'include' &&
                ['Observation', 'Patient'].includes(
                  entry.resource?.resourceType ?? ''
                ) &&
                typeof entry.resource?.id === 'string'
                  ? [entry.resource.id] : []
              );
              row.valid = true;
            } catch {
              invalid = true;
            } finally {
              finish();
            }
          });
        });
      });
      rows.push(row);
    } catch {
      invalid = true;
    }
  };

  topic.subscribe(observer);
  return {
    rows, counts,
    flush: async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all(rows.map(row => row.done)),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('bounded query recording timed out')), 30_000);
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      assert.equal(invalid, false, 'bounded query recording succeeded');
      assert.ok(
        rows.every(row => row.valid),
        'every observed search response is a valid bounded Bundle'
      );
    },
    stop: () => { topic.unsubscribe(observer); },
  };
}

export async function verifyDuplicateQueries(
  gateway: FhirGateway,
  trace: ReturnType<typeof startQueryCapture>,
  patient: string,
  expectedIds: string[],
  expectCollapse: boolean
) {
  const reference = 'Patient/' + patient;
  const caller: EvidencePair[] = [
    { name: 'subject', value: reference },
    { name: 'patient', value: reference },
    { name: 'code', value: 'http://loinc.org|4548-4' },
    { name: 'date', value: 'ge2026-01-01' },
    { name: 'date', value: 'lt2026-02-01' },
    { name: 'code', value: 'http://loinc.org|4548-4' },
    { name: '_sort', value: 'date' },
  ];
  const frozen = [
    ...caller.filter(pair => pair.name !== '_sort' && pair.name !== '_count'),
    { name: 'patient', value: reference },
    { name: '_sort', value: caller.filter(pair => pair.name === '_sort').map(pair => pair.value).join(',') },
    { name: '_count', value: '1' },
  ];
  const equal = (actual: unknown, expected: unknown, label: string) =>
    assert.ok(isDeepStrictEqual(actual, expected), label);
  const predicateKeys = (pairs: EvidencePair[]) =>
    [...new Set(pairs.filter(pair =>
      !pair.name.startsWith('_') ||
      pair.name === '_id' || pair.name === '_lastUpdated'
    ).map(pair => JSON.stringify([pair.name, pair.value])))].sort();

  const begin = trace.rows.length;
  let result = await gateway.execute('fhir_search', {
    resource_type: 'Observation', params: caller, page_size: 1,
    output: { format: 'fhir' },
  });
  const initialConstraints = result.coverage.constraints;
  const digest = result.coverage.query_digest;
  const context = result.context.handle;
  const delivered: string[] = [];
  let pages = 0;

  while (true) {
    assert.equal(
      result.error?.code, undefined, 'duplicate Observation query succeeds'
    );
    equal(
      (result.coverage.constraints ?? initialConstraints)?.map(({ name, value }) => ({ name, value })), frozen.filter(p => !['_sort', '_count'].includes(p.name)),
      'every page preserves full ordered requested evidence'
    );
    assert.ok(
      result.context.handle === context && result.coverage.query_digest === digest, 'query binding remains unchanged'
    );
    assert.ok(
      result.coverage.state !== 'complete_for_query',
      'generic duplicate query gains no execution proof'
    );
    assert.equal(
      result.coverage.sort?.order, 'requested_unverified'
    );
    assert.ok(
      ((result.coverage.constraints?.filter(c => c.execution !== "unknown").map(({ name, value }) => ({ name, value })) ?? []) as EvidencePair[])
        .every(pair =>
          (['patient', 'subject'].includes(pair.name) && pair.value === reference) || (pair.name === '_id' && caller.some(p => p.name === '_id' && p.value === pair.value))
        ),
      'only independently enforced confinement is labelled executed'
    );

    const resources = result.data.resources as {
      resourceType: string;
      id: string;
      subject?: { reference?: string };
    }[];
    assert.ok(
      resources.every(resource =>
        resource.resourceType === 'Observation' &&
        resource.subject?.reference === reference
      ),
      'every delivered record is independently bound'
    );
    delivered.push(...resources.map(resource => resource.id));
    pages++;
    if (!result.pagination?.next_cursor) break;
    assert.ok(pages < 20, 'duplicate query continuation terminates');

    result = await gateway.execute('fhir_page', {
      cursor: result.pagination.next_cursor,
      output: { format: 'fhir' },
    });
    assert.equal(
      result.coverage.query_evidence, result.coverage.pages_observed > 1 ? 'unverified_continuation' : 'declared_and_self_link_only'
    );
  }

  equal(
    delivered, expectedIds,
    'duplicate query returns the independently seeded ordered record sequence'
  );
  await trace.flush();
  const chain = trace.rows.slice(begin);
  assert.ok(
    chain.length >= 3,
    'duplicate query really crosses multiple upstream pages'
  );
  equal(
    chain[0]!.outbound, frozen,
    'actual initial HTTP request retains every caller pair and the trusted append'
  );
  assert.ok(
    chain[0]!.self, 'actual initial source self evidence is captured'
  );
  equal(
    predicateKeys(chain[0]!.self!), predicateKeys(frozen),
    'source preserves every distinct exact predicate'
  );
  const selfPatientCount = chain[0]!.self!.filter(pair =>
    pair.name === 'patient' && pair.value === reference
  ).length;
  assert.equal(
    selfPatientCount, expectCollapse ? 1 : 2,
    'observed source confinement multiplicity matches the reviewed backend cell'
  );
  for (const row of chain.slice(1)) {
    if (!row.opaque) {
      equal(
        predicateKeys(row.outbound), predicateKeys(frozen),
        'ordinary next request retains every distinct frozen predicate'
      );
    }
  }
  equal(
    chain.flatMap(row => row.sourceIds), expectedIds,
    'actual source page sequence independently matches the seeded oracle'
  );

  const patientBegin = trace.rows.length;
  const idResult = await gateway.execute('fhir_search', {
    resource_type: 'Patient',
    params: [{ name: '_id', value: patient }],
    page_size: 2, output: { format: 'fhir' },
  });
  assert.equal(
    idResult.error?.code, undefined, 'duplicate Patient query succeeds'
  );
  const idFrozen = [
    { name: '_id', value: patient },
    { name: '_id', value: patient },
    { name: '_count', value: '2' },
  ];
  equal(
    idResult.coverage.constraints?.map(({ name, value }) => ({ name, value })), idFrozen.filter(p => p.name !== '_count'),
    'Patient requested evidence retains both occurrences'
  );
  equal(
    (idResult.data.resources as { id: string }[])
      .map(resource => resource.id),
    [patient],
    'only the independently seeded authorized Patient is delivered'
  );
  assert.equal(
    idResult.pagination?.has_more, false,
    'the single logical Patient is exhausted'
  );

  await trace.flush();
  const patientRows = trace.rows.slice(patientBegin);
  assert.equal(patientRows.length, 1, 'one actual upstream Patient page');
  equal(
    patientRows[0]!.outbound, idFrozen,
    'actual Patient HTTP request contains the trusted append'
  );
  assert.ok(
    patientRows[0]!.self, 'actual Patient source self evidence is captured'
  );
  equal(
    predicateKeys(patientRows[0]!.self!), predicateKeys(idFrozen),
    'Patient source preserves exact confinement'
  );
  const selfIdCount = patientRows[0]!.self!.filter(pair =>
    pair.name === '_id' && pair.value === patient
  ).length;
  assert.equal(
    selfIdCount, expectCollapse ? 1 : 2,
    'observed source id multiplicity matches the reviewed backend cell'
  );
  equal(
    patientRows[0]!.sourceIds, [patient],
    'actual source Patient evidence matches the independent oracle'
  );

  return {
    duplicate_initial_wire_verified: true,
    duplicate_source_self_verified: true,
    self_link_duplicates_collapsed:
      selfPatientCount === 1 && selfIdCount === 1,
    duplicate_query_pages: pages,
    duplicate_upstream_pages: chain.length,
    duplicate_authorized_observations: delivered.length,
    duplicate_patient_checked: true,
    duplicate_self_patient_occurrences: selfPatientCount,
    duplicate_self_id_occurrences: selfIdCount,
  };
}
