// Per-arm scripted adapters: turn each abstract operation into a call to one of the server's own tools.
// Built only from the tools the server listed. Abstract params are FHIR search parameters, ordered and repeatable.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { results } from '../lib/paths.js';
import { isFireboatArm, type ArmId, type Cell, type ParsedResult, type SearchParams, type ToolCall } from '../lib/types.js';
import type { Adapter, Refusal } from './arms.js';

export interface ListedTool { name: string; inputSchema: unknown }

export interface AdapterOptions {
  cell: Cell;
  /** The run's patient (Patient.id). fireboat binds it by configuration, so its adapter omits the matching selector. */
  patientId: string;
  /** Next-link replay variant (W, M): rebuild a next request from a returned next link. Off in the default cell. */
  replay?: boolean;
  /** AH: the HealthLake data store id every data-plane tool takes as datastore_id (servers/healthlake.ts datastoreIdFor). */
  datastoreId?: string;
}

/** fireboat's maximum page_size (the fhir_search input schema in packages/core/src/contracts.ts; the same in FB0). */
export const FIREBOAT_PAGE_SIZE = 100;

/** HAPI's recorded max_page_size (manifests/infra.json, `hapi.max_page_size`), the page size for W, M and H. */
export function hapiMaxPageSize(): number {
  const m = JSON.parse(readFileSync(join(results.manifests, 'infra.json'), 'utf8')) as Record<string, unknown>;
  const candidates = [m['hapi.max_page_size'], (m.hapi as Record<string, unknown> | undefined)?.max_page_size,
    (m.hapi_settings as Record<string, unknown> | undefined)?.['hapi.fhir.max_page_size']];
  for (const c of candidates) if (typeof c === 'number' && Number.isInteger(c) && c > 0) return c;
  throw new Error('manifests/infra.json has no hapi.max_page_size');
}

/** HealthLake's maximum page size (_count above 100 is invalid), the AH tools' count maximum. */
export const HEALTHLAKE_PAGE_SIZE = 100;

/**
 * Page size each arm asks for. Ws and Wm ask for W's page size, so the three WSO2 rows compare.
 * AH: HealthLake's maximum (100), which equals fireboat's.
 */
export const pageSizeFor = (arm: ArmId): number => (isFireboatArm(arm) ? FIREBOAT_PAGE_SIZE : arm === 'AH' ? HEALTHLAKE_PAGE_SIZE : hapiMaxPageSize());

const refuse = (refused: string): Refusal => ({ refused });
const hasTool = (tools: ListedTool[], name: string) => tools.some(t => t.name === name);
const propsOf = (t: ListedTool | undefined): Set<string> => {
  const s = t?.inputSchema as { properties?: Record<string, unknown> } | undefined;
  return new Set(Object.keys(s?.properties ?? {}));
};
const isOwnPatient = (value: string, patientId: string) => value === `Patient/${patientId}` || value === patientId;

// ---- FB0 ----------------------------------------------------------------------------------------------------

function fireboatAdapter(tools: ListedTool[], o: AdapterOptions): Adapter {
  const need = (name: string) => (hasTool(tools, name) ? null : refuse(`${name} not listed`));
  return {
    capabilities(type) {
      return need('fhir_capabilities') ?? { tool: 'fhir_capabilities', arguments: type ? { topic: 'resource', resource_type: type } : { topic: 'server' } };
    },
    read(type, id) {
      return need('fhir_read') ?? { tool: 'fhir_read', arguments: { resource_type: type, id } };
    },
    search(type, params, pageSize) {
      const missing = need('fhir_search');
      if (missing) return missing;
      let size = pageSize;
      const pairs: { name: string; value: string }[] = [];
      for (const [name, value] of params) {
        if ((name === 'patient' || name === 'subject') && isOwnPatient(value, o.patientId)) continue; // bound by configuration
        if (name === '_count') { size = Math.min(Number(value), FIREBOAT_PAGE_SIZE); continue; } // documented equivalent: page_size
        pairs.push({ name, value });
      }
      return { call: { tool: 'fhir_search', arguments: { resource_type: type, params: pairs, page_size: size } }, flags: [] };
    },
    next(prev: ParsedResult) {
      if (!hasTool(tools, 'fhir_page')) return { cannot_continue: 'fhir_page not listed' };
      return prev.page_handle ? { tool: 'fhir_page', arguments: { cursor: prev.page_handle } } : { cannot_continue: 'no next_cursor' };
    },
  };
}

// ---- W ------------------------------------------------------------------------------------------------------

/** FHIR params as WSO2's searchParam map: repeated names become arrays, order within a name kept. */
export function searchParamMap(params: SearchParams): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of params) {
    const cur = out[name];
    out[name] = cur === undefined ? value : Array.isArray(cur) ? [...cur, value] : [cur, value];
  }
  return out;
}

