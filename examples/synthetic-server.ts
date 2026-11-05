import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Deterministic synthetic FHIR R4 fixture. No real patient data.
// Standalone: `tsx examples/synthetic-server.ts` binds 127.0.0.1:8080
// (override with SYNTHETIC_FHIR_PORT). Programmatic use binds an
// ephemeral loopback port via startSyntheticFhirServer().

type FhirResource = Record<string, unknown> & { resourceType: string; id: string };

const META = { versionId: '1', lastUpdated: '2025-01-15T00:00:00.000Z' };
const LOINC = 'http://loinc.org';
const UCUM = 'http://unitsofmeasure.org';

function patient(id: string, family: string, given: string, birthDate: string, gender: string): FhirResource {
  return {
    resourceType: 'Patient', id, meta: META, active: true,
    identifier: [{ system: 'http://example.invalid/synthetic-mrn', value: `synthetic-mrn-${id.slice(-1)}` }],
    name: [{ use: 'official', family, given: [given], text: `${given} ${family}` }],
    gender, birthDate,
  };
}

function observation(
  id: string, patientId: string, code: string, display: string,
  value: number, unit: string, unitCode: string,
  effectiveDateTime: string, categoryCode: string, categoryDisplay: string,
): FhirResource {
  return {
    resourceType: 'Observation', id, meta: META, status: 'final',
    category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: categoryCode, display: categoryDisplay }] }],
    code: { coding: [{ system: LOINC, code, display }], text: display },
    subject: { reference: `Patient/${patientId}` },
    effectiveDateTime, issued: effectiveDateTime,
    valueQuantity: { value, unit, system: UCUM, code: unitCode },
  };
}

const RESOURCES: FhirResource[] = [
  patient('synthetic-patient-a', 'SyntheticA', 'Alpha', '1990-01-15', 'female'),
  patient('synthetic-patient-b', 'SyntheticB', 'Beta', '1985-06-20', 'male'),
  observation('synthetic-obs-a1', 'synthetic-patient-a', '2345-7', 'Glucose [Mass/volume] in Serum or Plasma', 95, 'mg/dL', 'mg/dL', '2025-01-10T08:00:00.000Z', 'laboratory', 'Laboratory'),
  observation('synthetic-obs-a2', 'synthetic-patient-a', '4548-4', 'Hemoglobin A1c/Hemoglobin.total in Blood', 5.4, '%', '%', '2025-02-10T08:00:00.000Z', 'laboratory', 'Laboratory'),
  observation('synthetic-obs-a3', 'synthetic-patient-a', '2345-7', 'Glucose [Mass/volume] in Serum or Plasma', 102, 'mg/dL', 'mg/dL', '2025-03-10T08:00:00.000Z', 'laboratory', 'Laboratory'),
  observation('synthetic-obs-a4', 'synthetic-patient-a', '8867-4', 'Heart rate', 72, 'beats/minute', '/min', '2025-03-11T09:30:00.000Z', 'vital-signs', 'Vital Signs'),
  observation('synthetic-obs-b1', 'synthetic-patient-b', '2345-7', 'Glucose [Mass/volume] in Serum or Plasma', 140, 'mg/dL', 'mg/dL', '2025-01-12T08:00:00.000Z', 'laboratory', 'Laboratory'),
  observation('synthetic-obs-b2', 'synthetic-patient-b', '8867-4', 'Heart rate', 88, 'beats/minute', '/min', '2025-02-12T09:30:00.000Z', 'vital-signs', 'Vital Signs'),
  {
    resourceType: 'Medication', id: 'synthetic-med-1', meta: META, status: 'active',
    code: { coding: [{ system: 'http://example.invalid/synthetic-rx', code: 'synthetic-rx-001', display: 'Synthetic Medication One' }], text: 'Synthetic Medication One' },
    form: { coding: [{ system: 'http://example.invalid/synthetic-form', code: 'tablet', display: 'Tablet' }], text: 'Tablet' },
  },
  {
    resourceType: 'Medication', id: 'synthetic-med-2', meta: META, status: 'active',
    code: { coding: [{ system: 'http://example.invalid/synthetic-rx', code: 'synthetic-rx-002', display: 'Synthetic Medication Two' }], text: 'Synthetic Medication Two' },
    form: { coding: [{ system: 'http://example.invalid/synthetic-form', code: 'capsule', display: 'Capsule' }], text: 'Capsule' },
  },
];

