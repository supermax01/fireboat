// P item 4 / Addendum A.7: lab-evidence projection fidelity. Critical facts
// must be identical across fhir/compact(lab)/selected, with lexical checks on
// independently serialized output (stringifyFhir), never parsed numbers.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  LAB_EVIDENCE_RECIPE_ID, LAB_OBSERVATION_ROOTS, collectRecipeIds, indexedProvenance, metaSupplement,
  projectLabObservation, projectSanitized, projectionMeta, retainedOmissions,
  type SanitizedProjectionRecord,
} from '../packages/core/src/index.js';
import { resolveElement, resourceTypeContext, schemaPage } from '../packages/core/src/schema.js';
import { retainedInspectionSchema, type FhirResource } from '../packages/core/src/contracts.js';
import { parseFhirJson, stringifyFhir } from '../packages/core/src/decimal.js';
import { COMPACT_RECIPES, projection as helperProjection, sanitize } from '../packages/core/src/privacy.js';
import { parseM3bFixtureFragment } from '../packages/evals/src/index.js';

type Rec = Record<string, unknown>;
const fragment = parseM3bFixtureFragment(readFileSync(join(process.cwd(), 'packages/evals/fixtures/m3b-projection/lab-fidelity.json'), 'utf8'));
const rawById = new Map((fragment.raw_resources ?? []).map(entry => [entry.id, parseFhirJson(entry.json_text) as FhirResource]));
const recordFor = (id: string): SanitizedProjectionRecord => {
  const sanitized = sanitize(rawById.get(id)!);
  return {
    resource: sanitized.resource, retrievedAt: sanitized.retrievedAt, policyOmitted: sanitized.omitted,
    withheldReasons: sanitized.manifests.map(manifest => String(manifest.reason)), requiresStructuralView: sanitized.requiresStructuralView,
  };
};
const at = (value: unknown, path: string): unknown => path.split('.').reduce<unknown>((node, segment) => {
  if (Array.isArray(node)) return node[Number(segment)];
  return node && typeof node === 'object' ? (node as Rec)[segment] : undefined;
}, value);

test('lab recipe keeps every critical fact: codings, quantity, ranges, specimen, identity', () => {
  const record = recordFor('p-lab-lexeme');
  const lab = projectSanitized(record, 'compact');
  assert.equal(lab.meta.recipe_id, LAB_EVIDENCE_RECIPE_ID);
  assert.equal(lab.meta.interpretation, 'clinical_projection');
  const resource = lab.resource as Rec;
  // Coding version/system/display/userSelected and concept text survive whole.
  assert.deepEqual(at(resource, 'code.coding.0'), { system: 'http://loinc.org', version: '2.78', code: '4548-4', display: 'Hemoglobin A1c', userSelected: true });
  assert.equal(at(resource, 'code.text'), 'Hemoglobin A1c');
  // Quantity comparator/system/code/unit survive; lexeme checked on serialized output.
  assert.equal(at(resource, 'valueQuantity.comparator'), '>=');
  assert.equal(at(resource, 'valueQuantity.system'), 'http://unitsofmeasure.org');
  assert.equal(at(resource, 'valueQuantity.code'), '%');
  assert.ok(stringifyFhir(resource).includes('"value":7.0'), '7.0 lexeme preserved');
  assert.ok(stringifyFhir(resource).includes('"value":5.60'), 'range lexeme preserved');
  assert.equal(at(resource, 'referenceRange.0.text'), 'Synthetic fasting range', 'required referenceRange text is not dropped');
  assert.equal(at(resource, 'interpretation.0.coding.0.code'), 'H');
  assert.equal(at(resource, 'effectiveDateTime'), '2025-02-10T08:00:00+10:30', 'timezone preserved');
  assert.equal(at(resource, 'specimen.reference'), 'Specimen/unresolved-1', 'specimen reference kept as context (never hydrated)');
  // Identity supplement: versionId/profile/SUBSETTED kept, other meta disclosed as omitted.
  assert.equal(at(resource, 'meta.versionId'), '7');
  assert.deepEqual(at(resource, 'meta.profile'), ['http://example.test/lab']);
  assert.equal(at(resource, 'meta.tag.0.code'), 'SUBSETTED');
  assert.equal(at(resource, 'meta.lastUpdated'), undefined);
  assert.ok(lab.meta.omitted_fields.includes('/meta/lastUpdated'));
  assert.ok(lab.meta.omitted_fields.includes('/identifier'), 'ancillary identifier omitted and disclosed');
  assert.ok(Buffer.byteLength(stringifyFhir(resource)) < Buffer.byteLength(stringifyFhir(record.resource)), 'lab view is smaller than sanitized fhir for this record');
});