function withStandardLevers(params: SearchParams, pageSize: number, cell: Cell): SearchParams {
  const out: SearchParams = params.filter(([n]) => n !== '_count');
  out.push(['_count', String(pageSize)]);
  if (cell === 'best_effort' && !out.some(([n]) => n === '_total')) out.push(['_total', 'accurate']);
  return out;
}

/** Query params of a next link, in order. */
function linkParams(url: string): { path: string; params: SearchParams } {
  const u = new URL(url);
  return { path: u.pathname, params: [...u.searchParams.entries()] };
}

function wso2Adapter(tools: ListedTool[], o: AdapterOptions): Adapter {
  let lastType: string | null = null;
  const need = (name: string) => (hasTool(tools, name) ? null : refuse(`${name} not listed`));
  return {
    capabilities(type) {
      if (!type) return refuse('get_capabilities requires a resource type');
      return need('get_capabilities') ?? { tool: 'get_capabilities', arguments: { type } };
    },
    read(type, id) {
      return need('read') ?? { tool: 'read', arguments: { type, id } };
    },
    search(type, params, pageSize) {
      const missing = need('search');
      if (missing) return missing;
      lastType = type;
      return { call: { tool: 'search', arguments: { type, searchParam: searchParamMap(withStandardLevers(params, pageSize, o.cell)) } }, flags: [] };
    },
    next(prev) {
      if (!o.replay) return { cannot_continue: 'WSO2 documents no paging mechanism' };
      if (!prev.page_handle || !lastType) return { cannot_continue: 'no next link' };
      return { tool: 'search', arguments: { type: lastType, searchParam: searchParamMap(linkParams(prev.page_handle).params) } };
    },
  };
}

// ---- M ------------------------------------------------------------------------------------------------------

const MOMENTUM_TOOL = 'request_generic_resource';
const MOMENTUM_BASE_PATH = '/fhir'; // FHIR_BASE_URL in the arm's environment

export const queryString = (params: SearchParams): string =>
  params.map(([n, v]) => `${encodeURIComponent(n)}=${encodeURIComponent(v)}`).join('&');

function momentumAdapter(tools: ListedTool[], o: AdapterOptions): Adapter {
  const get = (path: string): ToolCall | Refusal =>
    hasTool(tools, MOMENTUM_TOOL) ? { tool: MOMENTUM_TOOL, arguments: { request: { method: 'GET', path } } } : refuse(`${MOMENTUM_TOOL} not listed`);
  return {
    capabilities() { return get('/metadata'); },
    read(type, id) { return get(`/${type}/${encodeURIComponent(id)}`); },
    search(type, params, pageSize) {
      const call = get(`/${type}?${queryString(withStandardLevers(params, pageSize, o.cell))}`);
      return 'refused' in call ? call : { call, flags: [] };
    },
    next(prev) {
      if (!o.replay) return { cannot_continue: 'momentum documents no paging mechanism' };
      if (!prev.page_handle) return { cannot_continue: 'no next link' };
      const u = new URL(prev.page_handle);
      const rel = u.pathname.startsWith(MOMENTUM_BASE_PATH) ? u.pathname.slice(MOMENTUM_BASE_PATH.length) : u.pathname;
      const c = get(`${rel}${u.search}`);
      return 'refused' in c ? { cannot_continue: c.refused } : c;
    },
  };
}

// ---- H ------------------------------------------------------------------------------------------------------

/** Documented equivalents in fhirHydrant's resource tools ("subject ... equivalent to patient"). */
const HYDRANT_EQUIVALENTS: Record<string, string[]> = { subject: ['patient'], patient: ['subject'] };

function hydrantAdapter(tools: ListedTool[], o: AdapterOptions): Adapter {
  const toolFor = (type: string) => tools.find(t => t.name === type.toLowerCase());
  return {
    capabilities() {
      return hasTool(tools, 'capabilities') ? { tool: 'capabilities', arguments: {} } : refuse('capabilities not listed');
    },
    read(type, id) {
      const t = toolFor(type);
      if (!t) return refuse(`no fhirHydrant tool for ${type}`);
      return { tool: t.name, arguments: propsOf(t).has('action') ? { action: 'read', _id: id } : { _id: id } };
    },
    search(type, params, pageSize) {
      const t = toolFor(type);
      if (!t) return refuse(`no fhirHydrant tool for ${type}`);
      const props = propsOf(t);
      const args: Record<string, unknown> = props.has('action') ? { action: 'search' } : {};
      const flags: string[] = [];
      for (const [name, value] of params) {
        if (name === '_count') continue;
        const target = [name, ...(HYDRANT_EQUIVALENTS[name] ?? [])].find(n => props.has(n) && args[n] === undefined);
        if (target) args[target] = value;
        else flags.push(`param_dropped:${name}`); // not in the tool's schema, or repeated (one string per parameter)
      }
      if (props.has('_count')) args._count = String(pageSize);
      return { call: { tool: t.name, arguments: args }, flags };
    },
    next(prev) {
      if (!hasTool(tools, 'paginate')) return { cannot_continue: 'paginate not listed' };
      return prev.page_handle ? { tool: 'paginate', arguments: { url: prev.page_handle } } : { cannot_continue: 'no continuation url' };
    },
  };
}

