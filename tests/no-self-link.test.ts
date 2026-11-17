// Pages without a self link. Part 1 gateway-checked filters, Part 2 record-checked
// first pages (operator opt-in `source.selfLinkOptional`), Part 3 the operator-declared continuation token
// (`source.continuationTokenParameter`). Synthetic records only, against a source that sends no self links and pages
// with `page=` tokens. The test titles are the killing tests named by the mutation registry.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { FhirGateway, type GatewayEnvelope } from '../packages/core/src/index.js';
import { noMatchesEligible, validateCrossField02, type GatewayEnvelope02, type ValidationContext02 } from '../packages/core/src/contracts.js';
import { buildQueryEvidence, carriesContinuationToken, coverageForSnapshot, declaredSearchProfile, downgradeEvidence, validateTokenContinuation, type SearchProfile } from '../packages/core/src/query.js';
import { checkablePredicate, checkReturnedRecords, dateCanMatch, isKnownParameterName, recordMatches, ZONELESS_SLACK_MS } from '../packages/core/src/record-predicates.js';
import { R4_CHECKABLE_PARAMETERS, R4_CHECKABLE_SOURCE } from '../packages/core/src/generated/r4-checkable-paths.js';
import { GatewayFault } from '../packages/core/src/transport.js';
import { renderCheckableModule } from '../scripts/generate-r4-checkable-paths.js';
import { A, B, LOINC, comparable, encounter, executions, gatewayFor, ids, obs, output, patientRecord, startSource, warnings, type R } from './no-self-link-helpers.js';

const BASE = new URL('http://127.0.0.1:1/fhir/');
const pred = (type: string, name: string, value: string) => checkablePredicate(type, { name, value }, R4_CHECKABLE_PARAMETERS.get(type)?.get(name)?.url);
const match = (type: string, name: string, value: string, record: R) => {
  const predicate = pred(type, name, value);
  assert.ok(predicate, `${type} ${name}=${value} is checkable`);
  return recordMatches(predicate, { resourceType: type, ...record }, BASE);
};
const CODE = { name: 'code', value: `${LOINC}|4548-4` };
const DATE = { name: 'date', value: 'ge2020-01-01' };
const SORT = { name: '_sort', value: '-date' };

// ---------------------------------------------------------------------------------------------------------------
// Part 1: classification and record-level semantics.
// ---------------------------------------------------------------------------------------------------------------

test('no-self checker: the generated checkable paths match their generator and the pinned R4 indexes', () => {
  assert.equal(readFileSync(new URL('../packages/core/src/generated/r4-checkable-paths.ts', import.meta.url), 'utf8'), renderCheckableModule());
  assert.equal(R4_CHECKABLE_SOURCE.generator_revision, 'generate-r4-checkable-paths/1');
  assert.ok(R4_CHECKABLE_SOURCE.parameters > 1000);
  assert.deepEqual(R4_CHECKABLE_PARAMETERS.get('Observation')?.get('date')?.paths, [{ steps: [], leaf: 'effective', choice: true, types: ['dateTime', 'Period', 'instant'], other: ['Timing'] }]);
  assert.deepEqual(R4_CHECKABLE_PARAMETERS.get('Observation')?.get('code')?.paths, [{ steps: [], leaf: 'code', choice: false, types: ['CodeableConcept'], other: [] }]);
  // Not simple paths, or not the covered types: never classified.
  for (const [type, name] of [['Observation', 'patient'], ['Observation', 'value-quantity'], ['Observation', 'value-string'], ['Patient', 'name'], ['Patient', 'phone'],
    ['Observation', 'code-value-concept'], ['Observation', '_lastUpdated'], ['Patient', 'active']] as const) assert.equal(R4_CHECKABLE_PARAMETERS.get(type)?.get(name), undefined, `${type} ${name}`);
});

test('no-self checker: only the covered token, date, reference and _id forms are checkable', () => {
  const checkable: [string, string, string][] = [
    ['Observation', 'code', `${LOINC}|4548-4`], ['Observation', 'code', '4548-4'], ['Observation', 'code', `${LOINC}|4548-4,${LOINC}|17856-6`],
    ['Observation', 'identifier', 'urn:example|acc-1'], ['Observation', 'status', 'final'], ['Observation', 'category', 'laboratory'],
    ['Observation', 'date', '2025-06-15'], ['Observation', 'date', 'eq2025'], ['Observation', 'date', 'ge2020-01-01'], ['Observation', 'date', 'le2020-01-01'],
    ['Observation', 'date', 'gt2020-01-01T10:00:00Z'], ['Observation', 'date', 'lt2020-01-01'], ['Observation', 'date', 'ge2020,lt2019'],
    ['Observation', 'encounter', 'Encounter/e-1'], ['Observation', 'encounter', 'e-1'], ['Observation', '_id', 'a,b'], ['Patient', 'birthdate', '1980'],
  ];
  for (const [type, name, value] of checkable) assert.ok(pred(type, name, value), `${type} ${name}=${value}`);
  const uncheckable: [string, string, string][] = [
    ['Observation', 'code', `|4548-4`], ['Observation', 'code', `${LOINC}|`], ['Observation', 'code', `${LOINC}|4548-4,|x`], ['Observation', 'code:text', 'x'],
    ['Observation', 'code:in', 'http://vs'], ['Observation', 'date', 'ne2020'], ['Observation', 'date', 'ap2020'], ['Observation', 'date', 'sa2020'], ['Observation', 'date', 'eb2020'],
    ['Observation', 'date', '2025-06-15T08:00:00.1234Z'], ['Observation', 'encounter', 'http://127.0.0.1:1/fhir/Encounter/e-1'], ['Observation', 'encounter', 'Encounter/e-1/_history/2'],
    ['Observation', 'encounter', 'Encounter?identifier=x'], ['Observation', 'encounter', '#c'], ['Observation', '_id', 'a|b'], ['Observation', 'value-quantity', 'gt5'],
    ['Observation', 'value-string', 'x'], ['Observation', '_lastUpdated', 'ge2020'], ['Observation', 'patient', 'Patient/x'], ['Patient', 'name', 'x'],
  ];
  for (const [type, name, value] of uncheckable) assert.equal(pred(type, name, value), undefined, `${type} ${name}=${value}`);
  // A resolved definition other than the classified one is never checked.
  assert.equal(checkablePredicate('Observation', CODE, 'http://hl7.org/fhir/SearchParameter/other'), undefined);
  assert.equal(checkablePredicate('Observation', CODE, undefined), undefined);
});

test('no-self checker: token system and code rules', () => {
  const coding = (system: string | undefined, code: string) => ({ code: { coding: [{ ...(system ? { system } : {}), code }] } });
  assert.equal(match('Observation', 'code', `${LOINC}|4548-4`, coding(LOINC, '4548-4')), true);
  assert.equal(match('Observation', 'code', `${LOINC}|4548-4`, coding('http://other.example', '4548-4')), false, 'same code, other system: contradiction');
  assert.equal(match('Observation', 'code', `${LOINC}|4548-4`, coding(undefined, '4548-4')), false, 'a coding without a system never matches system|code');
  assert.equal(match('Observation', 'code', `${LOINC}|4548-4`, coding(LOINC, '17856-6')), false, 'other code: contradiction');
  assert.equal(match('Observation', 'code', '4548-4', coding('http://other.example', '4548-4')), true, 'a bare code matches any system');
  assert.equal(match('Observation', 'code', 'ABC', coding(LOINC, 'abc')), true, 'a case-insensitive code system is never refused');
  assert.equal(match('Observation', 'code', `${LOINC}|x,${LOINC}|4548-4`, coding(LOINC, '4548-4')), true, 'any OR alternative');
  assert.equal(match('Observation', 'code', `${LOINC}|4548-4`, { code: { text: 'A1c' } }), false, 'text never matches a token');
  assert.equal(match('Observation', 'code', `${LOINC}|4548-4`, { code: { coding: [{ system: LOINC, code: 7 }] } }), undefined, 'a malformed coding cannot be judged');
  assert.equal(match('Observation', 'identifier', 'urn:example|acc-1', { identifier: [{ system: 'urn:example', value: 'acc-1' }] }), true);
  assert.equal(match('Observation', 'identifier', 'urn:example|acc-1', { identifier: [{ system: 'urn:other', value: 'acc-1' }] }), false);
  assert.equal(match('Observation', 'identifier', 'acc-2', { identifier: [{ system: 'urn:example', value: 'acc-1' }] }), false);
  // A `code` element's system comes from its binding: only the code can contradict.
  assert.equal(match('Observation', 'status', 'http://hl7.org/fhir/observation-status|final', { status: 'final' }), true);
  assert.equal(match('Observation', 'status', 'final', { status: 'amended' }), false);
  assert.equal(match('Observation', 'status', 'final', { _status: { extension: [] } }), undefined, 'an extension-only primitive cannot be judged');
  assert.equal(match('Observation', 'category', 'laboratory', {}), false, 'a missing element never matches');
});

