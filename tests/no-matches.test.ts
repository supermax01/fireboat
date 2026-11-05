// P item 3 + item 2 repairs: NO_MATCHES eligibility, bounded observed-code
// repair (incl. Addendum A.8 escaped-OR), and repair-table safety. Pure
// helpers only; the gateway emission hook waits for Q coverage at root
// integration (spec §10 checkpoint 4).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  FAULT_CODES, NO_MATCHES_MESSAGE, NO_MATCHES_UNVERIFIED_SUFFIX, OBSERVED_CODE_FIELDS, OBSERVED_CODE_SCAN_LIMITS,
  capabilitiesCombinationFault, escapeFhirTokenPart, noMatchesWarning, observedCodeOrValue, observedCodeOrValueDetailed,
  repairForFault, repairForNoMatches, repairSchema, splitEscapedCommaOr, splitEscapedCommaOrDetailed, toolInputV2Schemas,
} from '../packages/core/src/index.js';
import { resolveElement, resourceTypeContext } from '../packages/core/src/schema.js';
import { parseM3bTaskFile } from '../packages/evals/src/index.js';

const reviewed = { resource: (t: string) => t === 'Observation', parameter: (t: string, n: string) => t === 'Observation' && n === 'code' };
const eligible = { resourceType: 'Observation', deliveredCount: 0, queryExhausted: true as const, filtered: true, filterExecutionVerified: true, dateWindow: [{ name: 'date', value: 'ge2025-01-01' }] };

test('NO_MATCHES: exact eligibility and fixed text', () => {
  const warning = noMatchesWarning(eligible, reviewed)!;
  assert.equal(warning.code, 'NO_MATCHES');
  assert.equal(warning.message, NO_MATCHES_MESSAGE);
  assert.deepEqual(warning.repair, { action: 'inspect_observed_codes', tool: 'fhir_search', resource_type: 'Observation', fields: ['code'], page_size: 100, max_pages: 3, max_calls: 4 });
  // Terminal unverified zero: hint plus uncertainty sentence, never an absence claim.
  assert.equal(noMatchesWarning({ ...eligible, filterExecutionVerified: false }, reviewed)?.message, `${NO_MATCHES_MESSAGE}${NO_MATCHES_UNVERIFIED_SUFFIX}`);
  // Unfiltered empty, intermediate page, prior matches, unknown exhaustion: no hint.
  assert.equal(noMatchesWarning({ ...eligible, filtered: false }, reviewed), undefined);
  assert.equal(noMatchesWarning({ ...eligible, queryExhausted: false }, reviewed), undefined);
  assert.equal(noMatchesWarning({ ...eligible, queryExhausted: null }, reviewed), undefined);
  assert.equal(noMatchesWarning({ ...eligible, deliveredCount: 2 }, reviewed), undefined);
  // Unreviewed type falls back to discovery without naming it.
  assert.deepEqual(noMatchesWarning({ ...eligible, resourceType: 'Specimen' }, reviewed)?.repair, { action: 'discover_search_parameter', tool: 'fhir_capabilities' });
});

test('repair table: every fault yields only reviewed, bounded advice; canaries never enter', () => {
  const meta = { resource_type: 'Observation', parameter: 'code', allowed_max_bytes: 131072, current_max_bytes: 24576 };
  for (const code of FAULT_CODES) {
    const repair = repairForFault(code, meta, reviewed);
    if (repair) assert.equal(repairSchema.safeParse(repair).success, true, code);
    const poisoned = repairForFault(code, { ...meta, resource_type: 'Observation|canary-value', parameter: 'code|canary-value' }, reviewed);
    assert.ok(!JSON.stringify(poisoned ?? {}).includes('canary'), code);
  }
  assert.equal(repairForFault('NOT_FOUND', meta, reviewed), undefined, 'uniformized absence never carries advice');
  assert.equal(repairForNoMatches('Observation', { resource: () => false, parameter: () => false })?.action, 'discover_search_parameter');
});

test('escaped-OR repair: A.8 vectors are exact before one URL encoding', () => {
  const value = observedCodeOrValue([
    { system: 'http://loinc.org', code: '4548-4' },
    { system: 'http://example.test/codes', code: 'local,hba1c' },
  ]);
  assert.equal(value, 'http://loinc.org|4548-4,http://example.test/codes|local\\,hba1c');
  // After URL decoding exactly once the recorder observes that value: two alternatives, not three.
  const wire = new URLSearchParams({ code: value }).toString();
  const decodedOnce = new URLSearchParams(wire).get('code');
  assert.equal(decodedOnce, value);
  assert.deepEqual(splitEscapedCommaOr(decodedOnce!), ['http://loinc.org|4548-4', 'http://example.test/codes|local,hba1c']);
  // Literal pipe and backslash stay inside their token part.
  assert.equal(escapeFhirTokenPart('a|b'), 'a\\|b');
  assert.equal(escapeFhirTokenPart('a\\b'), 'a\\\\b');
  assert.equal(observedCodeOrValue([{ system: 'http://x.test', code: 'a|b' }]), 'http://x.test|a\\|b');
  // P-10: only `\,` unescapes; `\|` keeps its escaped form so the system/code boundary survives.
  assert.deepEqual(splitEscapedCommaOr('http://x.test|a\\|b,http://x.test|c'), ['http://x.test|a\\|b', 'http://x.test|c']);
  // Same code in different systems is not normalized away; duplicates collapse.
  assert.equal(observedCodeOrValue([{ system: 'http://a.test', code: 'X' }, { system: 'http://b.test', code: 'X' }, { system: 'http://a.test', code: 'X' }]), 'http://a.test|X,http://b.test|X');
  assert.deepEqual(OBSERVED_CODE_SCAN_LIMITS, { recipe: 'observed-code-scan-v1', maxClinicalPages: 3, maxMcpCalls: 4, maxUpstreamCalls: 20, maxSeconds: 45, maxBytesPerCall: 24576, maxBytesPerTask: 73728 });
});

