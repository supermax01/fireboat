import type { EvalTask, EvalStep } from '../../packages/evals/src/tasks.js';
import type { Check } from '../../packages/evals/src/check-contracts.js';
import { STUDY, rec, requireS11, type Rec } from './study.js';

// Frozen independently of the implementation's recipe constants. Complete values, coding.text and component
// association are compared; no numeric tolerance, omitted reference ranges or cherry-picked scalar values.
export const CRITICAL_ROOTS = ['resourceType', 'id', 'status', 'category', 'code', 'subject', 'focus', 'issued',
  'dataAbsentReason', 'interpretation', 'bodySite', 'method', 'specimen', 'device', 'referenceRange', 'hasMember',
  'derivedFrom', 'component', 'modifierExtension', 'implicitRules', 'contained', 'meta.versionId', 'meta.profile', 'meta.security'] as const;
export const SELECTED_FIELDS = ['status', 'category', 'code', 'subject', 'focus', 'effectiveDateTime', 'effectivePeriod', 'effectiveInstant', 'issued', 'valueQuantity', 'valueCodeableConcept', 'valueString',
  'dataAbsentReason', 'interpretation', 'bodySite', 'method', 'specimen', 'device', 'referenceRange', 'hasMember', 'derivedFrom', 'component', 'encounter', 'note'];
export interface TaskPlan { template: typeof STUDY.templates[number]; task: EvalTask; expected: Rec[]; evidenceStep: number; unsupported?: string;
  recovery?: { expected: Rec; step: number }; retainedChecks?: Check[] }