const SEARCH_PARAMS: Record<string, { name: string; type: string }[]> = {
  Patient: [
    { name: '_id', type: 'token' }, { name: 'identifier', type: 'token' },
    { name: 'name', type: 'string' }, { name: 'family', type: 'string' },
    { name: 'given', type: 'string' }, { name: 'birthdate', type: 'date' },
    { name: 'gender', type: 'token' }, { name: 'active', type: 'token' },
    { name: '_lastUpdated', type: 'date' },
  ],
  Observation: [
    { name: '_id', type: 'token' }, { name: 'patient', type: 'reference' },
    { name: 'subject', type: 'reference' }, { name: 'code', type: 'token' },
    { name: 'category', type: 'token' }, { name: 'date', type: 'date' },
    { name: 'status', type: 'token' }, { name: 'value-quantity', type: 'quantity' },
    { name: '_lastUpdated', type: 'date' },
  ],
  Medication: [
    { name: '_id', type: 'token' }, { name: 'code', type: 'token' },
    { name: 'status', type: 'token' }, { name: 'form', type: 'token' },
    { name: '_lastUpdated', type: 'date' },
  ],
};
const RESOURCE_TYPES = Object.keys(SEARCH_PARAMS);
const SYSTEM_PARAMS = new Set(['_count', '_offset', '_sort', '_total', '_summary', '_elements', '_format', '_pretty']);