test('panel components, period boundaries and derivedFrom/device survive; statuses are not normalized', () => {
  const lab = projectSanitized(recordFor('p-lab-panel'), 'compact');
  const resource = lab.resource as Rec;
  assert.equal(resource.status, 'corrected');
  assert.equal(at(resource, 'component.0.code.coding.0.code'), '8480-6', 'component association keeps its label');
  assert.ok(stringifyFhir(resource).includes('"value":120.00'));
  assert.ok(stringifyFhir(resource).includes('"value":-0.0'), 'negative-zero lexeme preserved');
  assert.equal(at(resource, 'component.1.dataAbsentReason.coding.0.code'), 'unknown');
  assert.deepEqual(at(resource, 'effectivePeriod'), { start: '2025-03-01', end: '2025-03-31' });
  assert.equal(at(resource, 'derivedFrom.0.reference'), 'Observation/p-lab-lexeme');
  assert.equal(at(resource, 'device.reference'), 'Device/unresolved-1');
  assert.equal(at(resource, 'meta.versionId'), '3');
});

test('critical tuples are identical across fhir, lab compact and selected views', () => {
  const record = recordFor('p-lab-lexeme');
  const fields = ['code', 'status', 'effectiveDateTime', 'valueQuantity', 'interpretation', 'referenceRange'];
  const views = [projectSanitized(record, 'fhir').resource, projectSanitized(record, 'compact').resource, projectSanitized(record, 'fhir', fields).resource] as Rec[];
  for (const path of ['resourceType', 'id', 'meta.versionId', 'status', 'code.coding.0.system', 'code.coding.0.version', 'code.coding.0.code', 'valueQuantity.comparator', 'valueQuantity.system', 'valueQuantity.code', 'effectiveDateTime', 'interpretation.0.coding.0.code', 'referenceRange.0.high.system']) {
    const values = views.map(view => at(view, path));
    assert.ok(values.every(value => value !== undefined && value === values[0]), `${path}: ${JSON.stringify(values)}`);
  }
  for (const view of views) assert.ok(stringifyFhir(view).includes('"value":7.0'), 'lexeme identical in every view');
  // Selected output carries the supplement even though meta was not selected.
  const selected = views[2]!;
  assert.deepEqual(at(selected, 'meta.profile'), ['http://example.test/lab']);
  assert.equal(at(selected, 'meta.tag.0.code'), 'SUBSETTED');
});

test('modifier semantics force the structural view, never a clinical compact label', () => {
  const base = structuredClone(rawById.get('p-lab-lexeme')!) as Rec;
  base.modifierExtension = [{ url: 'http://example.test/negation', valueBoolean: true }];
  const sanitized = sanitize(base as FhirResource);
  const record: SanitizedProjectionRecord = { resource: sanitized.resource, retrievedAt: sanitized.retrievedAt, policyOmitted: sanitized.omitted, withheldReasons: [], requiresStructuralView: sanitized.requiresStructuralView };
  assert.equal(record.requiresStructuralView, true);
  const projected = projectSanitized(record, 'compact');
  assert.equal(projected.meta.interpretation, 'structural');
  assert.equal(projected.meta.recipe_id, undefined);
  assert.ok(projected.meta.warnings.some(warning => warning.code === 'UNINTERPRETED_MODIFIER'));
  assert.deepEqual(at(projected.resource, 'modifierExtension'), base.modifierExtension, 'modifier kept whole in the structural view');
  assert.equal(at(projected.resource, 'identifier.0.value'), 'synthetic-acc-1', 'structural view is the full sanitized resource');
});

