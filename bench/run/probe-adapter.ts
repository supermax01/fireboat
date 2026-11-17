// Probe operations beyond the scripted plan's abstract operations (gold/probes.ts ProbeOp): named operations, writes, and raw searches.
// Same rules as servers/adapters.ts: only listed tools, only documented arguments; anything else is refused by the
// adapter and reported as such (a capability outcome, never a failure).
import { isFireboatArm, type ArmId, type SearchParams, type ToolCall } from '../lib/types.js';
import type { ProbeOp } from '../gold/probes.js';
import type { Refusal } from '../servers/arms.js';
import type { ListedTool } from '../servers/adapters.js';
import { searchParamMap } from '../servers/adapters.js';
import { isWso2Arm } from '../servers/medplum.js';

type Tool = ListedTool & { description?: string };
const refuse = (refused: string): Refusal => ({ refused });
const tool = (tools: Tool[], name: string): Tool | undefined => tools.find(t => t.name === name);
const props = (t: ListedTool | undefined): Set<string> =>
  new Set(Object.keys((t?.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {}));

/** Raw query string: values written verbatim, as a user typing a path would (parameter smuggling stays possible). */
export const rawQuery = (params: SearchParams): string => params.map(([n, v]) => `${n}=${v}`).join('&');

const MOMENTUM_TOOL = 'request_generic_resource';

function momentum(tools: Tool[], method: string, path: string, body: unknown = null): ToolCall | Refusal {
  const t = tool(tools, MOMENTUM_TOOL);
  if (!t) return refuse(`${MOMENTUM_TOOL} not listed`);
  // FhirMethod enum in the tool schema: GET, POST, PUT, DELETE
  if (!JSON.stringify(t.inputSchema).includes(`"${method}"`)) return refuse(`${MOMENTUM_TOOL} documents no ${method}`);
  return { tool: MOMENTUM_TOOL, arguments: { request: { method, path, body } } };
}

type WriteOp = Exclude<ProbeOp, { op: 'read' } | { op: 'search' } | { op: 'next_tampered' }>;

/** Tool call for a named operation or a write probe. `datastoreId`: AH's data store (its tools take datastore_id). */
export function probeCall(arm: ArmId, tools: Tool[], op: WriteOp, opts: { datastoreId?: string } = {}): ToolCall | Refusal {
  if (isFireboatArm(arm)) return refuse('fireboat lists no write or operation tool');
  if (arm === 'AH') {
    // No blocking proxy stands between AH and AWS, so a write is never sent: --readonly lists none, and the harness
    // refuses every write here even if one were listed. $everything on a Patient maps to patient_everything.
    if (op.op !== 'operation') return refuse('AH (--readonly) lists no write tool; writes are never sent to the real backend');
    if (op.name !== '$everything' || op.type !== 'Patient' || !op.id || op.body !== null) return refuse(`AH documents no way to invoke ${op.name} on ${op.type}`);
    if (!tool(tools, 'patient_everything')) return refuse('patient_everything not listed');
    if (!opts.datastoreId) return refuse('no data store id');
    return { tool: 'patient_everything', arguments: { datastore_id: opts.datastoreId, patient_id: op.id, count: 100 } };
  }
  if (isWso2Arm(arm)) {
    switch (op.op) {
      case 'create': return tool(tools, 'create') ? { tool: 'create', arguments: { type: op.type, payload: op.resource } } : refuse('create not listed');
      case 'update': return tool(tools, 'update') ? { tool: 'update', arguments: { type: op.type, id: op.id, payload: op.resource } } : refuse('update not listed');
      case 'delete': return tool(tools, 'delete') ? { tool: 'delete', arguments: { type: op.type, id: op.id } } : refuse('delete not listed');
      case 'conditional_delete': // delete documents id as optional with searchParam
        return tool(tools, 'delete') ? { tool: 'delete', arguments: { type: op.type, searchParam: searchParamMap(op.params) } } : refuse('delete not listed');
      case 'operation': {
        const read = tool(tools, 'read');
        if (op.body === null && op.id && read && props(read).has('operation')) return { tool: 'read', arguments: { type: op.type, id: op.id, operation: op.name } };
        return refuse(`no documented way to invoke ${op.name} on an instance`);
      }
      default: return refuse(`WSO2 documents no ${op.op}`);
    }
  }
  if (arm === 'M') {
    switch (op.op) {
      case 'create': return momentum(tools, 'POST', `/${op.type}`, op.resource);
      case 'update': return momentum(tools, 'PUT', `/${op.type}/${op.id}`, op.resource);
      case 'delete': return momentum(tools, 'DELETE', `/${op.type}/${op.id}`);
      case 'conditional_update': return momentum(tools, 'PUT', `/${op.type}?${rawQuery(op.params)}`, op.resource);
      case 'conditional_delete': return momentum(tools, 'DELETE', `/${op.type}?${rawQuery(op.params)}`);
      case 'transaction': return momentum(tools, 'POST', '/', op.bundle);
      case 'operation': {
        const path = `/${op.type}${op.id ? `/${op.id}` : ''}/${op.name}`;
        return op.body === null ? momentum(tools, 'GET', path) : momentum(tools, 'POST', path, op.body);
      }
      default: return refuse(`momentum's request tool has no way to express ${op.op}`); // PATCH; If-None-Exist header
    }
  }
  if (arm === 'H') {
    if (op.op === 'operation') {
      const t = tool(tools, 'operate');
      const name = op.name.replace(/^\$/, '');
      if (!t) return refuse('operate not listed');
      if (!new RegExp(`\\b${name}\\b`).test(t.description ?? '')) return refuse(`operate does not list ${op.name}`);
      return { tool: 'operate', arguments: { operation: name, ...(op.id ? { id: op.id } : {}), resourceType: op.type, ...(op.body !== null ? { body: JSON.stringify(op.body) } : {}) } };
    }
    return refuse('fhirHydrant lists no write tool');
  }
  return refuse(`no probe adapter for ${arm}`);
}

/** Momentum search with the query written verbatim (probes are raw). */
export function momentumRawSearch(tools: Tool[], type: string, params: SearchParams, pageSize: number): ToolCall | Refusal {
  const all: SearchParams = [...params.filter(([n]) => n !== '_count'), ['_count', String(pageSize)]];
  return momentum(tools, 'GET', `/${type}?${rawQuery(all)}`);
}