test('no-self checker: date boundary cases for imprecise and zoneless values', () => {
  const at = (effectiveDateTime: string) => ({ effectiveDateTime });
  // Lower precision: a year could be any instant in it.
  assert.equal(match('Observation', 'date', 'eq2025-06-15', at('2025')), true);
  assert.equal(match('Observation', 'date', 'eq2025-06', at('2025-06-15T08:00:00Z')), true);
  // Zoneless values are read with up to 14 hours of slack either way, so a correct server is never refused at a boundary.
  assert.equal(match('Observation', 'date', 'lt2025-06-15', at('2025-06-15T23:30:00')), true, 'zoneless record, zoneless search');
  assert.equal(match('Observation', 'date', 'ge2026-01-01', at('2025')), true, 'a zoneless year can end after a zoneless start');
  assert.equal(match('Observation', 'date', 'eq2025-06', at('2025-07-01T00:00:00Z')), true, 'within the zoneless search slack');
  assert.equal(match('Observation', 'date', 'eq2025-06', at('2025-07-02T00:00:00Z')), false, 'beyond the slack: contradiction');
  assert.equal(match('Observation', 'date', 'ge2020-01-01', at('2019-12-31T11:00:00Z')), true, 'zoneless search start widened by 14 hours');
  assert.equal(match('Observation', 'date', 'ge2020-01-01', at('2019-12-31T09:59:59Z')), false);
  // Zoned values on both sides have no slack: the boundary is exact.
  assert.equal(match('Observation', 'date', 'ge2025-06-15T08:00:00Z', at('2025-06-15T08:00:00Z')), true);
  assert.equal(match('Observation', 'date', 'ge2025-06-15T08:00:01Z', at('2025-06-15T08:00:00Z')), false);
  assert.equal(match('Observation', 'date', 'gt2025-06-15T08:00:00Z', at('2025-06-15T08:00:00Z')), false, 'gt: the record must extend past the search end');
  assert.equal(match('Observation', 'date', 'gt2025-06-15T07:59:59Z', at('2025-06-15T08:00:00Z')), true);
  assert.equal(match('Observation', 'date', 'lt2025-06-15T08:00:00Z', at('2025-06-15T08:00:00Z')), false, 'lt: the record must begin before the search start');
  assert.equal(match('Observation', 'date', 'lt2025-06-15T08:00:01Z', at('2025-06-15T08:00:00Z')), true);
  assert.equal(match('Observation', 'date', 'le2025-06-15T08:00:00Z', at('2025-06-15T08:00:00Z')), true, 'le: the record may begin within the search value');
  assert.equal(match('Observation', 'date', 'le2025-06-15T07:59:59Z', at('2025-06-15T08:00:00Z')), false);
  assert.equal(match('Observation', 'date', 'eq2025-06-15T08:00:00Z', at('2025-06-15T08:00:01Z')), false, 'eq: the ranges must overlap');
  assert.equal(match('Observation', 'date', 'eq2025-06-15T08:00:00+02:00', at('2025-06-15T06:00:00Z')), true, 'offsets compare as instants');
  // Periods: open ends extend without limit; an empty Period is no value.
  assert.equal(match('Observation', 'date', 'ge2025', { effectivePeriod: { start: '2020-01-01T00:00:00Z' } }), true);
  assert.equal(match('Observation', 'date', 'ge2025', { effectivePeriod: { end: '2019-01-01T00:00:00Z' } }), false);
  assert.equal(match('Observation', 'date', 'lt1990', { effectivePeriod: { end: '2019-01-01T00:00:00Z' } }), true);
  assert.equal(match('Observation', 'date', 'ge2025', { effectivePeriod: {} }), false);
  assert.equal(match('Observation', 'date', 'ge2025', { effectiveInstant: '2025-03-01T00:00:00.000Z' }), true);
  // Missing, unsupported and unjudgeable values.
  assert.equal(match('Observation', 'date', 'ge2025', {}), false, 'a missing date never matches');
  assert.equal(match('Observation', 'date', 'ge2025', { effectiveTiming: { event: ['2025-01-01'] } }), undefined, 'Timing cannot be judged');
  assert.equal(match('Observation', 'date', 'ge2025', { _effectiveDateTime: { extension: [] } }), undefined, 'extension-only cannot be judged');
  assert.equal(match('Observation', 'date', 'ge2025', at('2025-03-01T00:00:00.1234Z')), undefined, 'sub-millisecond cannot be judged');
  assert.equal(match('Observation', 'date', 'ge2025', at('not-a-date')), undefined);
  assert.equal(match('Observation', 'date', 'ge2020,lt1990', at('2025-01-01T00:00:00Z')), true, 'alternatives are ORed');
  assert.equal(ZONELESS_SLACK_MS, 14 * 3600 * 1000);
  assert.equal(dateCanMatch('ap', { lo: 0, hi: 1 }, { startMin: 0, startMax: 0, endMin: 1, endMax: 1 }), false);
});

test('no-self checker: reference and _id rules', () => {
  assert.equal(match('Observation', 'encounter', 'Encounter/e-1', { encounter: { reference: 'Encounter/e-1' } }), true);
  assert.equal(match('Observation', 'encounter', 'Encounter/e-1', { encounter: { reference: 'Encounter/e-2' } }), false);
  assert.equal(match('Observation', 'encounter', 'Encounter/e-1', { encounter: { reference: 'Procedure/e-1' } }), false, 'same id, other type');
  assert.equal(match('Observation', 'encounter', 'Encounter/e-1', { encounter: { reference: 'Encounter/e-1/_history/3' } }), true, 'a versioned reference names the same record');
  assert.equal(match('Observation', 'encounter', 'e-1', { encounter: { reference: 'Encounter/e-1' } }), true, 'a bare id matches the id');
  assert.equal(match('Observation', 'encounter', 'Encounter/e-1', { encounter: { reference: 'http://127.0.0.1:1/fhir/Encounter/e-1' } }), true, 'same-source absolute');
  assert.equal(match('Observation', 'encounter', 'Encounter/e-1', { encounter: { reference: 'http://elsewhere.example/fhir/Encounter/e-1' } }), undefined, 'another source cannot be judged');
  assert.equal(match('Observation', 'encounter', 'Encounter/e-1', { encounter: { identifier: { value: 'x' } } }), undefined, 'a logical reference cannot be judged');
  assert.equal(match('Observation', 'encounter', 'Encounter/e-1', {}), false, 'no reference never matches');
  assert.equal(match('Observation', 'derived-from', 'Observation/o-1', { derivedFrom: [{ reference: 'Observation/o-2' }, { reference: 'Observation/o-1' }] }), true);
  assert.equal(match('Observation', '_id', 'a,b', { id: 'b' }), true);
  assert.equal(match('Observation', '_id', 'a,b', { id: 'c' }), false);
  assert.equal(match('Observation', '_id', 'a', {}), false);
});