test('retained omissions validate against the frozen inspection schema; provenance is indexed', () => {
  const records = [recordFor('p-lab-lexeme'), recordFor('p-lab-panel')];
  const omissions = retainedOmissions(records, 'compact');
  const inspection = retainedInspectionSchema.parse({
    resource_count: records.length, scope: 'retained_upstream_page', upstream_pages_remain: null,
    formats: ['compact', 'fhir'], omissions,
  });
  assert.equal(inspection.omissions[0]?.recipe_id, LAB_EVIDENCE_RECIPE_ID);
  assert.equal(inspection.omissions[0]?.version, '7');
  assert.ok(inspection.omissions[0]?.omitted_fields.includes('/identifier'));
  assert.deepEqual(indexedProvenance(records).map(entry => entry.resource_index), [0, 1]);
  assert.deepEqual(collectRecipeIds(records.map(record => projectionMeta(record, 'compact'))), [LAB_EVIDENCE_RECIPE_ID]);
  // Direct projector agrees with projectSanitized for Observations.
  assert.deepEqual(projectLabObservation(records[0]!.resource).resource, projectSanitized(records[0]!, 'compact').resource);
  const supplement = metaSupplement(records[0]!.resource);
  assert.equal(supplement.meta?.versionId, '7');
  assert.ok(supplement.omitted.includes('/meta/lastUpdated'));
});

test('P-4: primitive companions and meta.security survive lab compact (K01/K03 guards)', () => {
  const record = recordFor('p-lab-companions');
  const lab = projectSanitized(record, 'compact');
  assert.equal(lab.meta.recipe_id, LAB_EVIDENCE_RECIPE_ID);
  const resource = lab.resource as Rec;
  // Extension-only primitive companions are kept whole (dropping `_` keys kills this).
  assert.deepEqual(at(resource, '_effectiveDateTime'), at(record.resource, '_effectiveDateTime'), 'extension-only effective companion kept');
  assert.deepEqual(at(resource, '_valueString'), at(record.resource, '_valueString'), 'extension-only value companion kept');
  assert.deepEqual(at(resource, '_status'), at(record.resource, '_status'), 'status companion kept');
  assert.equal(at(resource, 'effectiveDateTime'), undefined, 'no fabricated effective value');
  assert.equal(at(resource, 'valueString'), undefined, 'no fabricated value');
  // Identity supplement keeps security and the versionId companion.
  assert.deepEqual(at(resource, 'meta.security'), [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'N', display: 'normal' }]);
  assert.deepEqual(at(resource, 'meta._versionId'), { id: 'v9-companion' });
  assert.equal(at(resource, 'meta.tag.0.code'), 'SUBSETTED');
  assert.equal((at(resource, 'meta.tag') as unknown[]).length, 1, 'non-SUBSETTED tag dropped with its path');
  assert.ok(lab.meta.omitted_fields.includes('/meta/tag'));
  assert.ok(lab.meta.omitted_fields.includes('/meta/lastUpdated'));
  // Selected views keep companions and security too.
  const selected = projectSanitized(record, 'fhir', ['code', 'status']).resource as Rec;
  assert.deepEqual(at(selected, 'meta.security'), at(resource, 'meta.security'));
});