test('P-10/P-11: no broadening, no key collisions, truncation is reported, code-field map is schema-true', () => {
  // System-less tuples use the faithful `|code` form, never a bare any-system code.
  assert.equal(observedCodeOrValue([{ code: '4548-4' }]), '|4548-4');
  // (`a|b`,`c`) and (`a`,`b|c`) are distinct alternatives; neither is dropped.
  assert.equal(observedCodeOrValue([{ system: 'a|b', code: 'c' }, { system: 'a', code: 'b|c' }]), 'a\\|b|c,a|b\\|c');
  // Truncation is explicit in the detailed forms.
  const many = Array.from({ length: 40 }, (_, i) => ({ system: 'http://x.test', code: `c${i}` }));
  assert.equal(observedCodeOrValueDetailed(many).truncated, true);
  assert.equal(observedCodeOrValueDetailed(many.slice(0, 2)).truncated, false);
  assert.deepEqual(splitEscapedCommaOrDetailed('a,b,c', 2), { parts: ['a', 'b,c'], truncated: true }, 'remainder preserved, no fabricated empty part');
  assert.deepEqual(splitEscapedCommaOr('a,b,c', 2), ['a', 'b,c']);
  assert.deepEqual(splitEscapedCommaOrDetailed('a,b', 2), { parts: ['a', 'b'], truncated: false });
  assert.deepEqual(splitEscapedCommaOr('a\\\\,b'), ['a\\\\', 'b'], 'escaped backslash before a separator still splits');
  // P-11: MedicationRequest has a code search parameter but no code element.
  const medReviewed = { resource: (t: string) => t === 'MedicationRequest', parameter: (t: string, n: string) => t === 'MedicationRequest' && n === 'code' };
  assert.deepEqual(repairForNoMatches('MedicationRequest', medReviewed), { action: 'discover_search_parameter', tool: 'fhir_capabilities', resource_type: 'MedicationRequest' });
  for (const [type, field] of Object.entries(OBSERVED_CODE_FIELDS)) {
    assert.deepEqual(resolveElement(resourceTypeContext(type), field).types, ['CodeableConcept'], `${type}.${field} is a pinned CodeableConcept`);
  }
  assert.equal(resolveElement(resourceTypeContext('MedicationRequest'), 'code').name, undefined, 'MedicationRequest.code does not resolve in R4');
});

test('R2-3: callers must refuse a truncated OR-split result', () => {
  // The detailed form flags truncation; the joined remainder still carries
  // separator commas, so consuming `parts` as complete would change meaning.
  const detailed = splitEscapedCommaOrDetailed('a,b,c', 2);
  assert.equal(detailed.truncated, true);
  assert.ok(detailed.parts[1]!.includes(','), 'truncated remainder is not a valid single alternative');
  // Required caller pattern: refuse (or re-issue with a larger bound) on truncated.
  const refuseOnTruncated = (value: string, max: number): string[] => {
    const result = splitEscapedCommaOrDetailed(value, max);
    if (result.truncated) throw new Error('truncated OR value refused');
    return result.parts;
  };
  assert.throws(() => refuseOnTruncated('a,b,c', 2), /truncated OR value refused/);
  assert.deepEqual(refuseOnTruncated('a,b', 2), ['a', 'b']);
  assert.deepEqual(refuseOnTruncated('a,b,c', 3), ['a', 'b', 'c']);
  // The frozen array form drops the signal, so it must not be the completeness check.
  assert.deepEqual(splitEscapedCommaOr('a,b,c', 2), ['a', 'b,c'], 'frozen form alone cannot distinguish truncation');
  // The refusal rule is documented at the helper for every future caller.
  const source = readFileSync(join(process.cwd(), 'packages/core/src/repairs.ts'), 'utf8');
  assert.ok(source.includes('Callers MUST refuse a truncated result'), 'refusal rule documented in code');
});

test('guidance task file and query-repair examples validate against the frozen schemas', () => {
  const tasks = parseM3bTaskFile(readFileSync(join(process.cwd(), 'packages/evals/data/m3b-projection-tasks.json'), 'utf8'));
  assert.equal(tasks.length, 5);
  assert.equal(tasks.reduce((sum, task) => sum + task.checks.length, 0), 29);
  for (const task of tasks) {
    for (const step of task.steps) {
      assert.equal(toolInputV2Schemas[step.tool].safeParse(step.input).success, true, `${task.id} ${step.tool}`);
      if (step.tool === 'fhir_capabilities') assert.equal(capabilitiesCombinationFault(step.input as never), undefined, task.id);
    }
  }
  const examples = JSON.parse(readFileSync(join(process.cwd(), 'examples/query-repair-calls.json'), 'utf8')) as { calls: { id: string; tool: keyof typeof toolInputV2Schemas; input: unknown }[] };
  assert.equal(examples.calls.length, 8);
  for (const call of examples.calls) assert.equal(toolInputV2Schemas[call.tool].safeParse(call.input).success, true, call.id);
  const escaped = examples.calls.find(call => call.id === 'escaped-or-requery')!;
  const params = (escaped.input as { params: { name: string; value: string }[] }).params;
  assert.equal(params[0]?.value, observedCodeOrValue([{ system: 'http://loinc.org', code: '4548-4' }, { system: 'http://example.test/codes', code: 'local,hba1c' }]));
});