test('no-self checker: every repeated parameter holds on every record', () => {
  const p = [pred('Observation', 'date', 'ge2020')!, pred('Observation', 'date', 'lt2026')!];
  const rec = (id: string, effectiveDateTime: string) => ({ resourceType: 'Observation', id, effectiveDateTime });
  assert.deepEqual(checkReturnedRecords(p, [rec('a', '2025-01-01T00:00:00Z')], BASE), { status: 'ok' });
  assert.deepEqual(checkReturnedRecords(p, [rec('a', '2025-01-01T00:00:00Z'), rec('b', '2027-01-01T00:00:00Z')], BASE), { status: 'contradicted', parameter: 'date' });
  assert.deepEqual(checkReturnedRecords(p, [{ resourceType: 'Observation', id: 'c', effectiveTiming: {} }], BASE), { status: 'uncheckable', parameter: 'date' });
  assert.deepEqual(checkReturnedRecords(p, [{ resourceType: 'Observation', id: 'c', effectiveTiming: {} }, rec('b', '2027-01-01T00:00:00Z')], BASE), { status: 'contradicted', parameter: 'date' }, 'a contradiction outranks an unjudgeable record');
  assert.deepEqual(checkReturnedRecords(p, [], BASE), { status: 'ok' });
});

// ---------------------------------------------------------------------------------------------------------------
// Part 2: a first page without a self link.
// ---------------------------------------------------------------------------------------------------------------

test('no-self page: refused by default even when every filter is checkable', async t => {
  const source = await startSource(t, { records: [obs('a1')] });
  for (const extra of [{}, { continuationTokenParameter: 'page' }]) {
    const result = await gatewayFor(t, source, extra).execute('fhir_search', { resource_type: 'Observation', params: [CODE, DATE], output });
    assert.equal(result.error?.code, 'UNVERIFIED_QUERY');
    assert.deepEqual(result.data, {});
  }
});

test('no-self page: accepted when every filter is gateway-checked, labelled gateway_checked_records', async t => {
  const source = await startSource(t, { records: [obs('a1'), obs('a2', A, { effectiveDateTime: '2024-03-01T00:00:00Z' }), obs('b1', B)] });
  const result = await gatewayFor(t, source).execute('fhir_search', { resource_type: 'Observation', params: [CODE, DATE, SORT], output });
  assert.equal(result.error, undefined, JSON.stringify(result.error));
  assert.deepEqual(ids(result), ['a1', 'a2']);
  assert.equal(result.coverage.query_evidence, 'gateway_checked_records');
  assert.deepEqual(executions(result), [['code', 'gateway_checked'], ['date', 'gateway_checked'], ['patient', 'gateway_enforced']]);
  assert.ok(result.coverage.constraints!.every(c => c.source_reported === 'not_reported' && c.evidence_ref === undefined));
  assert.equal(result.coverage.state, 'unknown', 'membership only, never complete');
  assert.equal(result.coverage.query_exhausted, true);
  assert.deepEqual(result.coverage.reasons, ['CLINICAL_RECORD_COMPLETENESS_UNKNOWN']);
  assert.deepEqual(result.coverage.sort, { requested: ['-date'], effective: null, evidence: 'unknown', order: 'requested_unverified' });
  assert.deepEqual(warnings(result), ['ORDER_UNVERIFIED']);
  assert.equal(result.pagination?.total?.value, undefined, 'no total without a self link');
  assert.equal(result.pagination?.has_more, false);
});

test('no-self page: a single page without a self link never publishes a total', async t => {
  const records = [obs('a1'), obs('a2'), obs('b1', B)];
  for (const params of [[], [CODE]]) {
    const noSelf = await gatewayFor(t, await startSource(t, { records })).execute('fhir_search', { resource_type: 'Observation', params, output });
    assert.equal(noSelf.error, undefined, JSON.stringify(noSelf.error));
    assert.deepEqual(ids(noSelf), ['a1', 'a2']);
    assert.equal(noSelf.pagination?.has_more, false);
    assert.equal(noSelf.coverage.query_exhausted, true);
    assert.equal(noSelf.pagination?.total?.value, undefined, `${JSON.stringify(params)}: no total without a self link`);
    // Control: the same single page with a self link publishes the delivered count.
    const withSelf = await gatewayFor(t, await startSource(t, { records, self: true })).execute('fhir_search', { resource_type: 'Observation', params, output });
    assert.equal(withSelf.pagination?.total?.value, 2, JSON.stringify(params));
  }
});

test('no-self page: refused when one filter is not gateway-checkable', async t => {
  const source = await startSource(t, { records: [obs('a1')] });
  const gateway = gatewayFor(t, source);
  for (const params of [[CODE, { name: 'value-quantity', value: 'gt5' }], [{ name: 'code', value: '|4548-4' }], [{ name: 'code', value: `${LOINC}|` }],
    [CODE, { name: 'date', value: 'ne2020-01-01' }], [{ name: '_lastUpdated', value: 'ge2020' }], [{ name: 'value-string', value: 'x' }]]) {
    const before = source.clinical().length;
    const result = await gateway.execute('fhir_search', { resource_type: 'Observation', params, output });
    assert.equal(result.error?.code, 'UNVERIFIED_QUERY', JSON.stringify(params));
    assert.deepEqual(result.data, {});
    assert.equal(source.clinical().length, before + 1, 'refused after the page arrived, never post-filtered');
  }
  const control = await gateway.execute('fhir_search', { resource_type: 'Observation', params: [CODE], output });
  assert.equal(control.error, undefined, 'the same source with a checkable filter is accepted');
});

test('no-self page: a returned record that fails a filter refuses the page as contradicted', async t => {
  const profile: SearchProfile = { ...declaredSearchProfile('synthetic-fixture-r4-v1')!, id: 'private-no-self', eligible: false, evidence: null,
    source: { software: 'no-self-link synthetic source', software_version: '1', fhir_version: '4.0.1' } };
  for (const [label, bad] of [['code', obs('a9', A, { code: { coding: [{ system: LOINC, code: '17856-6' }] } })], ['date', obs('a9', A, { effectiveDateTime: '2019-01-01T00:00:00Z' })],
    ['missing date', obs('a9', A, { effectiveDateTime: undefined })]] as const) {
    const source = await startSource(t, { records: [obs('a1')], inject: [bad] });
    const gateway = gatewayFor(t, source, undefined, { testQueryProfile: profile });
    const result = await gateway.execute('fhir_search', { resource_type: 'Observation', params: [CODE, DATE], output });
    assert.equal(result.error?.code, 'UNVERIFIED_QUERY', label);
    assert.deepEqual(result.data, {}, `${label}: no record from a contradicted page`);
    assert.equal((gateway as unknown as { selectedProfile(): unknown }).selectedProfile(), undefined, `${label}: the selected profile is invalidated`);
  }
  // A record that cannot be judged refuses the page too.
  const source = await startSource(t, { records: [obs('a1')], inject: [obs('a9', A, { effectiveDateTime: undefined, effectiveTiming: { event: ['2025-01-01'] } })] });
  assert.equal((await gatewayFor(t, source).execute('fhir_search', { resource_type: 'Observation', params: [DATE], output })).error?.code, 'UNVERIFIED_QUERY');
});