test('P-4: referenced contained data and context roots survive lab compact (K02 guard)', () => {
  const lab = projectSanitized(recordFor('p-lab-context'), 'compact');
  const resource = lab.resource as Rec;
  assert.equal(at(resource, 'specimen.reference'), '#sp1');
  assert.equal(at(resource, 'contained.0.resourceType'), 'Specimen');
  assert.equal(at(resource, 'contained.0.id'), 'sp1', 'referenced contained resource kept, never dangled');
  assert.equal(at(resource, 'hasMember.0.reference'), 'Observation/p-lab-panel');
  assert.equal(at(resource, 'focus.0.reference'), 'Observation/p-lab-lexeme');
  assert.equal(at(resource, 'bodySite.coding.0.code'), '368209003');
  assert.equal(at(resource, 'method.coding.0.code'), '129266000');
  assert.ok(stringifyFhir(resource).includes('"value":1.5e3'), 'exponent lexeme preserved');
  assert.equal(at(resource, 'encounter'), undefined);
  assert.ok(lab.meta.omitted_fields.includes('/encounter'), 'non-kept root omitted and disclosed');
  assert.ok(lab.meta.omitted_fields.includes('/note'), 'note omitted with its path (A.7.2)');
});

test('P-4: a policy-withheld modifier (flag set, element gone) forces the structural view (K04 guard)', () => {
  const clean = recordFor('p-lab-lexeme');
  assert.equal(clean.requiresStructuralView, false);
  assert.equal(at(clean.resource, 'modifierExtension'), undefined, 'no modifier element remains to detect by scanning');
  const withheld: SanitizedProjectionRecord = { ...clean, requiresStructuralView: true };
  const projected = projectSanitized(withheld, 'compact');
  assert.equal(projected.meta.interpretation, 'structural');
  assert.equal(projected.meta.recipe_id, undefined);
  assert.ok(projected.meta.warnings.some(warning => warning.code === 'UNINTERPRETED_MODIFIER'));
  assert.equal(at(projected.resource, 'identifier.0.value'), 'synthetic-acc-1', 'structural view is the full sanitized resource');
});

test('P-4: every lab root resolves in pinned R4 (all choice types) and equals compact-profiles kept_roots', () => {
  const context = resourceTypeContext('Observation')!;
  const page = schemaPage('Observation', '', 0, 50);
  for (const root of LAB_OBSERVATION_ROOTS) {
    const element = page.elements.find(entry => entry.path === root) as (typeof page.elements)[number] & { json_names?: string[] };
    assert.ok(element, `${root} is a pinned R4 Observation element`);
    if (root.endsWith('[x]')) {
      assert.ok(element.json_names && element.json_names.length > 1, `${root} declares choice JSON names`);
      for (const jsonName of element.json_names!) assert.equal(resolveElement(context, jsonName).name, root, `${jsonName} resolves to ${root}`);
    } else {
      assert.equal(resolveElement(context, root).name, root, `${root} resolves`);
    }
  }
  const compact = JSON.parse(readFileSync(join(process.cwd(), 'packages/core/src/data/compact-profiles.json'), 'utf8')) as Rec;
  assert.deepEqual((compact.profiles as Rec[])[0]!.kept_roots, [...LAB_OBSERVATION_ROOTS], 'code and data kept_roots are identical');
});

test('P-15: selected meta keys are not reported omitted; over-long retained ids are dropped, not fatal', () => {
  const record = recordFor('p-lab-lexeme');
  const selected = projectSanitized(record, 'fhir', ['meta', 'status']);
  assert.equal(at(selected.resource, 'meta.lastUpdated'), '2025-01-01T00:00:00Z', 'selected full meta survives');
  assert.ok(!selected.meta.omitted_fields.includes('/meta/lastUpdated'), 'a selected meta key is not listed as omitted');
  const longRecord: SanitizedProjectionRecord = {
    resource: { resourceType: 'Observation', id: 'x'.repeat(70), meta: { versionId: 'v'.repeat(70) }, status: 'final' } as FhirResource,
    retrievedAt: '2025-01-01T00:00:00Z', policyOmitted: [], withheldReasons: [], requiresStructuralView: false,
  };
  const [row] = retainedOmissions([longRecord], 'fhir');
  assert.equal(row!.id, undefined, 'over-long id omitted from the inspection row');
  assert.equal(row!.version, undefined, 'over-long version omitted from the inspection row');
  retainedInspectionSchema.parse({ resource_count: 1, scope: 'retained_upstream_page', upstream_pages_remain: null, formats: ['fhir'], omissions: [row] });
});

