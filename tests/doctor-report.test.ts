import assert from 'node:assert/strict';
import test from 'node:test';
import { doctorReport, type DoctorInput, type DoctorFault } from '../packages/server/src/doctor.js';
import { FhirGateway, type GatewayConfig } from '../packages/core/src/index.js';

const input = (): DoctorInput => ({
  release: { name: 'fireboat', version: '0.2.0-alpha.1', schema: '0.3', catalog: 'm3b-catalog/3' },
  runtime: { node: '24.22.0', platform: 'darwin', arch: 'arm64', lossless: 'ok', cell: 'recorded' },
  source: { alias: 'synthetic', loopback: 'literal-ok', auth: 'none', classification: 'operator-declared-synthetic' },
  metadata: { status: 'ready', fhir: '4.0.1', capabilityRevision: '0123456789abcdef', summary: 'complete', typeCount: 2 },
  workflow: { id: 'recent-labs-v1', patient: 'ready', observation: 'ready', searchProfile: 'generic-r4', proof: 'unproved' },
  output: { defaultFormat: 'fhir', delivery: 'full-text-v1', defaultBytes: 24576, maxBytes: 131072, ttlMs: 900000, retentionBytes: 10485760 },
  artifacts: { r4IndexSha256: 'a'.repeat(64), r4SearchParametersSha256: 'b'.repeat(64), supportMatrixSha256: 'c'.repeat(64) },
  privacy: { patientIdentifierSystems: 0 }, proxy: 'absent', faults: [],
});

test('doctor report: exact ready lines preserve unproved limitations and hash prefixes', () => {
  const value = input(), before = structuredClone(value);
  assert.deepEqual(doctorReport(value), { exitCode: 0, lines: [
    'doctor: ready',
    'gateway: fireboat 0.2.0-alpha.1 schema=0.3 catalog=m3b-catalog/3',
    'runtime: node=24.22.0 platform=darwin arch=arm64 lossless=ok cell=recorded',
    'source: alias=synthetic loopback=literal-ok auth=none classification=operator-declared-synthetic',
    'metadata: ready fhir=4.0.1 revision=0123456789abcdef summary=complete types=2',
    'workflow: recent-labs-v1 patient=ready observation=ready',
    'search_profile: generic-r4 proof=unproved filter-and-sort-execution=unknown',
    'output: default=fhir delivery=full-text-v1 default_bytes=24576 max_bytes=131072 ttl_ms=900000 retention_bytes=10485760',
    'privacy: patient_identifier_systems=0 residual=unlisted-patient-systems',
    'artifacts: r4_index=aaaaaaaaaaaa r4_search_parameters=bbbbbbbbbbbb support_matrix=cccccccccccc',
    'proxy: absent', 'faults: none',
    'scope: local-stdio synthetic-only read-only metadata-only; no-SMART-authorization; classification=operator-declared-unverified',
  ] });
  assert.deepEqual(value, before, 'the formatter does not mutate its input');
  value.metadata.summary = 'partial'; value.workflow.searchProfile = 'hapi-r4-labs-v1'; value.workflow.proof = 'qualified';
  assert.equal(doctorReport(value).exitCode, 0, 'partial server summary is not a workflow failure');
});

test('doctor report: each missing workflow interaction is not-ready', () => {
  for (const type of ['patient', 'observation'] as const) {
    const value = input(); value.workflow[type] = 'not-ready';
    assert.equal(doctorReport(value).exitCode, 1);
    assert.equal(doctorReport(value).lines[0], 'doctor: not-ready');
    assert.ok(doctorReport(value).lines.includes('faults: WORKFLOW_TYPE_UNAVAILABLE'));
  }
});

test('doctor report: metadata and FHIR failures are not-ready; operator faults take precedence', () => {
  for (const status of ['unavailable', 'invalid'] as const) {
    const value = input(); value.metadata.status = status;
    assert.equal(doctorReport(value).exitCode, 1);
    assert.ok(doctorReport(value).lines.some(line => line === `faults: METADATA_${status.toUpperCase()}`));
  }
  for (const fhir of ['other', 'unknown'] as const) {
    const value = input(); value.metadata.fhir = fhir;
    assert.equal(doctorReport(value).exitCode, 1);
    assert.ok(doctorReport(value).lines.includes('faults: FHIR_VERSION_UNSUPPORTED'));
  }
  for (const fault of ['RUNTIME_UNSUPPORTED', 'CONFIG_INVALID', 'PROFILE_INVALID', 'ASSET_MISSING', 'ASSET_INVALID', 'DTO_INVALID'] as const) {
    const value = input(); value.faults = ['METADATA_UNAVAILABLE', fault];
    assert.equal(doctorReport(value).exitCode, 2); assert.equal(doctorReport(value).lines[0], 'doctor: fault');
  }
  const value = input(); value.runtime.lossless = 'unsupported';
  assert.equal(doctorReport(value).exitCode, 2);
  value.runtime.lossless = 'ok'; value.runtime.node = '23.99.0';
  assert.equal(doctorReport(value).exitCode, 2);
  value.runtime.node = '24.22.0'; value.faults = ['WORKFLOW_TYPE_UNAVAILABLE'];
  assert.equal(doctorReport(value).exitCode, 1);
});