test('no-self page: a proving profile claims neither execution nor order without a self link', async t => {
  const profile: SearchProfile = { ...declaredSearchProfile('synthetic-fixture-r4-v1')!, id: 'private-no-self', eligible: false, evidence: null,
    source: { software: 'no-self-link synthetic source', software_version: '1', fhir_version: '4.0.1' } };
  const source = await startSource(t, { records: [obs('a1'), obs('a2', A, { effectiveDateTime: '2024-03-01T00:00:00Z' })] });
  const result = await gatewayFor(t, source, undefined, { testQueryProfile: profile }).execute('fhir_search', { resource_type: 'Observation', params: [CODE, DATE, SORT], output });
  assert.equal(result.error, undefined, JSON.stringify(result.error));
  assert.equal(result.coverage.query_evidence, 'gateway_checked_records');
  assert.deepEqual(executions(result), [['code', 'gateway_checked'], ['date', 'gateway_checked'], ['patient', 'gateway_enforced']]);
  assert.equal(result.coverage.sort?.order, 'requested_unverified');
  assert.ok(warnings(result).includes('ORDER_UNVERIFIED'));
  // The same profile with a self link still proves its variants (control).
  const withSelf = await startSource(t, { records: [obs('a1')], self: true });
  const proved = await gatewayFor(t, withSelf, undefined, { testQueryProfile: profile }).execute('fhir_search', { resource_type: 'Observation', params: [CODE, DATE, SORT], output });
  assert.equal(proved.coverage.query_evidence, 'tested_adapter');
});

test('no-self page: an empty page is labelled unverified, never NO_MATCHES or complete', async t => {
  const source = await startSource(t, { records: [obs('a1'), obs('b1', B, { code: { coding: [{ system: LOINC, code: '2345-7' }] } })] });
  const gateway = gatewayFor(t, source);
  const empty = await gateway.execute('fhir_search', { resource_type: 'Observation', params: [{ name: 'code', value: `${LOINC}|2345-7` }], output });
  assert.equal(empty.error, undefined);
  assert.deepEqual(ids(empty), []);
  assert.equal(empty.coverage.query_evidence, 'gateway_checked_records');
  assert.deepEqual(executions(empty), [['code', 'unknown'], ['patient', 'gateway_enforced']], 'nothing was checked');
  assert.deepEqual(empty.coverage.reasons, ['CLINICAL_RECORD_COMPLETENESS_UNKNOWN', 'FILTER_EXECUTION_UNVERIFIED']);
  assert.deepEqual(warnings(empty), ['FILTER_EXECUTION_UNVERIFIED']);
  assert.notEqual(empty.coverage.state, 'complete_for_query');
  assert.equal(empty.pagination?.total?.value, undefined);
  // A confinement-only search on a source with no own records is labelled the same way.
  const noOwn = await startSource(t, { records: [obs('b1', B)] });
  const unfiltered = await gatewayFor(t, noOwn).execute('fhir_search', { resource_type: 'Observation', params: [], output });
  assert.equal(unfiltered.error, undefined);
  assert.deepEqual(executions(unfiltered), [['patient', 'gateway_enforced']]);
  assert.ok(unfiltered.coverage.reasons.includes('FILTER_EXECUTION_UNVERIFIED'));
  assert.equal(unfiltered.coverage.state, 'unknown');
  assert.ok(!warnings(unfiltered).includes('NO_MATCHES'));
  // With a self link the same empty search keeps today's NO_MATCHES.
  const withSelf = await startSource(t, { records: [obs('a1')], self: true });
  const today = await gatewayFor(t, withSelf).execute('fhir_search', { resource_type: 'Observation', params: [{ name: 'code', value: `${LOINC}|2345-7` }], output });
  assert.ok(warnings(today).includes('NO_MATCHES'));
});

test('no-self page: an OperationOutcome reporting an ignored or unsupported parameter fails it', async t => {
  const outcomes: [string, R][] = [
    ['warning naming the filter', { resourceType: 'OperationOutcome', issue: [{ severity: 'warning', code: 'processing', diagnostics: 'Parameter code was ignored' }] }],
    ['information not-supported', { resourceType: 'OperationOutcome', issue: [{ severity: 'information', code: 'not-supported' }] }],
    ['error with expression', { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'not-supported', expression: ['Observation.date'] }] }],
  ];
  for (const [label, outcome] of outcomes) {
    const source = await startSource(t, { records: [obs('a1')], outcome });
    const result = await gatewayFor(t, source).execute('fhir_search', { resource_type: 'Observation', params: [CODE, DATE], output });
    assert.equal(result.error?.code, 'UNVERIFIED_QUERY', label);
  }
  const benign = await startSource(t, { records: [obs('a1')], outcome: { resourceType: 'OperationOutcome', issue: [{ severity: 'information', code: 'informational' }] } });
  const accepted = await gatewayFor(t, benign).execute('fhir_search', { resource_type: 'Observation', params: [CODE, DATE], output });
  assert.equal(accepted.error, undefined, 'an outcome that questions no parameter is surfaced as today');
  assert.ok(accepted.coverage.reasons.includes('SOURCE_OUTCOME'));
});

test('no-self page: twin refusals and acceptances are identical whatever another patient\'s data is', async t => {
  const foreign: R[][] = [[], [obs('b1', B)], [obs('b2', B, { code: { coding: [{ system: LOINC, code: '17856-6' }] } })],
    [obs('b3', B, { effectiveDateTime: undefined, effectiveTiming: { event: ['2025-01-01'] } })], [obs('b4', B, { effectiveDateTime: '1990-01-01T00:00:00Z' })]];
  const scenarios: [string, R[], R[]][] = [
    ['accepted', [obs('a1')], []],
    ['contradicted', [obs('a1')], [obs('a9', A, { effectiveDateTime: '1990-01-01T00:00:00Z' })]],
    ['uncheckable', [obs('a1')], [obs('a9', A, { effectiveDateTime: undefined, effectiveTiming: {} })]],
    ['empty', [], []],
  ];
  for (const [label, own, ownInjected] of scenarios) {
    const seen: string[] = [];
    for (const variant of foreign) {
      const source = await startSource(t, { records: own, inject: [...ownInjected, ...variant] });
      const result = await gatewayFor(t, source).execute('fhir_search', { resource_type: 'Observation', params: [CODE, DATE], output });
      seen.push(JSON.stringify(comparable(result)));
    }
    assert.equal(new Set(seen).size, 1, `${label}: another patient's records never change the response`);
    if (label !== 'accepted' && label !== 'empty') assert.match(seen[0]!, /"code":"UNVERIFIED_QUERY"/);
  }
});

test('no-self page: the confined reference-target check also works without a self link', async t => {
  const source = await startSource(t, { records: [encounter('enc-a'), encounter('enc-b', B), obs('a1', A, { encounter: { reference: 'Encounter/enc-a' } }), obs('a2')] });
  const gateway = gatewayFor(t, source);
  const scoped = await gateway.execute('fhir_search', { resource_type: 'Observation', params: [{ name: 'encounter', value: 'Encounter/enc-a' }], output });
  assert.equal(scoped.error, undefined, JSON.stringify(scoped.error));
  assert.deepEqual(ids(scoped), ['a1']);
  assert.deepEqual(executions(scoped), [['encounter', 'gateway_checked'], ['patient', 'gateway_enforced']]);
  const foreign = await gateway.execute('fhir_search', { resource_type: 'Observation', params: [{ name: 'encounter', value: 'Encounter/enc-b' }], output });
  assert.equal(foreign.error?.code, 'POLICY_DENIED');
  const patient = await startSource(t, { records: [patientRecord()] });
  const own = await gatewayFor(t, patient).execute('fhir_search', { resource_type: 'Patient', params: [{ name: 'birthdate', value: 'eq1980-02-03' }], output });
  assert.equal(own.error, undefined, JSON.stringify(own.error));
  assert.deepEqual(executions(own), [['birthdate', 'gateway_checked'], ['_id', 'gateway_enforced']]);
});

