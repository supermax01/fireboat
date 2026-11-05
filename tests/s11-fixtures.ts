import { EVAL_SOURCE_ALIAS } from '../packages/evals/src/fixture.js';
import type { CapturedCall } from '../scripts/s11/measure.js';
import type { Rec } from '../scripts/s11/study.js';
import type { ExportFile } from '../scripts/quickstart/transform-synthea.js';
export const patient = '00000000-0000-4000-8000-000000000001';
export const observation = '00000000-0000-4000-8000-000000000002';
export function observationRaw(id = observation): string {
  return `{"resourceType":"Observation","id":"${id}","status":"final","category":[{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/observation-category","code":"laboratory"}]}],"code":{"coding":[{"system":"http://loinc.org","code":"4548-4","display":"HbA1c"}],"text":"HbA1c full text"},"subject":{"reference":"Patient/${patient}"},"effectiveDateTime":"2025-01-01T00:00:00Z","valueQuantity":{"value":7.0,"comparator":"<","unit":"%","system":"http://unitsofmeasure.org","code":"%"},"referenceRange":[{"high":{"value":120.00,"unit":"%"}}]}`;
}
export function exportFiles(): ExportFile[] {
  const obs = observationRaw().replace(`Patient/${patient}`, `urn:uuid:${patient}`);
  const p = JSON.stringify({ resourceType: 'Patient', id: patient, identifier: [{ system: 'https://github.com/synthetichealth/synthea', value: patient }] });
  const condition = JSON.stringify({ resourceType: 'Condition', id: 'natural-condition', subject: { reference: `urn:uuid:${patient}` } });
  const entry = (raw: string) => `{"fullUrl":"urn:uuid:${(JSON.parse(raw) as Rec).id}","resource":${raw},"request":{"method":"POST","url":"unused"}}`;
  return [{ name: 'patient.json', bytes: Buffer.from(`{"resourceType":"Bundle","type":"transaction","entry":[${[p, obs, condition].map(entry).join(',')}]}`) },
    { name: 'hospitalInformation.json', bytes: Buffer.from(`{"resourceType":"Bundle","type":"batch","entry":[${entry('{"resourceType":"Organization","id":"unrelated-statewide-provider","name":"Synthetic Unrelated Provider"}')}]}`) }];
}
export function wireCall(raw = observationRaw(), step = 2, visible = raw): CapturedCall {
  const envelope = (body: string) => `{"schema_version":"0.3","source":{"alias":"${EVAL_SOURCE_ALIAS}"},"data":{"resources":[${body}]},"provenance":[{"resource_index":0,"retrieved_at":"2026-01-01T00:00:00Z"}],"transform":{"withheld_payloads":[]},"coverage":{"state":"complete_for_query"}}`;
  const rawResult = `{"content":[{"type":"text","text":${JSON.stringify(envelope(visible))}}],"structuredContent":${envelope(raw)}}`;
  return { task: 'test', arm: 'fhir', era: 'modern', step, tool: 'fhir_search', request: '{}', rawResult,
    wireResultBytes: Buffer.byteLength(rawResult), wireFrameBytes: Buffer.byteLength(rawResult) + 37 };
}
/**
 * A development-only natural-shaped chart (never a heldout or Synthea output): a non-fixture patient with `count`
 * in-window laboratory Observations, every fifth one an HbA1c, plus one laboratory component Observation, so the lab
 * trend drains several shorthand continuation pages at the S11 page size. Raw numeric spellings are kept verbatim.
 */
export function developmentChart(count = 44): string {
  const id = (n: number) => `00000000-0000-4000-8000-${String(100000 + n).padStart(12, '0')}`;
  const lab = '"category":[{"coding":[{"system":"http://terminology.hl7.org/CodeSystem/observation-category","code":"laboratory"}]}]';
  const lines = [`{"resourceType":"Patient","id":"${patient}"}`];
  for (let n = 0; n < count; n++) {
    const day = new Date(Date.UTC(2021, 0, 1 + n * 9)).toISOString().replace('.000Z', 'Z');
    const code = n % 5 === 0 ? '{"coding":[{"system":"http://loinc.org","code":"4548-4","display":"HbA1c"}],"text":"HbA1c"}'
      : '{"coding":[{"system":"http://loinc.org","code":"2345-7","display":"Glucose"}],"text":"Glucose"}';
    lines.push(`{"resourceType":"Observation","id":"${id(n)}","status":"final",${lab},"code":${code},"subject":{"reference":"Patient/${patient}"},"effectiveDateTime":"${day}","issued":"${day}","valueQuantity":{"value":${n % 2 ? '7.0' : '102.50'},"unit":"mg/dL","system":"http://unitsofmeasure.org","code":"mg/dL"},"referenceRange":[{"high":{"value":120.00,"unit":"mg/dL"}}]}`);
  }
  lines.push(`{"resourceType":"Observation","id":"${id(count)}","status":"final",${lab},"code":{"coding":[{"system":"http://loinc.org","code":"24331-1","display":"Lipid panel"}],"text":"Lipid panel"},"subject":{"reference":"Patient/${patient}"},"effectiveDateTime":"2025-06-01T08:00:00Z","component":[{"code":{"text":"HDL"},"valueQuantity":{"value":1.00,"unit":"mmol/L"}},{"code":{"text":"LDL"},"valueQuantity":{"value":2.50,"unit":"mmol/L"}}]}`);
  return `${lines.join('\n')}\n`;
}