function capabilityStatement(): Record<string, unknown> {
  return {
    resourceType: 'CapabilityStatement', id: 'synthetic-metadata', status: 'active',
    date: '2025-01-15T00:00:00.000Z', kind: 'instance', fhirVersion: '4.0.1',
    format: ['application/fhir+json', 'application/json'],
    software: { name: 'fhir-mcp synthetic fixture', version: '0.1.0-alpha.1' },
    implementation: { description: 'Synthetic-only local fixture. Not a clinical system.' },
    rest: [{
      mode: 'server',
      interaction: [{ code: 'search-system' }],
      resource: RESOURCE_TYPES.map((type) => ({
        type,
        interaction: [{ code: 'read' }, { code: 'search-type' }],
        searchParam: (SEARCH_PARAMS[type] ?? []).map((p) => ({ name: p.name, type: p.type })),
      })),
    }],
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function codingsOf(value: unknown): { system?: string; code?: string; display?: string }[] {
  const out: { system?: string; code?: string }[] = [];
  const collect = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(collect); return; }
    const r = asRecord(v); if (!r) return;
    if (typeof r['code'] === 'string' || typeof r['system'] === 'string') {
      out.push({ system: typeof r['system'] === 'string' ? r['system'] : undefined, code: typeof r['code'] === 'string' ? r['code'] : undefined });
    }
    if (r['coding'] !== undefined) collect(r['coding']);
  };
  collect(value);
  return out;
}
function tokenMatches(codings: { system?: string; code?: string }[], token: string): boolean {
  const [left, right] = token.includes('|') ? token.split('|', 2) as [string, string] : [undefined, token] as [undefined, string];
  const system = token.includes('|') ? (left || undefined) : undefined;
  const code = token.includes('|') ? (right || undefined) : right;
  return codings.some((c) => (system === undefined || c.system === system) && (code === undefined || c.code === code));
}
function referenceId(value: string): string {
  const trimmed = value.replace(/\/_history\/[^/]+$/, '');
  const parts = trimmed.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? value;
}
function parseDateValue(raw: string): number | undefined {
  const t = Date.parse(raw);
  return Number.isNaN(t) ? undefined : t;
}
function dateMatches(candidate: string | undefined, raw: string): boolean {
  if (candidate === undefined) return false;
  const m = /^(eq|ne|lt|le|gt|ge|sa|eb|ap)?(.+)$/.exec(raw);
  if (!m) return false;
  const prefix = m[1] ?? 'eq';
  const c = parseDateValue(candidate); const t = parseDateValue(m[2] ?? '');
  if (c === undefined || t === undefined) return false;
  // Date-only targets compare at day granularity for eq.
  const target = m[2] ?? '';
  if (prefix === 'eq' && /^\d{4}(-\d{2}(-\d{2})?)?$/.test(target)) return candidate.startsWith(target);
  switch (prefix) {
    case 'eq': case 'ap': return c === t;
    case 'ne': return c !== t;
    case 'lt': case 'eb': return c < t;
    case 'le': return c <= t;
    case 'gt': case 'sa': return c > t;
    case 'ge': return c >= t;
    default: return false;
  }
}
function quantityMatches(qty: unknown, raw: string): boolean {
  const q = asRecord(qty); if (!q || typeof q['value'] !== 'number') return false;
  const m = /^(eq|ne|lt|le|gt|ge|ap)?(-?\d+(?:\.\d+)?)(?:\|([^|]*)\|([^|]*))?$/.exec(raw);
  if (!m) return false;
  const prefix = m[1] ?? 'eq'; const target = Number(m[2]); const value = q['value'];
  if (m[4] && q['code'] !== m[4] && q['unit'] !== m[4]) return false;
  switch (prefix) {
    case 'eq': case 'ap': return value === target;
    case 'ne': return value !== target;
    case 'lt': return value < target;
    case 'le': return value <= target;
    case 'gt': return value > target;
    case 'ge': return value >= target;
    default: return false;
  }
}
function stringValues(resource: FhirResource, name: string): string[] {
  if (name === 'name' || name === 'family' || name === 'given') {
    const names = Array.isArray(resource['name']) ? resource['name'] : [];
    const out: string[] = [];
    for (const n of names) {
      const r = asRecord(n); if (!r) continue;
      if (name !== 'given' && typeof r['family'] === 'string') out.push(r['family']);
      if (name !== 'family' && Array.isArray(r['given'])) out.push(...(r['given'] as string[]).filter((x) => typeof x === 'string'));
      if (name === 'name' && typeof r['text'] === 'string') out.push(r['text']);
    }
    return out;
  }
  const v = resource[name];
  return typeof v === 'string' ? [v] : [];
}
function dateField(resource: FhirResource, name: string): string | undefined {
  if (name === '_lastUpdated') { const meta = asRecord(resource['meta']); return typeof meta?.['lastUpdated'] === 'string' ? meta['lastUpdated'] : undefined; }
  if (name === 'birthdate') return typeof resource['birthDate'] === 'string' ? resource['birthDate'] : undefined;
  if (name === 'date') {
    for (const f of ['effectiveDateTime', 'issued', 'birthDate']) if (typeof resource[f] === 'string') return resource[f];
  }
  return undefined;
}
function filterMatches(resource: FhirResource, baseName: string, modifier: string | undefined, value: string): boolean {
  // Comma-separated values are OR within one parameter occurrence.
  const values = value.split(',');
  const one = (v: string): boolean => {
    switch (baseName) {
      case '_id': return resource.id === v;
      case 'identifier': {
        const ids = Array.isArray(resource['identifier']) ? resource['identifier'] : [];
        return ids.some((i) => { const r = asRecord(i); return r !== undefined && tokenMatches([{ system: typeof r['system'] === 'string' ? r['system'] : undefined, code: typeof r['value'] === 'string' ? r['value'] : undefined }], v); });
      }
      case 'patient': case 'subject': {
        const subj = asRecord(resource['subject']);
        const ref = typeof subj?.['reference'] === 'string' ? subj['reference'] : undefined;
        if (ref) return referenceId(ref) === referenceId(v);
        // Patient search by patient/subject refers to the Patient itself.
        return resource.resourceType === 'Patient' && resource.id === referenceId(v);
      }
      case 'code': return tokenMatches(codingsOf(resource['code']), v);
      case 'category': return tokenMatches(codingsOf(resource['category']), v);
      case 'form': return tokenMatches(codingsOf(resource['form']), v);
      case 'status': return resource['status'] === v.split('|').pop();
      case 'gender': return resource['gender'] === v.split('|').pop();
      case 'active': return String(resource['active']) === v.split('|').pop();
      case 'name': case 'family': case 'given': {
        const vals = stringValues(resource, baseName);
        return modifier === 'exact' ? vals.some((x) => x === v) : vals.some((x) => x.toLowerCase().includes(v.toLowerCase()));
      }
      case 'date': case 'birthdate': case '_lastUpdated': return dateMatches(dateField(resource, baseName), v);
      case 'value-quantity': return quantityMatches(resource['valueQuantity'], v);
      default: return false;
    }
  };
  const result = values.some(one);
  return modifier === 'not' ? !result : result;
}
function sortResources(list: FhirResource[], sort: string | null): FhirResource[] {
  if (!sort) return list;
  const keys = sort.split(',').map((k) => k.trim()).filter(Boolean).map((k) => ({ desc: k.startsWith('-'), name: k.replace(/^-/, '') }));
  const keyOf = (r: FhirResource, name: string): string => {
    if (name === 'date' || name === 'birthdate' || name === '_lastUpdated') return dateField(r, name) ?? '';
    if (name === '_id') return r.id;
    if (name === 'name') return stringValues(r, 'name').join(' ');
    const v = r[name]; return typeof v === 'string' ? v : '';
  };
  return [...list].sort((a, b) => {
    for (const k of keys) { const cmp = keyOf(a, k.name).localeCompare(keyOf(b, k.name)); if (cmp !== 0) return k.desc ? -cmp : cmp; }
    return a.id.localeCompare(b.id);
  });
}