function refuses(value: unknown): void {
  const report = doctorReport(value as DoctorInput);
  assert.equal(report.exitCode, 2); assert.equal(report.lines[0], 'doctor: fault');
  assert.ok(report.lines.includes('faults: DTO_INVALID'));
  assert.doesNotMatch(report.lines.join('\n'), /CANARY|https?:|file:|\/private|patient-secret/);
}
test('doctor DTO: unknown keys at every level and non-JSON properties refuse without disclosure', () => {
  for (const key of ['release', 'runtime', 'source', 'metadata', 'workflow', 'output', 'artifacts', 'privacy'] as const) {
    const value = input(); Object.assign(value[key], { raw: 'https://CANARY/patient-secret' }); refuses(value);
  }
  refuses({ ...input(), config: { patientId: 'CANARY' } });
  refuses({ ...input(), error: 'CANARY' });
  const hidden = input(); Object.defineProperty(hidden.source, 'raw', { value: 'CANARY' }); refuses(hidden);
  const symbol = input(); Object.assign(symbol.source, { [Symbol('CANARY')]: 'CANARY' }); refuses(symbol);
  const accessor = input(); Object.defineProperty(accessor.source, 'alias', { get() { throw new Error('CANARY'); }, enumerable: true }); refuses(accessor);
  const array = input(); Object.assign(array.faults, { raw: 'CANARY' }); refuses(array);
  refuses(null); refuses([]); refuses({});
});

test('doctor DTO: unsafe strings, enum drift, and arbitrary fault messages refuse', () => {
  const cases: [keyof DoctorInput, string, unknown][] = [
    ['release', 'name', '/private/CANARY'], ['release', 'version', '0.2.0 CANARY'], ['release', 'schema', '0.2'], ['release', 'catalog', 'm3b-catalog/2'],
    ['runtime', 'node', 'v24.22.0'], ['runtime', 'platform', 'CANARY'], ['runtime', 'arch', 'CANARY'], ['runtime', 'cell', 'qualified'],
    ['source', 'alias', 'https://CANARY'], ['source', 'alias', 'CANARY\n'], ['source', 'loopback', 'http://127.0.0.1'], ['source', 'auth', 'Bearer-CANARY'],
    ['source', 'classification', 'verified'], ['metadata', 'capabilityRevision', 'CANARY'], ['metadata', 'fhir', '4.0.2'],
    ['workflow', 'searchProfile', 'private-CANARY'], ['workflow', 'id', 'CANARY'], ['workflow', 'proof', 'source-reported'],
    ['artifacts', 'r4IndexSha256', 'A'.repeat(64)], ['artifacts', 'r4SearchParametersSha256', 'a'.repeat(63)], ['artifacts', 'supportMatrixSha256', 'a'.repeat(64) + '\n'],
  ];
  for (const [section, key, bad] of cases) {
    const value = input(); Object.assign(value[section], { [key]: bad }); refuses(value);
  }
  const value = input(); value.faults = ['CANARY: arbitrary message' as DoctorFault]; refuses(value);
  refuses({ ...input(), proxy: 'http://CANARY' });
});

test('doctor DTO: numeric ranges and normalized output ordering are strict', () => {
  for (const [key, min, max] of [['defaultBytes', 8192, 131072], ['maxBytes', 8192, 131072], ['ttlMs', 1, 900000], ['retentionBytes', 256, 104857600]] as const) {
    for (const bad of [min - 1, max + 1, NaN, Infinity, 8192.5, Number.MAX_SAFE_INTEGER + 1]) {
      const value = input(); value.output[key] = bad; refuses(value);
    }
  }
  const inverted = input(); inverted.output.maxBytes = 8192; refuses(inverted);
  for (const bad of [-1, 33, 1.5, Number.MAX_SAFE_INTEGER + 1]) { const value = input(); value.privacy.patientIdentifierSystems = bad; refuses(value); }
  for (const bad of [-1, 1000, 1.5]) { const value = input(); value.metadata.typeCount = bad; refuses(value); }
});

test('doctor policy: normalized values agree with gateway execution and cannot be changed', async () => {
  for (const limits of [undefined, { maxBytes: 8192 }, { defaultBytes: 16384, maxBytes: 32768, ttlMs: 23, retentionBytes: 123456 }] as GatewayConfig['limits'][]) {
    const gateway = new FhirGateway({ mode: 'synthetic', source: { alias: 'synthetic', baseUrl: 'http://127.0.0.1:9/fhir' }, patientId: 'synthetic', limits });
    try {
      const policy = gateway.describeOperatorPolicy();
      assert.deepEqual(Object.keys(policy).sort(), ['defaultFormat', 'delivery', 'defaultBytes', 'maxBytes', 'ttlMs', 'retentionBytes'].sort());
      assert.equal(policy.defaultBytes, Math.min(limits?.defaultBytes ?? 24576, limits?.maxBytes ?? 131072));
      assert.equal(policy.maxBytes, limits?.maxBytes ?? 131072); assert.equal(policy.ttlMs, limits?.ttlMs ?? 900000);
      assert.equal(policy.retentionBytes, limits?.retentionBytes ?? 10485760); assert.equal(policy.delivery, 'full-text-v1');
      const result = await gateway.execute('fhir_capabilities', { topic: 'context' });
      assert.equal(result.budget.byte_limit, policy.defaultBytes);
      assert.throws(() => Object.assign(policy, { maxBytes: 999999 }));
    } finally { gateway.close(); }
  }
});