// ---- AH: AWS HealthLake MCP server 0.0.21 (--readonly) ----------------------------------------------------------

/**
 * AH tools: read_fhir_resource, search_fhir_resources, patient_everything; each takes datastore_id. search_params is a
 * name -> value map (a list value is joined with commas, which FHIR reads as OR), so a repeated parameter (a date range
 * written as two date parameters) cannot be expressed: the first value is kept and the rest dropped with
 * param_dropped:<name>. Chained names ("a.b") go to chained_params, _include and _revinclude to
 * their lists, _count to count. Paging: only the opaque pagination.next_token, on the tool that produced it.
 * No tool returns a CapabilityStatement (get_datastore_details describes the data store), so capabilities is refused.
 */
function healthlakeMcpAdapter(tools: ListedTool[], o: AdapterOptions): Adapter {
  const ds = o.datastoreId;
  if (!ds) throw new Error('arm AH needs the HealthLake data store id (AdapterOptions.datastoreId)');
  const need = (name: string) => (hasTool(tools, name) ? null : refuse(`${name} not listed`));
  let last: { tool: 'search_fhir_resources'; type: string } | null = null;
  return {
    capabilities() {
      return refuse('AH lists no CapabilityStatement tool (get_datastore_details describes the data store, not FHIR capabilities)');
    },
    read(type, id) {
      return need('read_fhir_resource') ?? { tool: 'read_fhir_resource', arguments: { datastore_id: ds, resource_type: type, resource_id: id } };
    },
    search(type, params, pageSize) {
      const missing = need('search_fhir_resources');
      if (missing) return missing;
      const flags: string[] = [];
      const searchParams: Record<string, string> = {};
      const chained: Record<string, string> = {};
      const include: string[] = [];
      const revinclude: string[] = [];
      let count = Math.min(pageSize, HEALTHLAKE_PAGE_SIZE);
      for (const [name, value] of params) {
        if (name === '_count') { count = Math.max(1, Math.min(Number(value), HEALTHLAKE_PAGE_SIZE)); continue; }
        if (name === '_include') { include.push(value); continue; }
        if (name === '_revinclude') { revinclude.push(value); continue; }
        const target = name.includes('.') ? chained : searchParams;
        if (target[name] !== undefined) { flags.push(`param_dropped:${name}`); continue; } // repeated: not expressible
        target[name] = value;
      }
      last = { tool: 'search_fhir_resources', type };
      return {
        call: { tool: 'search_fhir_resources', arguments: {
          datastore_id: ds, resource_type: type,
          ...(Object.keys(searchParams).length ? { search_params: searchParams } : {}),
          ...(Object.keys(chained).length ? { chained_params: chained } : {}),
          ...(include.length ? { include_params: include } : {}),
          ...(revinclude.length ? { revinclude_params: revinclude } : {}),
          count,
        } },
        flags,
      };
    },
    next(prev) {
      if (!prev.page_handle) return { cannot_continue: 'no pagination.next_token' };
      if (!last) return { cannot_continue: 'no search to continue' };
      return { tool: last.tool, arguments: { datastore_id: ds, resource_type: last.type, next_token: prev.page_handle } };
    },
  };
}

const FACTORIES: Partial<Record<ArmId, (tools: ListedTool[], o: AdapterOptions) => Adapter>> = {
  FB0: fireboatAdapter, FB: fireboatAdapter, FBd: fireboatAdapter, FBt: fireboatAdapter, W: wso2Adapter, Ws: wso2Adapter, Wm: wso2Adapter, M: momentumAdapter, H: hydrantAdapter,
  FBh: fireboatAdapter, FBdh: fireboatAdapter, AH: healthlakeMcpAdapter,
};

/** One adapter per run: W's replay variant keeps the last searched type. */
export function makeAdapter(arm: ArmId, tools: ListedTool[], o: AdapterOptions): Adapter {
  const f = FACTORIES[arm];
  if (!f) throw new Error(`no adapter for arm ${arm}`);
  return f(tools, o);
}