function outcome(diagnostics: string, code = 'invalid'): Record<string, unknown> {
  return { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code, diagnostics }] };
}
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/fhir+json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0;
    req.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 65536) { reject(new Error('body too large')); req.destroy(); return; } chunks.push(chunk); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function isStrict(req: IncomingMessage): boolean {
  const prefer = req.headers['prefer'];
  const value = Array.isArray(prefer) ? prefer.join(',') : (prefer ?? '');
  return /(?:^|[,;\s])handling\s*=\s*strict\b/i.test(value);
}

function runSearch(baseUrl: string, resourceType: string, params: URLSearchParams, strict: boolean, res: ServerResponse): void {
  const advertised = new Set((SEARCH_PARAMS[resourceType] ?? []).map((p) => p.name));
  const filters: { base: string; modifier?: string; value: string }[] = [];
  for (const [rawName, value] of params.entries()) {
    if (SYSTEM_PARAMS.has(rawName)) continue;
    const colon = rawName.indexOf(':');
    const base = colon >= 0 ? rawName.slice(0, colon) : rawName;
    const modifier = colon >= 0 ? rawName.slice(colon + 1) : undefined;
    const chained = modifier !== undefined && !['exact', 'contains', 'not', 'missing', 'text'].includes(modifier) && !RESOURCE_TYPES.includes(modifier);
    if (!advertised.has(base) || base.includes('.') || chained) {
      if (strict) { sendJson(res, 400, outcome(`Unsupported search parameter: ${rawName}`, 'not-supported')); return; }
      continue;
    }
    // subject:Patient / patient:Patient reference-type modifier is accepted.
    const effectiveModifier = modifier !== undefined && RESOURCE_TYPES.includes(modifier) ? undefined : modifier;
    if (effectiveModifier === 'missing') return sendJson(res, 400, outcome('Unsupported search modifier: missing', 'not-supported'));
    filters.push({ base, modifier: effectiveModifier, value });
  }
  const countRaw = params.get('_count');
  const offsetRaw = params.get('_offset');
  const count = countRaw === null ? 20 : Number(countRaw);
  const offset = offsetRaw === null ? 0 : Number(offsetRaw);
  if (!Number.isInteger(count) || count < 0 || count > 1000) return sendJson(res, 400, outcome('Invalid _count'));
  if (!Number.isInteger(offset) || offset < 0) return sendJson(res, 400, outcome('Invalid _offset'));
  const sortRaw = params.get('_sort');
  if (sortRaw && strict) {
    const bad = sortRaw.split(',').map((k) => k.replace(/^-/, '').trim()).find((k) => !advertised.has(k) && k !== '_id');
    if (bad) return sendJson(res, 400, outcome(`Unsupported sort parameter: ${bad}`, 'not-supported'));
  }
  let matched = RESOURCES.filter((r) => r.resourceType === resourceType);
  // Repeated parameter occurrences are ANDed (FHIR search semantics).
  for (const f of filters) matched = matched.filter((r) => filterMatches(r, f.base, f.modifier, f.value));
  matched = sortResources(matched, sortRaw);
  const total = matched.length;
  const summary = params.get('_summary');
  const page = summary === 'count' ? [] : matched.slice(offset, offset + (count === 0 ? total : count));
  const selfParams = new URLSearchParams(params);
  const selfUrl = `${baseUrl}/${resourceType}${selfParams.toString() ? `?${selfParams.toString()}` : ''}`;
  const links: { relation: string; url: string }[] = [{ relation: 'self', url: selfUrl }];
  if (summary !== 'count' && count > 0 && offset + page.length < total) {
    const nextParams = new URLSearchParams(params);
    nextParams.set('_offset', String(offset + count));
    if (!nextParams.has('_count')) nextParams.set('_count', String(count));
    links.push({ relation: 'next', url: `${baseUrl}/${resourceType}?${nextParams.toString()}` });
  }
  sendJson(res, 200, {
    resourceType: 'Bundle', type: 'searchset', total, link: links,
    entry: page.map((resource) => ({ fullUrl: `${baseUrl}/${resource.resourceType}/${resource.id}`, resource, search: { mode: 'match' } })),
  });
}

