import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { lintFixturePlacement } from './scanners.js';
import { A, B, SECRET, CONTROL, FIXED_TIME, MRN, CREDENTIAL } from './canaries.js';
export type Resource = Record<string, unknown> & { resourceType: string; id: string };
export type Pair = { name: string; value: string };
export type Entry = { resource: Resource | Record<string, unknown>; search?: { mode: string }; fullUrl?: unknown };
export interface RequestRecord { sequence: number; method: string; raw_target: string; destination: 'source' | 'sink'; phase: 'setup' | 'target'; kind: 'metadata' | 'clinical' | 'sink' | 'probe' | 'auth'; pairs: Pair[]; credential_fingerprint: string | null }
export interface Behavior {
  subjectOnly?: boolean; declared?: Record<string, string[]>; metadataProse?: string; hostileName?: string;
  records?: Resource[]; pages?: Entry[][]; next?: 'normal' | 'foreign' | 'foreign-path' | 'protocol-relative' | 'relative' | 'drop-patient' | 'drop-id' | 'sibling' | 'encoded' | 'opaque' | 'opaque-conflict';
  self?: 'encoded'; read?: Record<string, { status?: number; body?: unknown; raw?: string | Buffer; contentType?: string; encoding?: string; redirect?: boolean }>;
  redirectPage?: boolean; total?: number; outcome?: { severity: string; code: string; diagnostics?: string; details?: unknown; expression?: string[] };
  fullUrlForeign?: boolean; missingReference?: '404' | 'information';
}
export const observation = (id = 'obs-a.1-x', patient = A, extra: Record<string, unknown> = {}): Resource => ({
  resourceType: 'Observation', id, meta: { versionId: '1', lastUpdated: FIXED_TIME }, status: 'final',
  code: { coding: [{ system: 'http://loinc.org', code: '4548-4' }] }, subject: { reference: `Patient/${patient}` },
  effectiveDateTime: FIXED_TIME, valueQuantity: { value: 7.2, unit: '%' }, note: [{ text: patient === A ? CONTROL : SECRET }], ...extra,
});
export const patient = (id = A, extra: Record<string, unknown> = {}): Resource => ({ resourceType: 'Patient', id, active: true, name: [{ text: id === A ? CONTROL : SECRET }], identifier: [{ system: MRN, value: id === A ? 'synthetic-mrn-a' : SECRET }], ...extra });
export const practitioner = (): Resource => ({ resourceType: 'Practitioner', id: 'directory-1', name: [{ text: 'Synthetic Directory' }], identifier: [{ system: 'http://hl7.org/fhir/sid/us-npi', value: '1000000001' }] });
export const entries = (...resources: Resource[]): Entry[] => resources.map(resource => ({ resource, search: { mode: 'match' } }));
const fingerprint = (value: string) => createHash('sha256').update(value).digest('hex');
export async function startBackend() {
  let base = ''; let sinkUrl = ''; let behavior: Behavior = {}; let phase: 'setup' | 'target' = 'setup';
  let held: { enter: () => void; wait: Promise<void> } | undefined;
  const requests: RequestRecord[] = []; const mutations: string[] = []; const opaqueLedger = new Map<string, number>();
  const db = () => behavior.records ?? [patient(), patient(B), observation(), observation(`obs-${B}`, B), practitioner(), { resourceType: 'CodeSystem', id: 'catalog-1', status: 'active', content: 'complete', url: 'urn:synthetic:catalog', version: '1', concept: [{ code: '4548-4', display: CONTROL }] }];
  const record = (req: import('node:http').IncomingMessage, destination: 'source' | 'sink') => {
    const url = new URL(req.url!, destination === 'sink' ? sinkUrl : base);
    requests.push({ sequence: requests.length, method: req.method ?? 'UNKNOWN', raw_target: req.url!, destination, phase,
      kind: destination === 'sink' || url.pathname.startsWith('/admin') ? 'sink' : url.pathname === '/token' ? 'auth' : url.pathname.endsWith('/metadata') ? 'metadata' : url.pathname === '/__probe' ? 'probe' : 'clinical',
      pairs: [...url.searchParams].map(([name, value]) => ({ name, value })), credential_fingerprint: req.headers.authorization ? fingerprint(req.headers.authorization) : null });
    if (req.method !== 'GET' && url.pathname !== '/token') mutations.push(`${phase}:${destination}:${req.method}:${url.pathname}`);
    return url;
  };
  const sink = createServer((req, res) => { record(req, 'sink'); res.end('{}'); });
  const source = createServer(async (req, res) => {
    const url = record(req, 'source'); res.setHeader('content-type', 'application/fhir+json');
    const send = (body: unknown) => res.end(JSON.stringify(body));
    if (requests.at(-1)!.kind === 'clinical' && held) { const gate = held; held = undefined; gate.enter(); await gate.wait; }
    if (url.pathname === '/token') { send({ access_token: CREDENTIAL, token_type: 'Bearer', expires_in: 900 }); return; }
    if (url.pathname === '/__probe') { send({ ok: true }); return; }
    if (url.pathname.startsWith('/admin')) { send({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'forbidden' }] }); return; }
    if (url.pathname.endsWith('/metadata')) {
      const defaults: Record<string, string[]> = {
        Observation: [behavior.subjectOnly ? 'subject' : 'patient', 'code', 'date', 'performer', 'focus', 'encounter'],
        Patient: ['_id', 'link', 'organization'], Practitioner: ['name', '_has:Observation:performer:code', 'organization.name', '_include', '_filter'],
        DiagnosticReport: ['patient', 'code'], CodeSystem: ['code'], Organization: ['name'], Location: ['name'],
      };
      const declared = { ...defaults, ...behavior.declared };
      send({ resourceType: 'CapabilityStatement', status: 'active', kind: 'instance', fhirVersion: '4.0.1', format: ['json'], description: behavior.metadataProse,
        rest: [{ mode: 'server', resource: Object.entries(declared).map(([type, names]) => ({ type, interaction: [{ code: 'read' }, { code: 'search-type' }],
          searchParam: [...names, ...(behavior.hostileName ? [behavior.hostileName] : [])].map(name => ({ name, type: ['patient', 'subject', 'performer', 'link', 'organization', 'focus', 'encounter'].includes(name) ? 'reference' : name === 'date' ? 'date' : name === 'name' ? 'string' : 'token', documentation: behavior.metadataProse })), documentation: behavior.metadataProse })) }] }); return;
    }
    const parts = url.pathname.replace(/^\/fhir\//, '').split('/');
    if (parts.length === 2) {
      const key = parts.join('/'); const fault = behavior.read?.[key];
      if (fault) {
        res.statusCode = fault.status ?? 200;
        if (fault.redirect) { res.statusCode = 302; res.setHeader('location', `${sinkUrl}credential-sink`); }
        if (fault.contentType) res.setHeader('content-type', fault.contentType);
        if (fault.encoding) res.setHeader('content-encoding', fault.encoding);
        if (fault.raw !== undefined) res.end(fault.raw); else send(fault.body ?? { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'not-found' }] }); return;
      }
      const resource = db().find(r => `${r.resourceType}/${r.id}` === key);
      if (!resource) { res.statusCode = 404; send({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'not-found', diagnostics: SECRET }] }); }
      else send(resource); return;
    }
    let page = Number(url.searchParams.get('_offset') ?? 0);
    if (url.searchParams.has('_getpages')) page = opaqueLedger.get(url.searchParams.get('_getpages')!) ?? 1;
    if (behavior.redirectPage && page > 0) { res.statusCode = 302; res.setHeader('location', `${sinkUrl}credential-sink`); send({}); return; }
    const type = parts[0] || 'Observation';
    let selected = db().filter(r => r.resourceType === type);
    if (!behavior.pages) for (const [name, value] of url.searchParams) {
      if (name === '_id') selected = selected.filter(r => value.split(',').includes(r.id));
      if (name === 'patient' || name === 'subject') selected = selected.filter(r => ((r.subject ?? r.patient) as { reference?: string })?.reference === (value.startsWith('Patient/') ? value : `Patient/${value}`));
    }
    let pageEntries: Entry[] = behavior.pages?.[page] ?? entries(...selected);
    if (behavior.fullUrlForeign) pageEntries = pageEntries.map(e => ({ ...e, fullUrl: `${sinkUrl}${e.resource.resourceType}/${e.resource.id}` }));
    if (behavior.outcome) pageEntries = [...pageEntries, { resource: { resourceType: 'OperationOutcome', issue: [behavior.outcome] }, search: { mode: 'outcome' } }];
    if (behavior.missingReference && url.searchParams.has('encounter')) {
      if (behavior.missingReference === '404') { res.statusCode = 404; send({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'not-found', diagnostics: SECRET }] }); return; }
      pageEntries.push({ resource: { resourceType: 'OperationOutcome', issue: [{ severity: 'information', code: 'not-found', diagnostics: SECRET }] }, search: { mode: 'outcome' } });
    }
    const self = new URL(url); if (behavior.self === 'encoded') self.pathname = '/fhir/%5cadmin/Observation';
    const links: { relation: string; url: string }[] = [{ relation: 'self', url: self.href }];
    if (behavior.pages && page < behavior.pages.length - 1) {
      const next = new URL(url); next.searchParams.set('_offset', String(page + 1));
      switch (behavior.next) {
        case 'foreign': next.href = new URL(next.pathname + next.search, sinkUrl).href; break;
        case 'foreign-path': next.href = `${sinkUrl}next`; break;
        case 'protocol-relative': next.href = new URL(next.pathname + next.search, sinkUrl).href; break;
        case 'relative': next.pathname = '/admin/Observation'; break;
        case 'drop-patient': next.searchParams.delete('patient'); next.searchParams.delete('subject'); break;
        case 'drop-id': next.searchParams.delete('_id'); break;
        case 'sibling': next.pathname = '/fhir-sibling/Observation'; break;
        case 'encoded': next.pathname = '/fhir/%5cadmin/Observation'; break;
        case 'opaque': case 'opaque-conflict': {
          next.pathname = '/fhir/'; next.search = ''; const token = `synthetic-token-${page + 1}`; opaqueLedger.set(token, page + 1); next.searchParams.set('_getpages', token);
          if (behavior.next === 'opaque-conflict') next.searchParams.set('patient', `Patient/${B}`); break;
        }
      }
      links.push({ relation: 'next', url: behavior.next === 'protocol-relative' ? next.href.replace(/^http:/, '') : behavior.next === 'relative' ? `../admin/Observation${next.search}` : next.href });
    }
    send({ resourceType: 'Bundle', type: 'searchset', total: behavior.total ?? (behavior.pages ? behavior.pages.flat().length : selected.length), link: links, entry: pageEntries });
  });
  const listen = async (server: Server) => { await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); return (server.address() as { port: number }).port; };
  sinkUrl = `http://127.0.0.1:${await listen(sink)}/`; base = `http://127.0.0.1:${await listen(source)}/fhir/`;
  return {
    base, sinkUrl, requests, mutations, opaqueLedger,
    holdNextClinical: () => {
      if (held) throw new Error('barrier already armed');
      let enter!: () => void; let release!: () => void;
      const entered = new Promise<void>(r => { enter = r; }); const wait = new Promise<void>(r => { release = r; });
      held = { enter, wait }; return { entered, release };
    },
    configure: (next: Behavior) => { lintFixturePlacement(next); behavior = next; },
    begin: () => { phase = 'target'; },
    clinical: (since = 0) => requests.slice(since).filter(r => r.phase === 'target' && r.kind === 'clinical'),
    targetSinks: () => requests.filter(r => r.phase === 'target' && r.kind === 'sink'),
    digest: () => fingerprint(JSON.stringify(mutations.filter(m => m.startsWith('target:')))),
    liveness: async () => {
      const start = requests.length;
      await fetch(`${new URL(base).origin}/__probe`); await fetch(`${sinkUrl}live`); await fetch(`${new URL(base).origin}/__probe`, { method: 'POST' });
      if (requests.length - start !== 3 || !mutations.some(m => m.startsWith('setup:'))) throw new Error('recorder/sink/mutation journal not live');
      return { recorder: true, sink: true, mutation_journal: true, setup_events: 3 };
    },
    close: async () => { for (const s of [source, sink]) { s.closeAllConnections(); await new Promise<void>(r => s.close(() => r())); } },
  };
}
export type Backend = Awaited<ReturnType<typeof startBackend>>;
