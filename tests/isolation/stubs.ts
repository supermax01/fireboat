import type { Driver, Call } from './drivers.js';
import type { Backend } from './backend.js';
import { scenario, OracleFailure } from './scenarios.js';
const denied = (): Call => ({ envelope: { data: {}, error: { code: 'STUB_DENIED', safe_message: 'Verifier stub refusal' } } as Call['envelope'], wire: {}, bytes: 0 });
import { overblockingFeature } from './registry.js';
export { overblockingFeature } from './registry.js';
function blocked(feature: string, args: Record<string, unknown>, call?: Call): boolean {
  const pairs = (args.params ?? []) as { name: string; value: string }[];
  if (feature === 'arg:patient-selector') return pairs.some(p => ['patient', 'subject'].includes(p.name));
  if (feature === 'arg:reference-selector') return pairs.some(p => ['performer', 'link', 'encounter'].includes(p.name));
  if (feature === 'arg:directory-name') return pairs.some(p => p.name === 'name');
  if (feature === 'arg:code-parameter') return pairs.some(p => p.name === 'code');
  if (feature === 'arg:comma') return pairs.some(p => p.value.includes(','));
  if (feature === 'arg:percent') return pairs.some(p => p.value.includes('%'));
  if (feature === 'arg:backslash') return pairs.some(p => p.value.includes('\\'));
  if (feature === 'arg:pollution-punctuation') return pairs.some(p => /[&#%=]/.test(p.value));
  if (feature === 'arg:dotted-hyphenated-id') return /[.-]/.test(String(args.id ?? ''));
  if (feature === 'arg:source-alias') return args.source !== undefined;
  if (!call) return false;
  const e = call.envelope; const resources = (e.data.resources ?? []) as Record<string, unknown>[];
  if (feature === 'response:next-cursor') return Boolean(e.pagination?.next_cursor);
  if (feature === 'response:retained-handle') return Boolean(e.result?.handle);
  if (feature === 'response:active-patient') return resources.some(r => r.resourceType === 'Patient' && r.active === true);
  if (feature === 'response:contained-resource') return resources.some(r => r.contained !== undefined);
  if (feature === 'response:performer') return resources.some(r => r.performer !== undefined);
  if (feature === 'response:match-count') return (e.pagination?.returned_matches ?? 0) > 0;
  if (feature === 'response:attachment') return resources.some(r => r.presentedForm !== undefined);
  if (feature === 'response:source-outcome') return e.warnings.some(w => w.code === 'SOURCE_OUTCOME');
  if (feature === 'response:reviewed-discovery') return Array.isArray(e.data.searchParameters) && e.data.searchParameters.includes('code');
  if (feature === 'response:note') return resources.some(r => r.note !== undefined);
  if (feature === 'response:directory-identifier') return resources.some(r => r.identifier !== undefined);
  if (feature === 'response:directory-name') return resources.some(r => r.name !== undefined);
  if (feature === 'response:patient-reference') return resources.some(r => String(JSON.stringify(r.subject ?? r.patient)).includes('Patient/'));
  return false;
}
/** Each strengthened guard suppresses its minimal argument or response feature, never a whole tool. */
export interface StubReport { verdict: 'PASS' | 'FAIL'; kind: 'deny-all' | 'overblocking'; feature: string; specificity: 'feature'; blocked_calls: number; reason?: string; rejected_by?: string }
export async function challengeControl(id: string, kind: 'deny-all' | 'overblocking', actual: Driver, backend: Backend): Promise<StubReport> {
  const feature = overblockingFeature(id); let blockedCalls = 0;
  const stub: Driver = { ...actual, async call(name, args) {
    if (kind === 'deny-all' || blocked(feature, args)) { blockedCalls++; return denied(); }
    const response = await actual.call(name, args);
    if (blocked(feature, args, response)) { blockedCalls++; return denied(); }
    return response;
  } };
  try {
    await scenario(id, true, stub, backend);
    return { verdict: 'FAIL', kind, feature, specificity: 'feature', blocked_calls: blockedCalls, reason: 'positive control incorrectly accepted stub' };
  } catch (error) {
    if (!(error instanceof OracleFailure) || !blockedCalls) return { verdict: 'FAIL', kind, feature, specificity: 'feature', blocked_calls: blockedCalls, reason: 'stub did not fail a named control oracle' };
    return { verdict: 'PASS', kind, feature, specificity: 'feature', blocked_calls: blockedCalls, rejected_by: error.evidence.predicate };
  }
}