async function handleRequest(baseUrl: () => string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', baseUrl());
    const segments = url.pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
    if (segments[0] !== 'fhir') return sendJson(res, 404, outcome('Not found', 'not-found'));
    const strict = isStrict(req);
    if (req.method === 'GET' && segments.length === 2 && segments[1] === 'metadata') return sendJson(res, 200, capabilityStatement());
    if (req.method === 'GET' && segments.length === 1) return sendJson(res, 200, capabilityStatement());
    const resourceType = segments[1] ?? '';
    if (!RESOURCE_TYPES.includes(resourceType)) return sendJson(res, 404, outcome(`Unknown resource type: ${resourceType}`, 'not-found'));
    // Read: /fhir/{Type}/{id}
    if (req.method === 'GET' && segments.length === 3) {
      const found = RESOURCES.find((r) => r.resourceType === resourceType && r.id === segments[2]);
      return found ? sendJson(res, 200, found) : sendJson(res, 404, outcome('Resource not found', 'not-found'));
    }
    // Search: GET /fhir/{Type}?... and POST /fhir/{Type}/_search
    if (req.method === 'GET' && segments.length === 2) return runSearch(baseUrl(), resourceType, url.searchParams, strict, res);
    if (req.method === 'POST' && segments.length === 3 && segments[2] === '_search') {
      const body = await readBody(req);
      const merged = new URLSearchParams(url.searchParams);
      const contentType = req.headers['content-type'] ?? '';
      if (contentType.includes('application/json') && body.trim()) {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        for (const [k, v] of Object.entries(parsed)) {
          if (Array.isArray(v)) v.forEach((x) => merged.append(k, String(x))); else merged.append(k, String(v));
        }
      } else if (body.trim()) {
        for (const [k, v] of new URLSearchParams(body).entries()) merged.append(k, v);
      }
      return runSearch(baseUrl(), resourceType, merged, strict, res);
    }
    return sendJson(res, 405, outcome('Method or interaction not supported by synthetic fixture', 'not-supported'));
  } catch {
    if (!res.headersSent) sendJson(res, 500, outcome('Synthetic fixture error', 'exception'));
  }
}

async function startServer(port: number): Promise<{ baseUrl: string; close(): Promise<void> }> {
  let boundBaseUrl = `http://127.0.0.1:${port}/fhir`;
  const server: Server = createServer((req, res) => { void handleRequest(() => boundBaseUrl, req, res); });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') boundBaseUrl = `http://127.0.0.1:${addr.port}/fhir`;
      resolve();
    });
  });
  return {
    baseUrl: boundBaseUrl,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
      server.closeAllConnections?.();
    }),
  };
}

export function startSyntheticFhirServer(): Promise<{ baseUrl: string; close(): Promise<void> }> {
  return startServer(0);
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try { return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isMainModule()) {
  const rawPort = process.env['SYNTHETIC_FHIR_PORT'] ?? process.env['PORT'] ?? '8080';
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    process.stderr.write('synthetic-server: invalid port\n');
    process.exit(2);
  }
  startServer(port).then(({ baseUrl, close }) => {
    process.stdout.write(`synthetic FHIR fixture listening at ${baseUrl} (synthetic data only)\n`);
    const shutdown = (): void => { void close().then(() => process.exit(0)); };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }).catch(() => { process.stderr.write('synthetic-server: failed to start\n'); process.exit(1); });
}