const coding = (r: Rec, system: string, code: string): boolean => {
  const value = rec(r.code); return Array.isArray(value?.coding) && value.coding.some(c => rec(c)?.system === system && rec(c)?.code === code);
};
export function makePlans(ndjson: string, label: string): TaskPlan[] {
  const resources = ndjson.trimEnd().split('\n').map(line => JSON.parse(line) as Rec);
  const observations = resources.filter(r => r.resourceType === 'Observation');
  const byId = new Map(resources.map(r => [`${r.resourceType}/${r.id}`, r]));
  const dates = [{ name: 'date', value: `ge${STUDY.window.start}` }, { name: 'date', value: `lt${STUDY.window.end}` }];
  const discovery: EvalStep[] = [
    { tool: 'fhir_capabilities', input: { topic: 'support', resource_type: 'Observation' }, drainPages: false },
    { tool: 'fhir_capabilities', input: { topic: 'search_parameter', resource_type: 'Observation', name: 'date' }, drainPages: false },
  ];
  const search = (params: Rec[], sort?: string[]): EvalStep => ({ tool: 'fhir_search', input: { resource_type: 'Observation',
    params: [...params, ...dates, ...(sort ? [{ name: '_sort', value: sort.join(',') }] : [])], page_size: STUDY.operatingPoint.pageSize }, drainPages: true });
  const base = (template: TaskPlan['template'], steps: EvalStep[], expected: Rec[], evidenceStep: number): TaskPlan => {
    const checks: Check[] = [{ kind: 'resourceIdSet', id: 'complete-membership', step: evidenceStep, equals: expected.map(r => String(r.id)) }];
    return { template, expected, evidenceStep, task: { id: `${label}-${template}`, category: 's11-natural', question: template,
      corpus: 'baseline', steps: [...discovery, ...steps], fields: [...SELECTED_FIELDS], checks,
      perCallBytes: STUDY.operatingPoint.perCallBytes,
      budget: { maxBytes: STUDY.operatingPoint.taskBytes, maxToolCalls: STUDY.operatingPoint.toolCalls, maxUpstreamCalls: STUDY.operatingPoint.upstreamCalls } } };
  };
  const trend = base('lab-trend', [search([{ name: 'category', value: 'http://terminology.hl7.org/CodeSystem/observation-category|laboratory' }])], observations, 2);
  const hba = observations.filter(r => coding(r, 'http://loinc.org', '4548-4'));
  const recent = base('recent-hba1c', [search([{ name: 'code', value: 'http://loinc.org|4548-4' }], ['-date'])], hba, 2);
  if (!hba.length) recent.unsupported = 'NO_NATURAL_HBA1C';
  // Component Observation first; otherwise the first natural multi-result DiagnosticReport. No constructed panels.
  const panels = observations.filter(r => Array.isArray(r.component) && r.component.length > 0).sort(byIdentity);
  const reports = resources.filter(r => r.resourceType === 'DiagnosticReport' && Array.isArray(r.result) && r.result.length >= 2
    && r.result.every(v => typeof rec(v)?.reference === 'string' && byId.get(String(rec(v)!.reference))?.resourceType === 'Observation')).sort(byIdentity);
  const panel = panels[0] ?? reports[0];
  const expected = panel ? [panel] : [];
  const panelSteps: EvalStep[] = panel ? [{ tool: 'fhir_read', input: { resource_type: panel.resourceType, id: panel.id } },
    { tool: 'fhir_result', input: { action: 'inspect', handle: '{{handle:2}}', offset: 0, limit: 1 } },
    { tool: 'fhir_result', input: { action: 'project', handle: '{{handle:2}}', offset: 0, limit: 1, fields: [...SELECTED_FIELDS, 'result', 'conclusion', 'conclusionCode'] } }] : [];
  const recovery = base('panel-recovery', panelSteps, expected, 2);
  if (!panel) recovery.unsupported = 'NO_NATURAL_PANEL';
  else {
    recovery.task.fields = [...SELECTED_FIELDS, 'result', 'conclusion', 'conclusionCode', 'presentedForm'];
    recovery.recovery = { expected: panel, step: 4 };
    // The legacy eval JSON parser does not admit the packaging kernel's retainedSlice vocabulary.
    // Keep these extra checks in S11's plan and judge them independently at both captured boundaries.
    recovery.retainedChecks = [{ kind: 'retainedSlice', id: 'inspect-issuing-result', step: 3, from_step: 2, view: 'omissions', offset: 0, limit: 1, whole_count: true },
      { kind: 'retainedSlice', id: 'recover-issuing-result', step: 4, from_step: 2, view: 'resources', action: 'project', offset: 0, limit: 1 }];
    if (panel.resourceType === 'DiagnosticReport') {
      for (const ref of panel.result as Rec[]) {
        const member = byId.get(String(ref.reference))!;
        recovery.task.steps.push({ tool: 'fhir_read', input: { resource_type: 'Observation', id: member.id } });
        // Membership/fidelity for each member is separately bound by the harness to its own read step.
      }
    }
  }
  requireS11(new Set(resources.map(r => `${r.resourceType}/${r.id}`)).size === resources.length, 'TASK_CORPUS_DUPLICATE');
  return [trend, recent, recovery];
}
const byIdentity = (a: Rec, b: Rec): number => `${a.resourceType}/${a.id}` < `${b.resourceType}/${b.id}` ? -1 : 1;

/** Exact numeric tokens using the host JSON parser's source context, independent of core decimal/projection helpers. */
export function numericTokens(raw: string): { path: string; lexeme: string }[] {
  class Token { constructor(readonly text: string) {} }
  const parsed = JSON.parse(raw, (_key: string, value: unknown, context?: { source?: string }) => {
    if (typeof value !== 'number') return value;
    requireS11(context?.source !== undefined, 'LEXICAL_RUNTIME_MISSING'); return new Token(context.source);
  });
  const out: { path: string; lexeme: string }[] = [];
  const visit = (node: unknown, path: string): void => {
    if (node instanceof Token) { out.push({ path, lexeme: node.text }); return; }
    if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) visit(v, path ? `${path}.${k}` : k);
  };
  visit(parsed, ''); return out;
}