test('compact-profiles and host-profiles data files are honest and in sync with code', async () => {
  const compactText = readFileSync(join(process.cwd(), 'packages/core/src/data/compact-profiles.json'), 'utf8');
  const compact = JSON.parse(compactText) as Rec;
  const profile = (compact.profiles as Rec[])[0]!;
  assert.equal(profile.recipe_id, LAB_EVIDENCE_RECIPE_ID);
  assert.deepEqual(profile.kept_roots, [...LAB_OBSERVATION_ROOTS]);
  const activeRecipes = Object.keys(COMPACT_RECIPES).map(resourceType => projectSanitized({
    resource: { resourceType }, retrievedAt: '', policyOmitted: [], withheldReasons: [], requiresStructuralView: false,
  }, 'compact').meta.recipe_id);
  assert.deepEqual(compact.integrated_recipes, activeRecipes, 'the integrated inventory contains the eight active gateway recipes');
  const helperHistory = compact.helper_history_recipes as Rec[];
  assert.equal(helperHistory.length, 1);
  assert.equal(helperHistory[0]!.recipe_id, helperProjection({ resourceType: 'Observation' }, 'compact').recipe);
  assert.ok(!activeRecipes.includes(String(helperHistory[0]!.recipe_id)), 'the pre-lab helper is absent from the active inventory');
  assert.match(String(helperHistory[0]!.status), /Helper\/history only/);
  assert.match(String(helperHistory[0]!.status), /gateway's projectSanitized selects the lab recipe/);
  const efficiency = profile.efficiency as Rec;
  assert.equal(efficiency.claim, 'none', 'P-12: no efficiency claim is published');
  assert.match(String(efficiency.a1_stratum), /unmeasured/);
  // R2-1 / Addendum C: the superseded within-product 50% prior is gone; the
  // C.1 point target is recorded with attainment unmeasured until heldout.
  assert.equal(efficiency.fifty_percent_target, undefined, 'R2-1: superseded prior removed');
  assert.ok(!compactText.includes('50%'), 'R2-1: compact-profiles.json carries no superseded within-product prior');
  assert.match(String(efficiency.within_product_target), /≤0\.90/);
  assert.match(String(efficiency.within_product_target), /unmeasured until the frozen heldout run/);
  const targets = efficiency.targets as Rec;
  assert.match(String(targets.compact_fidelity), /≤0\.90 with full fidelity/, 'C.1 target with full fidelity recorded');
  assert.match(String(targets.compact_fidelity), /100% critical/);
  assert.match(String(targets.delivery_efficiency), /absolute model-visible bytes and tokens per correctly answered lab question/, 'C.2 absolute per-question accounting recorded');
  assert.match(String(targets.envelope_overhead), /≤15% of structuredContent/, 'C.3 envelope-overhead share recorded');
  assert.match(String(efficiency.default_rule), /Default stays fhir until C\.1 is met/, 'C.4 default rule stated');
  assert.match(String(efficiency.default_rule), /≤0\.90 point target/);
  assert.match(String(efficiency.default_rule), /95% interval upper endpoint <1\.0/, 'C.4 statistically-smaller condition stated');
  assert.match(String(efficiency.default_rule), /fidelity, task-success, and mutation gates/, 'C.4 gate conditions stated');
  assert.match(String(efficiency.default_rule), /Not-smaller, indeterminate, unmeasured, or target-unmet cells retain fhir/);
  const slimSim = efficiency.simulated_slim_text_20lab as Rec;
  assert.equal(slimSim.hardened_slim_text_bytes, 9087, 'R2-1: hardened 20-lab slim size recorded');
  assert.equal(slimSim.slim_lane_compact_over_fhir, 0.919, 'R2-1: simulated slim-lane ratio recorded');
  assert.match(String(slimSim.slim_lane_status), /0\.919 is above the C\.1 0\.90 point target and unclaimed/);
  assert.match(String(slimSim.wire_savings_vs_full_text), /27–30% simulated/);
  assert.match(String(slimSim.model_visible_savings_vs_full_text), /24–27% simulated/);
  assert.equal(efficiency.lab_recipe_envelope_level, 'Wired into gateway projection for eligible compact Observations without explicit field selection; qualifying heldout token efficiency remains unmeasured and C.1 attainment is not established.');
  assert.equal(efficiency.token_status, 'Lab heldout token efficiency remains unmeasured. Hash-locked tiktoken 0.12.0 and cl100k_base/o200k_base encoding pins exist in scripts/requirements-tokenizers.txt and packages/evals/data/tokenizers.lock.json. docs/S5-STATUS.md publishes exploratory catalog token figures and records the pinned container run as unexecuted; those figures do not establish lab heldout efficiency or token acceptance.');
  const lock = JSON.parse(readFileSync(join(process.cwd(), 'packages/evals/data/tokenizers.lock.json'), 'utf8'));
  const requirements = readFileSync(join(process.cwd(), 'scripts/requirements-tokenizers.txt'), 'utf8');
  const tokenizer = lock.wheels.find((wheel: Rec) => wheel.name === 'tiktoken');
  assert.equal(tokenizer.version, '0.12.0');
  assert.ok(requirements.includes(`tiktoken==${tokenizer.version}`));
  assert.ok(requirements.includes(`--hash=sha256:${tokenizer.sha256}`));
  assert.equal(createHash('sha256').update(requirements).digest('hex'), lock.requirements.sha256);
  assert.deepEqual(lock.encodings.map((encoding: Rec) => encoding.name).sort(), ['cl100k_base', 'o200k_base']);
  for (const encoding of lock.encodings) {
    assert.equal(encoding.tiktoken_version, tokenizer.version);
    assert.match(encoding.sha256, /^[a-f0-9]{64}$/);
  }
  const catalogStatus = readFileSync(join(process.cwd(), 'docs/S5-STATUS.md'), 'utf8');
  assert.match(catalogStatus, /Catalog token caps \| exploratory only \(macOS, tiktoken 0\.12\.0/);
  assert.match(catalogStatus, /pinned container measurement is \*\*unexecuted\*\*/);
  assert.equal(efficiency.measured_default, 'fhir', 'C.4: unmeasured cells default to fhir; no efficiency claim');
  const envelopeLevel = efficiency.eval_workload_envelope_level as Rec;
  assert.ok((envelopeLevel.modern as Rec).aggregate_bytes_ratio_not_a1 as number > 1, 'baseline records compact larger than fhir on the eval workload');
  assert.equal((envelopeLevel.modern as Rec).compact_over_fhir, undefined, 'P-12: the aggregate ratio is never named as an A1 ratio');
  const development = profile.development as Rec;
  assert.ok(((development.per_root_bytes as Rec).code as number) > 0, 'P-8: development per-root byte contributions recorded');
  assert.ok((development.expected_ratio_range as Rec).envelope_level_full_text, 'P-8: numerical expected ratio range recorded');
  // R2-1: the range is a simulated estimate, not preregistered and not a
  // development-corpus measurement; token ranges are unmeasured.
  const range = development.expected_ratio_range as Rec;
  assert.match(String(range.basis), /[Ss]imulated estimate/, 'R2-1: range relabelled as simulated estimate');
  assert.match(String(range.basis), /not a development-corpus measurement and not preregistered/, 'R2-1: range basis disclaims preregistration and development measurement');
  assert.ok(!String(range.basis).startsWith('Preregistered'), 'R2-1: no preregistered-expectation claim');
  assert.equal(range.expected_token_range, 'unmeasured', 'R2-1: expected token range unmeasured');
  assert.equal(development.expected_token_range, 'unmeasured', 'R2-1: development token range unmeasured');
  assert.match(String(range.slim_lane_simulated), /0\.919/, 'R2-1: slim-lane simulation recorded in the range');
  assert.match(String(range.slim_lane_simulated), /above the C\.1 0\.90 point target and unclaimed/);
  assert.equal((profile.preholdout_hashes as Rec).corpus_sha256, null, 'P-8: corpus hash is null until preregistration');
  const hosts = JSON.parse(readFileSync(join(process.cwd(), 'packages/core/src/data/host-profiles.json'), 'utf8')) as Rec;
  const { HOST_PROFILE_REGISTRY } = await import('../packages/core/src/delivery.js');
  assert.deepEqual(hosts.entries, [...HOST_PROFILE_REGISTRY], 'shipped registry stays zero verified cells');
  assert.deepEqual(hosts.entries, []);
  assert.match(String(hosts.status), /Zero verified structured-delivery cells/);
  assert.match(String(hosts.status), /G-HOST records real-host wire frames and transcripts for Claude Code 2\.1\.309/);
  assert.match(String(hosts.status), /synthetic fixture and HAPI FHIR 8\.12\.0/);
  assert.match(String(hosts.status), /smoke captures of the cffddc7 schema-0\.2 artifact/);
  assert.match(String(hosts.status), /not an approved paired wire\/model-input verification or a verified structured-delivery registry cell/);
  assert.match(String(hosts.status), /UNVERIFIED_DELIVERY_PROFILE/);
  assert.match(String(hosts.status), /UNVERIFIED_HOST_PROFILE and full-text-v1 remains the default/);
  const hostRecord = readFileSync(join(process.cwd(), 'docs/evidence/g-host-claude-code-2026-10-23.md'), 'utf8');
  assert.match(hostRecord, /Claude Code 2\.1\.309/);
  assert.match(hostRecord, /HAPI FHIR 8\.12\.0/);
  assert.match(hostRecord, /`cffddc7`/);
  for (const artifact of ['frames-in.jsonl', 'frames-out.jsonl', 'run1.jsonl']) {
    assert.equal(hostRecord.split(artifact).length - 1, 2, `${artifact}: both smoke runs recorded`);
  }
});

test('R2-1/R2-3: compact-profile source retains development figures and honest qualifications', () => {
  const compactText = readFileSync(join(process.cwd(), 'packages/core/src/data/compact-profiles.json'), 'utf8');
  const compact = JSON.parse(compactText) as Rec;
  const norm = (value: string): string => value.replace(/\s+/g, ' ');
  const profile = (compact.profiles as Rec[])[0]!;
  // S7 owns generated-document byte synchronization. Pin the authoritative
  // source directly here, independently of a duplicate draft's prose/figures.
  assert.equal(profile.recipe_id, LAB_EVIDENCE_RECIPE_ID);
  assert.deepEqual(profile.kept_roots, [...LAB_OBSERVATION_ROOTS]);
  const efficiency = profile.efficiency as Rec;
  const golden = efficiency.eval_golden_resource_level as Rec;
  for (const [key, bytes] of Object.entries({ raw_bytes: 22097, fhir_bytes: 22014, integrated_compact_bytes: 21817, lab_bytes: 20423, selected_bytes: 13771 })) {
    assert.equal(golden[key], bytes, `historical golden ${key}`);
  }
  assert.equal(golden.lab_over_fhir, 0.9277);
  assert.match(String(golden.source), /34 sanitized golden Observations.*2026-10-19/);
  const workload = efficiency.eval_workload_envelope_level as Rec;
  for (const [era, expected] of Object.entries({
    modern: { fhir_bytes: 266465, compact_bytes: 270607, selected_bytes: 234689, aggregate_bytes_ratio_not_a1: 1.0155 },
    legacy: { fhir_bytes: 260090, compact_bytes: 264232, selected_bytes: 228312, aggregate_bytes_ratio_not_a1: 1.0159 },
  })) {
    const row = workload[era] as Rec;
    assert.deepEqual(row, expected, `historical gate-F ${era} workload figures`);
  }
  assert.match(String(workload.source), /gate-F baseline 00bc792, 44 tasks/);
  assert.match(String(workload.source), /descriptive regression signal, not an A1 statistic/);
  const slimSim = efficiency.simulated_slim_text_20lab as Rec;
  assert.equal(slimSim.hardened_slim_text_bytes, 9087);
  assert.equal(slimSim.slim_lane_compact_over_fhir, 0.919);
  assert.match(String(slimSim.basis), /Simulated and host-dependent; not measured token savings and not claimed/);
  assert.match(String(slimSim.wire_savings_vs_full_text), /27–30% simulated/);
  assert.match(String(slimSim.model_visible_savings_vs_full_text), /24–27% simulated/);
  const range = (profile.development as Rec).expected_ratio_range as Rec;
  assert.equal(range.resource_level, '~0.85');
  assert.equal(range.envelope_level_full_text, '0.87-0.88');
  for (const phrase of [
    'not a development-corpus measurement and not preregistered',
    'simulated estimate',
    '≤0.90',
    '≤15%',
    'full fidelity',
    'per correctly answered lab question',
    '95% interval upper endpoint',
    'fidelity, task-success, and mutation gates',
    'above the C.1 0.90 point target and unclaimed',
  ]) {
    assert.ok(norm(compactText).includes(phrase), `source retains qualification: ${phrase}`);
  }
  assert.equal(range.expected_token_range, 'unmeasured');
  assert.equal((profile.development as Rec).expected_token_range, 'unmeasured');
  assert.ok(!compactText.includes('50%'), 'source carries no superseded within-product prior');
  assert.ok(!compactText.includes('fifty_percent_target'), 'superseded field absent');
});

test('S54 P correction: partial selection discloses present nested omissions and retains identity companion', () => {
  const record = recordFor('p-lab-lexeme');
  record.resource._id = { id: 'synthetic-id-companion' };
  const view = projectSanitized(record, 'fhir', ['code.coding.code', 'valueQuantity.value']);
  assert.deepEqual(view.resource._id, record.resource._id);
  assert.ok(view.meta.omitted_fields.includes('/code/coding/version'));
  assert.ok(view.meta.omitted_fields.includes('/code/coding/system'));
  assert.equal(at(view.resource, 'valueQuantity.comparator'), '>=', 'modifier meaning supplement survives partial selection');
  assert.ok(!view.meta.omitted_fields.includes('/valueQuantity/comparator'));
  assert.ok(view.meta.omitted_fields.includes('/valueQuantity/system'));
  assert.ok(!view.meta.omitted_fields.includes('/meta/versionId'));
  assert.ok(!view.meta.omitted_fields.includes('/code/coding/code'));
  assert.ok(!view.meta.omitted_fields.some(path => path.includes('lexeme')));
});

test('S54 P correction: selected local references preserve whole contained evidence and absent versions stay absent', () => {
  const record = recordFor('p-lab-context');
  delete (record.resource.meta as Rec).versionId;
  const view = projectSanitized(record, 'compact', ['specimen']);
  assert.equal(at(view.resource, 'specimen.reference'), '#sp1');
  assert.deepEqual(view.resource.contained, record.resource.contained);
  assert.equal(at(view.resource, 'meta.versionId'), undefined);
  assert.equal(retainedOmissions([record], 'compact')[0]!.version, undefined);
  assert.ok(!view.meta.omitted_fields.includes('/contained'));
});
