// Raw FHIR resources inside one arm's tool result, lossless-parsed, for the scorer's value, unit and time checks.
// Navigation mirrors servers/parsers.ts (shape only). Values are never changed.
import type { LosslessValue } from '../lib/json.js';
import { isFireboatArm, type ArmId, type CallRecord } from '../lib/types.js';
import { envelope } from '../servers/parsers.js';
import { isObj, resourcesOf, type Obj } from '../servers/items.js';
import { isWso2Arm } from '../servers/medplum.js';

/** Resources in a searchset Bundle or single resource, plus contained resources one level down. */
function withContained(list: Obj[]): Obj[] {
  const out: Obj[] = [];
  for (const r of list) {
    out.push(r);
    if (Array.isArray(r.contained)) for (const c of r.contained) if (isObj(c) && typeof c.resourceType === 'string') out.push(c);
  }
  return out;
}

export function rawResources(arm: ArmId, call: CallRecord): Obj[] {
  const env = envelope(call);
  if (!env.result) return [];
  const p = env.payload;
  let body: LosslessValue | undefined;
  if (isFireboatArm(arm)) {
    const data = isObj(p) && isObj(p.data) ? p.data : null;
    const list = data && Array.isArray(data.resources) ? data.resources.filter(isObj) : [];
    return withContained(list.filter(r => typeof r.resourceType === 'string'));
  }
  if (isWso2Arm(arm)) body = isObj(p) && 'result' in p ? p.result : p;
  else if (arm === 'M') {
    let q = p;
    if (isObj(q) && isObj(q.result) && !('response' in q) && !('error_message' in q)) q = q.result;
    body = isObj(q) ? q.response : undefined;
  } else if (arm === 'H') body = isObj(p) ? p.data : undefined;
  else if (arm === 'AH') {
    if (!isObj(p) || p.error === true) return [];
    // AH moves include-mode entries to `included` (type -> id -> resource); they are delivered too.
    const included: Obj[] = [];
    if (isObj(p.included)) for (const byId of Object.values(p.included)) if (isObj(byId)) for (const r of Object.values(byId)) if (isObj(r)) included.push(r);
    return withContained([...resourcesOf(p), ...included]);
  }
  return withContained(resourcesOf(body));
}