test('no-self page: sources that send self links behave exactly as today', async t => {
  const records = [obs('a1'), obs('a2'), obs('a3'), obs('b1', B)];
  const source = await startSource(t, { records, self: true });
  const legacyGateway = gatewayFor(t, source, {});
  // The record-check setting changes nothing for a self-linked page (the token setting only adds continuations).
  const optedIn = gatewayFor(t, source, { selfLinkOptional: true });
  for (const params of [[CODE, DATE, SORT], [], [{ name: 'value-quantity', value: 'gt5' }]]) {
    const before = await legacyGateway.execute('fhir_search', { resource_type: 'Observation', params, page_size: 2, output });
    const after = await optedIn.execute('fhir_search', { resource_type: 'Observation', params, page_size: 2, output });
    const strip = (env: GatewayEnvelope) => { const c = comparable(env); delete c.source; return c; };
    assert.deepEqual(strip(after), strip(before), JSON.stringify(params));
    assert.notEqual(after.coverage.query_evidence, 'gateway_checked_records');
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Part 3: the operator-declared continuation token.
// ---------------------------------------------------------------------------------------------------------------

const many = (n: number, patient = A) => Array.from({ length: n }, (_, i) => obs(`${patient === A ? 'a' : 'b'}${String(i).padStart(2, '0')}`, patient));

test('no-self continuation: only the exact echoed token form continues, and the chain stays unverified', async t => {
  const source = await startSource(t, { records: [...many(5), ...many(3, B)] });
  const gateway = gatewayFor(t, source);
  const first = await gateway.execute('fhir_search', { resource_type: 'Observation', params: [CODE, DATE], page_size: 2, output });
  assert.equal(first.error, undefined);
  assert.equal(first.pagination?.has_more, true);
  const second = await gateway.execute('fhir_page', { cursor: first.pagination!.next_cursor!, output });
  assert.equal(second.error, undefined, JSON.stringify(second.error));
  assert.deepEqual(ids(second), ['a02', 'a03']);
  assert.equal(second.coverage.query_evidence, 'unverified_continuation');
  assert.ok(warnings(second).includes('CONTINUATION_QUERY_UNVERIFIED'));
  const third = await gateway.execute('fhir_page', { cursor: second.pagination!.next_cursor!, output });
  assert.deepEqual(ids(third), ['a04']);
  assert.equal(third.coverage.query_evidence, 'unverified_continuation', 'sticky');
  assert.equal(third.coverage.query_exhausted, null);
  assert.equal(third.pagination?.has_more, null);
  assert.notEqual(third.coverage.state, 'complete_for_query');
  const sent = source.clinical().map(url => [...url.searchParams.keys()]);
  assert.deepEqual(sent.at(-1), ['code', 'date', 'patient', '_count', 'page'], 'the echoed link is fetched as given');
  // A first page with a self link continues through the token too.
  const selfSource = await startSource(t, { records: many(3), self: true });
  const selfFirst = await gatewayFor(t, selfSource).execute('fhir_search', { resource_type: 'Observation', params: [CODE], page_size: 2, output });
  assert.ok(selfFirst.pagination?.next_cursor, 'a token link after a self-linked first page continues');
});

test('no-self continuation: every continuation page passes the record checks itself', async t => {
  const checks: [string, Partial<Parameters<typeof startSource>[1]>][] = [
    ['contradicting own record', { injectOnContinuation: [obs('a9', A, { effectiveDateTime: '1990-01-01T00:00:00Z' })] }],
    ['unjudgeable own record', { injectOnContinuation: [obs('a9', A, { effectiveDateTime: undefined, effectiveTiming: {} })] }],
    ['ignored-parameter outcome', { outcome: { resourceType: 'OperationOutcome', issue: [{ severity: 'warning', code: 'processing', diagnostics: 'date ignored' }] }, outcomeOnContinuation: true }],
  ];
  for (const [label, extra] of checks) {
    const source = await startSource(t, { records: many(4), ...extra });
    const gateway = gatewayFor(t, source);
    const first = await gateway.execute('fhir_search', { resource_type: 'Observation', params: [CODE, DATE], page_size: 2, output });
    assert.equal(first.error, undefined, label);
    const second = await gateway.execute('fhir_page', { cursor: first.pagination!.next_cursor!, output });
    assert.equal(second.error?.code, 'UNVERIFIED_QUERY', label);
  }
  // A token continuation of a self-linked chain is checked as well, even when the token page itself has no self link:
  // an uncheckable filter or a contradicting record refuses the page.
  const selfLinkedCases: [string, { name: string; value: string }[], Partial<Parameters<typeof startSource>[1]>][] = [['uncheckable filter', [{ name: 'value-quantity', value: 'gt5' }], {}],
    ['contradicting record', [CODE], { injectOnContinuation: [obs('a9', A, { code: { coding: [{ system: LOINC, code: '17856-6' }] } })] }]];
  for (const [label, params, extra] of selfLinkedCases) {
    for (const self of [true, 'first'] as const) {
      const selfSource = await startSource(t, { records: many(4), self, ...extra });
      const gateway = gatewayFor(t, selfSource);
      const first = await gateway.execute('fhir_search', { resource_type: 'Observation', params, page_size: 2, output });
      assert.equal(first.error, undefined, label);
      assert.notEqual(first.coverage.query_evidence, 'gateway_checked_records', `${label}: the first page is self-linked`);
      assert.equal((await gateway.execute('fhir_page', { cursor: first.pagination!.next_cursor!, output })).error?.code, 'UNVERIFIED_QUERY', `${label}, self ${self}`);
    }
  }
  // Control: a self-linked first page, then a token page without a self link whose records pass, continues unverified.
  const passing = await startSource(t, { records: many(4), self: 'first' });
  const control = gatewayFor(t, passing);
  const start = await control.execute('fhir_search', { resource_type: 'Observation', params: [CODE], page_size: 2, output });
  const next = await control.execute('fhir_page', { cursor: start.pagination!.next_cursor!, output });
  assert.equal(next.error, undefined, JSON.stringify(next.error));
  assert.equal(next.coverage.query_evidence, 'unverified_continuation');
});

test('no-self continuation: every page of a record-checked chain is checked, whatever link reached it', async t => {
  // The second page arrives by an ordinary echoed `_offset` link, not a token; with and without a configured token name.
  for (const extra of [{ selfLinkOptional: true }, { selfLinkOptional: true, continuationTokenParameter: 'page' }]) {
    const bad = await startSource(t, { records: many(4), offsetPaging: true, injectOnContinuation: [obs('a9', A, { effectiveDateTime: '1990-01-01T00:00:00Z' })] });
    const gateway = gatewayFor(t, bad, extra);
    const first = await gateway.execute('fhir_search', { resource_type: 'Observation', params: [CODE, DATE], page_size: 2, output });
    assert.equal(first.error, undefined, JSON.stringify(first.error));
    assert.equal(first.coverage.query_evidence, 'gateway_checked_records');
    assert.ok(first.pagination?.next_cursor, 'the echoed offset link continues');
    const second = await gateway.execute('fhir_page', { cursor: first.pagination!.next_cursor!, output });
    assert.equal(second.error?.code, 'UNVERIFIED_QUERY', `${JSON.stringify(extra)}: a contradicting record on page 2 refuses it`);
    assert.equal(bad.clinical().at(-1)!.searchParams.get('_offset'), '2', 'page 2 was fetched through the offset link');
    // Control: the same chain without the contradicting record continues, still unverified.
    const good = await startSource(t, { records: many(4), offsetPaging: true });
    const control = gatewayFor(t, good, extra);
    const start = await control.execute('fhir_search', { resource_type: 'Observation', params: [CODE, DATE], page_size: 2, output });
    const next = await control.execute('fhir_page', { cursor: start.pagination!.next_cursor!, output });
    assert.equal(next.error, undefined, JSON.stringify(next.error));
    assert.deepEqual(ids(next), ['a02', 'a03']);
    assert.equal(next.coverage.query_evidence, 'unverified_continuation');
  }
});

const LINK_REFUSALS: [string, (next: URL, request: URL) => URL | string][] = [
  ['omitted constraint', next => { next.searchParams.delete('code'); return next; }],
  ['omitted confinement', next => { next.searchParams.delete('patient'); return next; }],
  ['changed value', next => { next.searchParams.set('code', `${LOINC}|17856-6`); return next; }],
  ['re-spelled value', next => { next.searchParams.set('patient', A); return next; }],
  ['changed patient', next => { next.searchParams.set('patient', `Patient/${B}`); return next; }],
  ['dropped repetition', next => { const values = next.searchParams.getAll('date'); next.searchParams.delete('date'); next.searchParams.append('date', values[0]!); return next; }],
  ['added constraint', next => { next.searchParams.append('status', 'final'); return next; }],
  ['repeated constraint', next => { next.searchParams.append('code', `${LOINC}|4548-4`); return next; }],
  ['second token', next => { next.searchParams.append('page', 'tokentwo'); return next; }],
  ['case-variant token', next => { next.searchParams.append('Page', 'tokentwo'); return next; }],
  ['case-variant token only', next => { const value = next.searchParams.get('page')!; next.searchParams.delete('page'); next.searchParams.append('PAGE', value); return next; }],
  ['root path', next => { next.pathname = next.pathname.replace(/Observation$/, ''); return next; }],
  ['other resource path', next => { next.pathname = next.pathname.replace(/Observation$/, 'Condition'); return next; }],
  ['over-long token', next => { next.searchParams.set('page', `t2x${'y'.repeat(2046)}`); return next; }],
  ['empty token', next => { next.searchParams.set('page', ''); return next; }],
  ['non-URL-safe token', next => { next.searchParams.set('page', 't2x/abc'); return next; }],
  ['token with a space', next => { next.searchParams.set('page', 't2x abc'); return next; }],
  ['offset added', next => { next.searchParams.set('_offset', '2'); return next; }],
  ['getpages added', next => { next.searchParams.set('_getpages', 'x'); return next; }],
  ['cursor added', next => { next.searchParams.set('_cursor', 'x'); return next; }],
  ['count changed', next => { next.searchParams.set('_count', '3'); return next; }],
  ['count dropped', next => { next.searchParams.delete('_count'); return next; }],
  ['sort added', next => { next.searchParams.set('_sort', 'date'); return next; }],
  ['summary added', next => { next.searchParams.set('_summary', 'true'); return next; }],
  ['other origin', next => { next.port = '1'; return next; }],
  // Base64 padding is allowed only as one or two trailing `=` (raw strings keep the `=` unencoded).
  ['three padding characters', next => `${next.href}===`],
  ['padding inside the token', next => next.href.replace('page=t2x', 'page=t2x=')],
  ['encoded padding inside the token', next => next.href.replace('page=t2x', 'page=t2x%3D')],
  ['leading padding', next => next.href.replace('page=t2x', 'page==t2x')],
  ['plus in a padded token', next => `${next.href.replace('page=t2x', 'page=t2x+')}==`],
  ['slash in a padded token', next => `${next.href.replace('page=t2x', 'page=t2x/')}==`],
  ['over-long padded token', next => { next.searchParams.set('page', `t2x${'y'.repeat(2044)}`); return `${next.href}==`; }],
];

test('no-self continuation: an omitted, changed or added constraint, a second or case-variant token, a root path or a bad token is non-continuable', async t => {
  for (const [label, rewrite] of LINK_REFUSALS) {
    const source = await startSource(t, { records: many(4), next: rewrite });
    const result = await gatewayFor(t, source).execute('fhir_search', { resource_type: 'Observation', params: [CODE, DATE, { name: 'date', value: 'lt2026-01-01' }], page_size: 2, output });
    assert.equal(result.error, undefined, label);
    assert.deepEqual(ids(result), ['a00', 'a01'], `${label}: the checked first page is still delivered`);
    assert.equal(result.pagination?.next_cursor, undefined, label);
    assert.equal(result.pagination?.has_more, null, label);
    assert.ok(result.coverage.reasons.includes('NON_CONTINUABLE_UPSTREAM_LINK'), label);
    assert.equal(source.clinical().length, 1, `${label}: the link is never fetched`);
  }
});

test('no-self continuation: accepted boundaries and the sort echo', async t => {
  const accepted: [string, (next: URL) => URL][] = [
    ['2,048-character token', next => { next.searchParams.set('page', `t2x${'y'.repeat(2045)}`); return next; }],
    ['reordered pairs', next => { const pairs = [...next.searchParams].reverse(); next.search = ''; for (const [k, v] of pairs) next.searchParams.append(k, v); return next; }],
    ['percent-encoded echo', next => { const raw = next.href.replace('Patient%2F', 'Patient/'); return new URL(raw); }],
  ];
  for (const [label, rewrite] of accepted) {
    const source = await startSource(t, { records: many(4), next: rewrite });
    const gateway = gatewayFor(t, source);
    const first = await gateway.execute('fhir_search', { resource_type: 'Observation', params: [CODE, DATE], page_size: 2, output });
    assert.ok(first.pagination?.next_cursor, label);
    const second = await gateway.execute('fhir_page', { cursor: first.pagination!.next_cursor!, output });
    assert.equal(second.error, undefined, `${label}: ${JSON.stringify(second.error)}`);
  }
  // `_sort` may be echoed unchanged or dropped, never changed.
  for (const [label, rewrite, continues] of [['sort echoed', (n: URL) => n, true], ['sort dropped', (n: URL) => { n.searchParams.delete('_sort'); return n; }, true],
    ['sort changed', (n: URL) => { n.searchParams.set('_sort', 'date'); return n; }, false]] as const) {
    const source = await startSource(t, { records: many(4), next: rewrite });
    const first = await gatewayFor(t, source).execute('fhir_search', { resource_type: 'Observation', params: [CODE, SORT], page_size: 2, output });
    assert.equal(Boolean(first.pagination?.next_cursor), continues, label);
  }
  // Unconfigured, a token link stays non-continuable exactly as before.
  const source = await startSource(t, { records: many(4), self: true });
  const plain = await gatewayFor(t, source, {}).execute('fhir_search', { resource_type: 'Observation', params: [CODE], page_size: 2, output });
  assert.equal(plain.pagination?.next_cursor, undefined);
  assert.ok(plain.coverage.reasons.includes('NON_CONTINUABLE_UPSTREAM_LINK'));
});

test('no-self continuation: validator rules in isolation', () => {
  const query = [{ name: 'code', value: 'a|b' }, { name: 'date', value: 'ge2020' }, { name: 'date', value: 'lt2026' }, { name: 'patient', value: 'Patient/x' }, { name: '_count', value: '20' }];
  const link = (search: string, path = '/fhir/Observation') => new URL(`http://127.0.0.1:9${path}?${search}`);
  const ok = (search: string) => validateTokenContinuation({ url: link(search), resourcePath: '/fhir/Observation', tokenName: 'page', query });
  ok('date=lt2026&patient=Patient%2Fx&code=a%7Cb&date=ge2020&_count=20&page=abc');
  const refused: [string, string][] = [
    ['date=ge2020&date=lt2026&patient=Patient%2Fx&_count=20&page=abc', 'omitted'], ['code=a%7Cc&date=ge2020&date=lt2026&patient=Patient%2Fx&_count=20&page=abc', 'changed'],
    ['code=a%7Cb&date=ge2020&date=lt2026&date=lt2026&patient=Patient%2Fx&_count=20&page=abc', 'multiplicity'], ['code=a%7Cb&date=ge2020&date=lt2026&patient=Patient%2Fx&_count=20&page=abc&page=d', 'second'],
    ['code=a%7Cb&date=ge2020&date=lt2026&patient=Patient%2Fx&_count=20&page=abc&Page=d', 'variant'], ['code=a%7Cb&date=ge2020&date=lt2026&patient=Patient%2Fx&_count=21&page=abc', 'count'],
    [`code=a%7Cb&date=ge2020&date=lt2026&patient=Patient%2Fx&_count=20&page=${'a'.repeat(2049)}`, 'long'], ['code=a%7Cb&date=ge2020&date=lt2026&patient=Patient%2Fx&_count=20&page=a%2Bb', 'unsafe'],
    ['code=a%7Cb&date=ge2020&date=lt2026&patient=Patient%2Fx&_count=20&page=abc&_offset=2', 'offset'], ['code=a%7Cb&date=ge2020&date=lt2026&patient=x&_count=20&page=abc', 're-spelled'],
  ];
  for (const [search, label] of refused) assert.throws(() => ok(search), (error: unknown) => error instanceof GatewayFault && error.code === 'UNVERIFIED_CONTINUATION', label);
  assert.throws(() => validateTokenContinuation({ url: link('code=a%7Cb&date=ge2020&date=lt2026&patient=Patient%2Fx&_count=20&page=abc', '/fhir/'), resourcePath: '/fhir/Observation', tokenName: 'page', query }),
    (error: unknown) => error instanceof GatewayFault && error.code === 'UNSAFE_URL');
  ok(`code=a%7Cb&date=ge2020&date=lt2026&patient=Patient%2Fx&_count=20&page=${'a'.repeat(2048)}`);
  assert.equal(carriesContinuationToken(link('PaGe=1'), 'page'), true);
  assert.equal(carriesContinuationToken(link('page=1'), undefined), false);
  assert.equal(carriesContinuationToken(link('page=1'), ''), false);
});

test('no-self continuation: a token may end in one or two `=` of base64 padding, and `=` is refused anywhere else', () => {
  const query = [{ name: 'code', value: 'a|b' }, { name: 'date', value: 'ge2020' }, { name: 'date', value: 'lt2026' }, { name: 'patient', value: 'Patient/x' }, { name: '_count', value: '20' }];
  const link = (token: string) => new URL(`http://127.0.0.1:9/fhir/Observation?code=a%7Cb&date=ge2020&date=lt2026&patient=Patient%2Fx&_count=20&page=${token}`);
  const check = (token: string) => validateTokenContinuation({ url: link(token), resourcePath: '/fhir/Observation', tokenName: 'page', query });
  // A pair splits at its first `=` only, so raw padding stays in the token value, and the parsed URL keeps it unencoded.
  assert.equal(link('abc==').searchParams.get('page'), 'abc==');
  assert.ok(link('abc==').href.endsWith('&page=abc=='));
  assert.deepEqual([...link('=abc').searchParams].at(-1), ['page', '=abc']);
  // The rule applies to the decoded value: padding sent as `%3D` is the same value and is accepted. The total stays at most 2,048.
  for (const token of ['abc=', 'abc==', 'abc%3D', 'abc%3D%3D', 'abc=%3D', `${'a'.repeat(2047)}=`, `${'a'.repeat(2046)}==`]) check(token);
  const refused: [string, string][] = [
    ['abc===', 'three'], ['abc%3D%3D%3D', 'three, encoded'], ['a=bc', 'inside'], ['a%3Dbc', 'inside, encoded'], ['a==bc==', 'inside and trailing'],
    ['=abc', 'leading'], ['%3Dabc', 'leading, encoded'], ['=', 'padding only'], ['==', 'two padding only'],
    ['ab+c==', 'raw plus, decoded as a space'], ['ab%2Bc==', 'plus'], ['ab/c==', 'slash'], ['ab%2Fc==', 'encoded slash'], ['ab%25c==', 'percent'], ['ab%20c==', 'space'],
    [`${'a'.repeat(2047)}==`, '2,049 with two padding'], [`${'a'.repeat(2048)}=`, '2,049 with one padding'], ['a'.repeat(2049), '2,049 without padding'],
  ];
  for (const [token, label] of refused) assert.throws(() => check(token), (error: unknown) => error instanceof GatewayFault && error.code === 'UNVERIFIED_CONTINUATION', label);
});

test('no-self continuation: tokens with base64 padding continue end to end, raw or percent-encoded', async t => {
  for (const padding of ['=', '==', '%3D%3D']) {
    const source = await startSource(t, { records: [...many(5), ...many(3, B)], tokenPadding: padding });
    const gateway = gatewayFor(t, source);
    const first = await gateway.execute('fhir_search', { resource_type: 'Observation', params: [CODE, DATE], page_size: 2, output });
    assert.equal(first.error, undefined, padding);
    assert.ok(first.pagination?.next_cursor, `${padding}: the padded token link continues`);
    const second = await gateway.execute('fhir_page', { cursor: first.pagination!.next_cursor!, output });
    assert.equal(second.error, undefined, `${padding}: ${JSON.stringify(second.error)}`);
    assert.deepEqual(ids(second), ['a02', 'a03'], padding);
    assert.equal(second.coverage.query_evidence, 'unverified_continuation', padding);
    const third = await gateway.execute('fhir_page', { cursor: second.pagination!.next_cursor!, output });
    assert.equal(third.error, undefined, `${padding}: ${JSON.stringify(third.error)}`);
    assert.deepEqual(ids(third), ['a04'], padding);
    // Each link is fetched as given: the raw query ends with the padding, and the decoded token keeps it.
    const fetched = source.clinical().slice(1);
    assert.equal(fetched.length, 2, padding);
    for (const url of fetched) {
      assert.ok(url.search.endsWith(padding), `${padding}: the raw query keeps the padding`);
      assert.match(url.searchParams.get('page')!, /^t\d+xy+={1,2}$/, padding);
    }
  }
  // The 2,048-character bound counts the padding: 2,046 characters and `==` continue, 2,047 and `==` do not.
  for (const [tokenLength, continues] of [[2046, true], [2047, false]] as const) {
    const source = await startSource(t, { records: many(4), tokenPadding: '==', tokenLength });
    const first = await gatewayFor(t, source).execute('fhir_search', { resource_type: 'Observation', params: [CODE, DATE], page_size: 2, output });
    assert.equal(first.error, undefined, String(tokenLength));
    assert.equal(Boolean(first.pagination?.next_cursor), continues, `${tokenLength} characters and two padding`);
    assert.equal(first.coverage.reasons.includes('NON_CONTINUABLE_UPSTREAM_LINK'), !continues, String(tokenLength));
  }
});

test('no-self continuation: a configured token name that is a known search or result parameter is refused', () => {
  const config = (name: unknown) => ({ mode: 'synthetic' as const, source: { alias: 'no-self', baseUrl: 'http://127.0.0.1:1/fhir/', continuationTokenParameter: name as string }, patientId: A });
  for (const name of ['code', 'Code', 'date', 'patient', 'identifier', 'status', '_count', '_sort', '_offset', 'page token', 'x'.repeat(65), '-page', 5]) {
    assert.throws(() => new FhirGateway(config(name)), (error: unknown) => error instanceof GatewayFault && error.code === 'INVALID_CONFIG', String(name));
  }
  for (const name of ['page', 'pageToken', 'ct', 'next-token', '']) new FhirGateway(config(name)).close();
  for (const name of ['code', 'CODE', '_anything', 'date', '_filter', '_query']) assert.equal(isKnownParameterName(name), true, name);
  for (const name of ['page', 'pagetoken']) assert.equal(isKnownParameterName(name), false, name);
  assert.throws(() => new FhirGateway({ ...config(undefined), source: { ...config(undefined).source, selfLinkOptional: 'yes' as unknown as boolean } }), (error: unknown) => error instanceof GatewayFault && error.code === 'INVALID_CONFIG');
});

test('no-self continuation: twin non-continuable links are identical whatever another patient\'s data is', async t => {
  for (const [label, rewrite] of LINK_REFUSALS.slice(0, 4)) {
    const seen = new Set<string>();
    for (const variant of [[], many(3, B), [obs('b9', B, { effectiveDateTime: '1990-01-01T00:00:00Z' })]]) {
      const source = await startSource(t, { records: many(4), inject: variant, next: rewrite });
      seen.add(JSON.stringify(comparable(await gatewayFor(t, source).execute('fhir_search', { resource_type: 'Observation', params: [CODE, DATE], page_size: 2, output }))));
    }
    assert.equal(seen.size, 1, label);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Evidence, coverage and the strict gate.
// ---------------------------------------------------------------------------------------------------------------

test('no-self evidence: labels, downgrades and coverage never claim completeness or NO_MATCHES', () => {
  const evidence = buildQueryEvidence({ resourceType: 'Observation', pairs: [CODE, { name: 'patient', value: 'Patient/x' }], selfPairs: null, gatewayEnforcedIndices: new Set([1]),
    gatewayCheckedIndices: new Set([0, 1]), evidenceKind: 'gateway_checked_records', sourceRevision: 'r', policyRevision: 'p', contextHandle: 'c' });
  assert.deepEqual(evidence.constraints.map(c => c.execution), ['gateway_checked', 'gateway_enforced'], 'an enforced index is never relabelled checked');
  assert.equal(evidence.materialFilterProved, true);
  const downgraded = downgradeEvidence(evidence, 'code');
  assert.deepEqual(downgraded.constraints.map(c => c.execution), ['unknown', 'gateway_enforced']);
  assert.equal(downgraded.evidenceKind, 'gateway_checked_records', 'the label survives a downgrade');
  const chain = { deliveredCount: 1, pagesObserved: 1, queryEvidence: evidence, sortProof: 'none' as const, remainder: 'none' as const, exhausted: true, scope: 'page' as const, authorizationLimited: true };
  assert.equal(coverageForSnapshot(evidence, chain).state, 'unknown');
  assert.equal(coverageForSnapshot({ ...evidence, evidenceKind: 'exact_id_and_subject_linkage' }, chain).state, 'complete_for_query', 'the control still completes');
  const coverage = { query_exhausted: true, query_evidence: 'gateway_checked_records' as const, reasons: ['CLINICAL_RECORD_COMPLETENESS_UNKNOWN'] };
  assert.equal(noMatchesEligible(coverage, 0, [CODE]), false);
  assert.equal(noMatchesEligible({ ...coverage, query_evidence: 'declared_and_self_link_only' }, 0, [CODE]), true, 'the control is eligible');
});

test('no-self evidence: the strict gate binds gateway_checked to its label and refuses profile claims under it', async t => {
  const source = await startSource(t, { records: [obs('a1')] });
  const gateway = gatewayFor(t, source);
  const env = await gateway.execute('fhir_search', { resource_type: 'Observation', params: [CODE], output }) as GatewayEnvelope02;
  const capture = (gateway as unknown as { capturesV2: WeakMap<GatewayEnvelope02, ValidationContext02> }).capturesV2.get(env)!;
  assert.deepEqual(validateCrossField02('fhir_search', env, capture), { ok: true });
  const freeze = <T>(value: T): T => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
  const relabel = structuredClone(env); relabel.coverage.query_evidence = 'declared_and_self_link_only';
  assert.equal(validateCrossField02('fhir_search', relabel, capture).ok, false, 'gateway_checked never travels under the declared label');
  // The disclosed-constraint rules decide before any trusted query context is consulted.
  assert.deepEqual(validateCrossField02('fhir_search', env), { ok: false, reason: 'VALIDATION_CONTEXT_REQUIRED' }, 'control: only the context is missing');
  assert.deepEqual(validateCrossField02('fhir_search', relabel), { ok: false, reason: 'INVALID_CROSS_FIELDS' });
  const relabelTested = structuredClone(env); relabelTested.coverage.query_evidence = 'tested_adapter';
  assert.equal(validateCrossField02('fhir_search', relabelTested, capture).ok, false);
  const claimed = structuredClone(env);
  claimed.coverage.constraints![0] = { ...claimed.coverage.constraints![0]!, execution: 'tested_adapter', evidence_ref: 'p@1' };
  const query = capture.query!;
  const claimedCapture = freeze({ ...structuredClone({ ...capture, result: undefined, renderedText: undefined }), result: capture.result, renderedText: capture.renderedText,
    query: { ...structuredClone(query), constraintProof: [{ execution: 'tested_adapter', evidence_ref: 'p@1' }, ...structuredClone(query.constraintProof!.slice(1))] } }) as ValidationContext02;
  assert.equal(validateCrossField02('fhir_search', claimed, claimedCapture).ok, false, 'a profile claim never rides on record-checked evidence');
  assert.deepEqual(validateCrossField02('fhir_search', claimed), { ok: false, reason: 'INVALID_CROSS_FIELDS' });
  const complete = structuredClone(env); complete.coverage.state = 'complete_for_query';
  assert.equal(validateCrossField02('fhir_search', complete, capture).ok, false);
});

// ---------------------------------------------------------------------------------------------------------------
// Real MCP SDK stdio, both protocol eras.
// ---------------------------------------------------------------------------------------------------------------

for (const era of ['modern', 'legacy'] as const) test(`no-self stdio ${era}: checked pages, token continuation, refusal and the empty label`, async t => {
  const source = await startSource(t, { records: [...many(3), obs('b1', B)] });
  const dir = await mkdtemp(join(tmpdir(), 'nsl-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = join(dir, 'config.json');
  await writeFile(config, JSON.stringify({ mode: 'synthetic', source: { alias: 'no-self', baseUrl: source.base, selfLinkOptional: true, continuationTokenParameter: 'page' }, patientId: A }), { mode: 0o600 });
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'packages/server/src/cli.ts', '--config', config],
    env: { ...getDefaultEnvironment(), TMPDIR: tmpdir() }, stderr: 'pipe' });
  const client = new Client({ name: 'no-self-link', version: '1' }, era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : undefined);
  await client.connect(transport);
  t.after(() => client.close());
  const call = async (name: string, args: R) => (await client.callTool({ name, arguments: { ...args, output } })).structuredContent as GatewayEnvelope;
  const first = await call('fhir_search', { resource_type: 'Observation', params: [CODE, DATE, SORT], page_size: 2 });
  assert.equal(first.error, undefined, JSON.stringify(first.error));
  assert.deepEqual(ids(first), ['a00', 'a01']);
  assert.equal(first.coverage.query_evidence, 'gateway_checked_records');
  assert.deepEqual(executions(first), [['code', 'gateway_checked'], ['date', 'gateway_checked'], ['patient', 'gateway_enforced']]);
  assert.ok(warnings(first).includes('ORDER_UNVERIFIED'));
  const second = await call('fhir_page', { cursor: first.pagination!.next_cursor! });
  assert.deepEqual(ids(second), ['a02']);
  assert.equal(second.coverage.query_evidence, 'unverified_continuation');
  const refused = await call('fhir_search', { resource_type: 'Observation', params: [{ name: 'value-quantity', value: 'gt5' }] });
  assert.equal(refused.error?.code, 'UNVERIFIED_QUERY');
  const empty = await call('fhir_search', { resource_type: 'Observation', params: [{ name: 'code', value: `${LOINC}|2345-7` }] });
  assert.equal(empty.error, undefined);
  assert.deepEqual(warnings(empty), ['FILTER_EXECUTION_UNVERIFIED']);
  assert.notEqual(empty.coverage.state, 'complete_for_query');
});
