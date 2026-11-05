/**
 * Packaging slice 6 (proposals/m3b-s8s9-design.md; integration plan A6): turn a pinned Synthea v4.0.0 R4
 * export into the reviewed quickstart seed. Pure and deterministic. Inputs are raw bytes (strict UTF-8, hashed as
 * read); numbers keep their source lexemes (parseFhirJson / stringifyFhir). Exactly one living Patient is selected;
 * the seed is that patient's laboratory Observations and lab DiagnosticReports whose effective time lies inside a
 * fixed UTC window, plus every resource they reference. Every reference is resolved before selection: `urn:uuid:`
 * and `Type?identifier=system|value` forms must name exactly one export resource of the right type, and are
 * rewritten to `Type/id`. Logical (identifier-only) references, contained resources, `#local` references and any
 * other link form are refused, as are clinical resources outside the slice that the closure would pull in. The only
 * requests out are individual fixed-id PUTs, each target before its referrers. Synthea's synthetic SSN,
 * driver's-licence and passport identifiers are removed from the Patient, and no decoded value of them may remain.
 * Provider directory resources are reduced to synthetic stand-ins: a Synthea export copies real facilities' names,
 * addresses and telephone numbers from its provider files and gives practitioners NPI-namespace identifiers, so
 * organisation and location names are replaced, contact fields and NPI identifiers removed, and displays of
 * references to organisations and locations dropped. Only explicitly synthetic practitioner names and their matching
 * displays, self-id Synthea identifiers and numeric utilization extensions are retained; unsupported provider forms
 * refuse. Removed identifying values may not remain elsewhere. The written seed is re-checked
 * against `checkSeedContract`, which the edge merge also applies to a natural seed it did not produce.
 * Every refusal is a fixed fault code; nothing is guessed or dropped silently, and no error carries an id, path or value.
 *   node --import tsx scripts/quickstart/transform-synthea.ts <export fhir dir> <new empty out dir>
 */
import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertLosslessJsonRuntime, cloneFhirValue, containsPrecisionFault, isFhirDecimal, parseFhirJson, stringifyFhir } from '../../packages/core/src/decimal.js';

export type TransformFault = 'EXPORT_INVALID' | 'INPUT_TOO_LARGE' | 'DUPLICATE_ID' | 'ID_INVALID' | 'PATIENT_SELECTION' | 'DATE_INVALID'
  | 'REFERENCE_UNRESOLVED' | 'REFERENCE_AMBIGUOUS' | 'REFERENCE_FOREIGN' | 'REFERENCE_LOGICAL' | 'REFERENCE_TYPE_MISMATCH' | 'REFERENCE_CYCLE'
  | 'CONTAINED_REFUSED' | 'FOREIGN_PATIENT' | 'TYPE_NOT_ALLOWED' | 'SLICE_VIOLATION' | 'PRECISION_LOST' | 'LEXEME_CHANGED'
  | 'IDENTIFIER_RESIDUE' | 'PROVIDER_RESIDUE' | 'SEED_TOO_LARGE' | 'SEED_CONTRACT';
/** The message is the code alone: no id, path, reference or value reaches an error. */
export class TransformError extends Error {
  constructor(readonly code: TransformFault) { super(code); this.name = 'TransformError'; }
}
const fault = (code: TransformFault): never => { throw new TransformError(code); };

type Rec = Record<string, unknown>;
const isRecord = (value: unknown): value is Rec => !!value && typeof value === 'object' && !Array.isArray(value) && !isFhirDecimal(value);
const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const FHIR_ID = /^[A-Za-z0-9.-]{1,64}$/;
/** Synthea's conditional-reference form only: no percent or FHIR escapes, no further parameters, no modifiers. Relative `Type/id` refuses too. */
const IDENTIFIER_REFERENCE = /^([A-Z][A-Za-z]+)\?identifier=([^|&,$%\\?#\s]+)\|([^|&,$%\\?#\s]+)$/;
const OBSERVATION_LAB = ['http://terminology.hl7.org/CodeSystem/observation-category', 'laboratory'] as const;
const REPORT_LAB = ['http://terminology.hl7.org/CodeSystem/v2-0074', 'LAB'] as const;
const IDENTIFIER_TYPE_SYSTEM = 'http://terminology.hl7.org/CodeSystem/v2-0203';
/** Provider directory types; organisations and locations are named, so their names are replaced by numbered stand-ins. */
const PROVIDER_TYPES = new Set(['Organization', 'Location', 'Practitioner', 'PractitionerRole']);
const PROVIDER_NOUNS: Readonly<Record<string, string>> = { Organization: 'organization', Location: 'location' };
const PROVIDER_CONTACT = ['telecom', 'address', 'position', 'alias', 'contact', 'photo', 'qualification'] as const;
const NPI_SYSTEM = 'http://hl7.org/fhir/sid/us-npi';
const PROVIDER_STAND_IN = /^Synthetic (?:organization|location) [1-9]\d{0,5}$/;
const SYNTHEA_SYSTEM = 'https://github.com/synthetichealth/synthea';
/** The pinned export's deidentified HumanName convention; ordinary directory names are not admitted. */
const SYNTHETIC_NAME_PART = /^\p{L}+[0-9]{1,3}$/u;
const onlyKeys = (node: Rec, keys: readonly string[]) => Object.keys(node).every(key => keys.includes(key));
const syntheticNames = (value: unknown): value is Rec[] => Array.isArray(value) && value.length > 0 && value.every(name => isRecord(name)
  && onlyKeys(name, ['family', 'given', 'prefix']) && typeof name.family === 'string' && SYNTHETIC_NAME_PART.test(name.family)
  && Array.isArray(name.given) && name.given.length > 0 && name.given.every(part => typeof part === 'string' && SYNTHETIC_NAME_PART.test(part))
  && (name.prefix === undefined || Array.isArray(name.prefix) && name.prefix.length === 1 && name.prefix[0] === 'Dr.'));
const syntheticPractitionerDisplay = (resource: Rec, display: unknown): boolean => syntheticNames(resource.name)
  && resource.name.some(name => [...((name.prefix as string[] | undefined) ?? []), ...(name.given as string[]), name.family].join(' ') === display);
const UTILIZATION_EXTENSION = /^http:\/\/synthetichealth\.github\.io\/synthea\/utilization-(?:encounters|procedures|labs|prescriptions)-extension$/;
const providerExtensions = (value: unknown): boolean => Array.isArray(value) && value.every(extension => isRecord(extension)
  && onlyKeys(extension, ['url', 'valueInteger']) && typeof extension.url === 'string' && UTILIZATION_EXTENSION.test(extension.url)
  && Number.isSafeInteger(extension.valueInteger) && (extension.valueInteger as number) >= 0);
const providerIdentifier = (identifier: unknown, id: unknown): boolean => isRecord(identifier) && onlyKeys(identifier, ['system', 'value'])
  && identifier.system === SYNTHEA_SYSTEM && identifier.value === id;
const providerReference = (value: unknown): boolean => isRecord(value) && onlyKeys(value, ['reference', 'type', 'display']) && typeof value.reference === 'string';
const PROVIDER_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Organization: ['active', 'type', 'name', 'partOf'], Location: ['status', 'mode', 'name', 'managingOrganization', 'partOf'],
  Practitioner: ['active', 'name', 'gender'], PractitionerRole: ['active', 'practitioner', 'organization', 'location'],
};
/** A deliberately small retained provider shape. Unreviewed free text, metadata, extensions and identifiers refuse. */
function safeProvider(resource: Rec): boolean {
  const type = resource.resourceType as string;
  if (!onlyKeys(resource, ['resourceType', 'id', 'identifier', 'extension', ...(PROVIDER_FIELDS[type] ?? [])])) return false;
  if (resource.identifier !== undefined && !(Array.isArray(resource.identifier) && resource.identifier.every(id => providerIdentifier(id, resource.id)))) return false;
  if (resource.extension !== undefined && !providerExtensions(resource.extension)) return false;
  if (resource.active !== undefined && typeof resource.active !== 'boolean') return false;
  if (PROVIDER_NOUNS[type] !== undefined && !(typeof resource.name === 'string' && PROVIDER_STAND_IN.test(resource.name)
    && resource.name.startsWith(`Synthetic ${PROVIDER_NOUNS[type]} `))) return false;
  if (type === 'Practitioner' && resource.name !== undefined && !syntheticNames(resource.name)) return false;
  if (resource.gender !== undefined && !['male', 'female', 'other', 'unknown'].includes(resource.gender as string)) return false;
  if (resource.status !== undefined && !['active', 'suspended', 'inactive'].includes(resource.status as string)) return false;
  if (resource.mode !== undefined && !['instance', 'kind'].includes(resource.mode as string)) return false;
  // The only retained Organization.type is the pinned, non-identifying provider classification.
  if (resource.type !== undefined && !(Array.isArray(resource.type) && resource.type.length > 0 && resource.type.every(concept => isRecord(concept)
    && onlyKeys(concept, ['coding', 'text']) && (concept.text === undefined || concept.text === 'Healthcare Provider')
    && Array.isArray(concept.coding) && concept.coding.length > 0 && concept.coding.every(coding => isRecord(coding)
      && onlyKeys(coding, ['system', 'code', 'display']) && coding.system === 'http://terminology.hl7.org/CodeSystem/organization-type'
      && coding.code === 'prov' && (coding.display === undefined || coding.display === 'Healthcare Provider'))))) return false;
  for (const key of ['partOf', 'managingOrganization', 'practitioner', 'organization']) if (resource[key] !== undefined && !providerReference(resource[key])) return false;
  return resource.location === undefined || Array.isArray(resource.location) && resource.location.every(providerReference);
}
const PROVIDER_REFERENCE_FIELDS = new Set(['performer', 'serviceProvider', 'individual', 'managingOrganization', 'organization', 'practitioner', 'generalPractitioner', 'location', 'partOf']);
const providerDisplayOnly = (node: Rec, key: string) => !('reference' in node) && 'display' in node
  && (PROVIDER_TYPES.has(node.type as string) || PROVIDER_REFERENCE_FIELDS.has(key)
    || onlyKeys(node, ['type', 'display', 'identifier', 'id', 'extension', '_reference', '_display', '_type']) && !(SEED_TYPES as readonly unknown[]).includes(node.type));

/** Seed types; also the PUT tie-break order (targets first) among resources the reference graph leaves unordered. */
export const SEED_TYPES = ['Organization', 'Location', 'Practitioner', 'PractitionerRole', 'Patient', 'Encounter', 'Condition', 'Observation', 'DiagnosticReport'] as const;
/** Clinical types only enter the seed through the slice rule; the closure may not add more of them. */
const SLICE_TYPES = new Set(['Observation', 'DiagnosticReport']);
/** Patient-linked dependency types: reachable through the closure, but only when they belong to the selected patient. */
const PATIENT_LINKED = new Set(['Encounter', 'Condition']);
export interface SeedSelection { window: { start: string; end: string }; maxResources: number; maxBytes: number; maxInputBytes: number }
/** Quickstart window `[2020-01-01T00:00Z, 2026-01-01T00:00Z)` (A6, `as_of`), bounded so a seed stays a small reviewed fixture. */
export const QUICKSTART_SELECTION: SeedSelection = { window: { start: '2020-01-01', end: '2026-01-01' }, maxResources: 1000, maxBytes: 1_048_576, maxInputBytes: 134_217_728 };

export interface ExportFile { name: string; bytes: Uint8Array }
/** Exactly the helper's seed-manifest row (`examples/quickstart/manifest.ts`); the PUT target is `type/id`, rows in PUT order. */
export interface SeedResource { type: string; id: string; bytes: number; sha256: string; origin: 'natural' }
export interface SeedManifest {
  schema: 'fireboat-quickstart-seed/1';
  inputs: { name: string; bytes: number; sha256: string }[];
  selection: SeedSelection;
  patient: string;
  counts: Record<string, number>;
  dropped_patient_identifiers: { SS: number; DL: number; PPN: number };
  providers: { sanitized: number; npi_identifiers_dropped: number };
  resources: SeedResource[];
  ndjson_sha256: string;
}
export interface SeedResult { ndjson: string; manifest: SeedManifest }

interface Entry { url: string; type: string; id: string; resource: Rec }

const hasCoding = (concepts: unknown, [system, code]: readonly [string, string]) => Array.isArray(concepts)
  && concepts.some(concept => isRecord(concept) && Array.isArray(concept.coding) && concept.coding.some(c => isRecord(c) && c.system === system && c.code === code));

/** FHIR R4 date / dateTime as a half-open UTC interval in ms. A time needs an offset; date-only and partial values are UTC calendar intervals. */
const DATE_TIME = /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2}))?)?)?$/;
/** Milliseconds of a proleptic UTC calendar time; unlike Date.UTC, years 0-99 stay themselves. Fields may overflow (day 32 rolls over). */
const utcMs = (y: number, monthIndex: number, d: number, h = 0, mi = 0, s = 0, ms = 0): number => {
  const t = new Date(0); t.setUTCFullYear(y, monthIndex, d); t.setUTCHours(h, mi, s, ms); return t.getTime();
};
export function utcInterval(value: unknown): [number, number] {
  const { lo, hi } = utcTime(value);
  return [lo, hi];
}
/** The UTC interval of a date/dateTime plus the complete fractional-second digits of a timed value, for exact ordering at any precision. */
function utcTime(value: unknown): { lo: number; hi: number; fraction: string } {
  const m = typeof value === 'string' ? DATE_TIME.exec(value) : null;
  if (!m) return fault('DATE_INVALID');
  const [year, month = '01', day = '01', hour, minute, second, fraction = '', offset] = m.slice(1) as (string | undefined)[];
  const y = Number(year), mo = Number(month), d = Number(day);
  const days = new Date(utcMs(y, mo, 0)).getUTCDate();
  if (y < 1 || mo < 1 || mo > 12 || d < 1 || d > days) return fault('DATE_INVALID');
  if (hour === undefined) {
    const lo = utcMs(y, mo - 1, d);
    const hi = m[3] ? utcMs(y, mo - 1, d + 1) : m[2] ? utcMs(y, mo, 1) : utcMs(y + 1, 0, 1);
    return { lo, hi, fraction: '' };
  }
  const [h, mi, s] = [Number(hour), Number(minute), Number(second)];
  const [oh, om] = offset === 'Z' ? [0, 0] : [Number(offset!.slice(1, 3)), Number(offset!.slice(4, 6))];
  if (h > 23 || mi > 59 || s > 59 || om > 59 || oh * 60 + om > 14 * 60) return fault('DATE_INVALID');
  const sign = offset!.startsWith('-') ? -1 : 1;
  const instant = utcMs(y, mo - 1, d, h, mi, s, Number(fraction.padEnd(3, '0').slice(0, 3))) - (offset === 'Z' ? 0 : sign * (oh * 60 + om) * 60_000);
  return { lo: instant, hi: instant + 1, fraction };
}
/** The effective interval of an Observation or DiagnosticReport; an open or reversed Period is never inside a window. */
function effectiveInterval(resource: Rec): [number, number] | undefined {
  if (resource.effectiveDateTime !== undefined) return utcInterval(resource.effectiveDateTime);
  if (resource.effectivePeriod !== undefined) {
    const period = resource.effectivePeriod;
    if (!isRecord(period)) return fault('DATE_INVALID');
    const start = period.start === undefined ? undefined : utcTime(period.start);
    const end = period.end === undefined ? undefined : utcTime(period.end);
    // Reversed: the end begins before the start begins, comparing every fractional digit (touching calendar intervals included).
    const digits = (a: string, b: string) => { const n = Math.max(a.length, b.length); const x = a.padEnd(n, '0'), y = b.padEnd(n, '0'); return x < y ? -1 : x > y ? 1 : 0; };
    if (start && end && (end.lo < start.lo || (end.lo === start.lo && digits(end.fraction, start.fraction) < 0))) return fault('DATE_INVALID');
    return start && end ? [start.lo, end.hi] : undefined;
  }
  return undefined;
}

function numberLexemes(node: unknown, out: string[] = []): string[] {
  if (isFhirDecimal(node)) out.push(node.lexeme);
  else if (typeof node === 'number') out.push(JSON.stringify(node));
  else if (Array.isArray(node)) node.forEach(child => numberLexemes(child, out));
  else if (isRecord(node)) Object.values(node).forEach(child => numberLexemes(child, out));
  return out;
}
/** SS, DL or PPN when the identifier is one of Synthea's synthetic government identifiers, else undefined. A type code without a system counts. */
function governmentIdentifierKind(identifier: unknown): 'SS' | 'DL' | 'PPN' | undefined {
  if (!isRecord(identifier)) return undefined;
  const typed = isRecord(identifier.type) && Array.isArray(identifier.type.coding)
    ? identifier.type.coding.find(c => isRecord(c) && (c.system === IDENTIFIER_TYPE_SYSTEM || c.system === undefined) && ['SS', 'DL', 'PPN'].includes(c.code as string)) : undefined;
  if (isRecord(typed)) return typed.code as 'SS' | 'DL' | 'PPN';
  if (identifier.system === 'http://hl7.org/fhir/sid/us-ssn') return 'SS';
  if (identifier.system === 'http://hl7.org/fhir/sid/passport-USA') return 'PPN';
  if (typeof identifier.system === 'string' && identifier.system.startsWith('urn:oid:2.16.840.1.113883.4.3.')) return 'DL';
  return undefined;
}
const NAMED_ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
/** XHTML character references decoded; a reference outside Unicode scalar values refuses rather than throwing. */
const decodeEntities = (text: string): string => text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
  if (body[0] !== '#') return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  const point = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1));
  if (!Number.isSafeInteger(point) || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) return fault('EXPORT_INVALID');
  return String.fromCodePoint(point);
});
/**
 * Rendered text of narrative markup: tags removed, where a `>` inside a quoted attribute value does not end the tag;
 * comments are not rendered and CDATA is text. Any other `<!` or `<?` construct refuses rather than being guessed at.
 */
function xhtmlText(markup: string): string {
  let out = '';
  for (let i = 0; i < markup.length;) {
    if (markup[i] !== '<') { out += markup[i++]; continue; }
    if (markup.startsWith('<!--', i)) {
      const end = markup.indexOf('-->', i + 4);
      if (end < 0) return fault('EXPORT_INVALID');
      i = end + 3; continue;
    }
    if (markup.startsWith('<![CDATA[', i)) {
      const end = markup.indexOf(']]>', i + 9);
      if (end < 0) return fault('EXPORT_INVALID');
      out += markup.slice(i + 9, end); i = end + 3; continue;
    }
    if (markup[i + 1] === '!' || markup[i + 1] === '?') return fault('EXPORT_INVALID');
    let quote: string | undefined;
    for (i++; i < markup.length; i++) {
      const c = markup[i]!;
      if (quote) { if (c === quote) quote = undefined; } else if (c === '"' || c === "'") quote = c; else if (c === '>') { i++; break; }
    }
  }
  return out;
}
/** Views in which a removed identifier must not appear: the value, and for narrative its decoded markup (attributes included) and decoded rendered text. */
const decodedViews = (key: string, value: string): string[] => key === 'div' ? [decodeEntities(value), decodeEntities(xhtmlText(value))] : [value];
function decodedStrings(node: unknown, key = '', out: string[] = []): string[] {
  if (typeof node === 'string') out.push(...decodedViews(key, node));
  else if (Array.isArray(node)) node.forEach(child => decodedStrings(child, key, out));
  else if (isRecord(node)) for (const [k, child] of Object.entries(node)) decodedStrings(child, k, out);
  return out;
}
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

type ProviderText = { kind: 'name' | 'text' | 'phone'; value: string };
/** Shared address geography and coding metadata are not provider identity (a patient may share them). */
const SHARED_CONTACT_FIELDS = new Set(['city', 'district', 'state', 'postalCode', 'country', 'system', 'code', 'use', 'contentType', 'language']);
const CONTACT_TEXT_FIELDS = new Set([...PROVIDER_CONTACT, 'line', 'value', 'text', 'name', 'family', 'given', 'display']);
function collectProviderText(node: unknown, out: ProviderText[], key = ''): void {
  if (Array.isArray(node)) { node.forEach(child => collectProviderText(child, out, key)); return; }
  if (isRecord(node)) {
    const phone = ['phone', 'fax', 'sms', 'pager'].includes(node.system as string) && node.value !== undefined;
    if (phone) {
      if (typeof node.value !== 'string') fault('PROVIDER_RESIDUE');
      // The saved directory also has a contact with two alternatives, written "number or number".
      for (const value of (node.value as string).split(/\s+or\s+/i)) {
        if (!/^\+?[0-9\s().-]+$/.test(value) || !/^[0-9]{7,15}$/.test(value.replace(/\D/g, ''))) fault('PROVIDER_RESIDUE');
        out.push({ kind: 'phone', value: value.replace(/\D/g, '') });
      }
    }
    for (const [k, child] of Object.entries(node)) if (!SHARED_CONTACT_FIELDS.has(k) && !(phone && k === 'value')) collectProviderText(child, out, k);
  } else if (typeof node === 'string' && node.trim() !== '') {
    out.push({ kind: ['name', 'family', 'given', 'alias', 'display'].includes(key) ? 'name' : 'text', value: node.trim() });
  } else if (node !== undefined && CONTACT_TEXT_FIELDS.has(key)) fault('PROVIDER_RESIDUE');
}
/** Single-token provider names cannot be separated from prose safely in the supported input. Refuse them; match every admitted removed value everywhere. */
function providerTextPattern({ kind, value }: ProviderText): RegExp {
  const token = escapeRegExp(value);
  if (kind === 'phone') return new RegExp(`(?:^|[^A-Za-z0-9])${[...value].join('[\\s().+-]*')}(?:$|[^A-Za-z0-9])`);
  if (kind === 'name' && !/\S+\s+\S+/.test(value)) fault('PROVIDER_RESIDUE');
  return new RegExp(`(?:^|[^A-Za-z0-9])${token}(?:$|[^A-Za-z0-9])`, 'i');
}

export function transformSyntheaExport(files: readonly ExportFile[], selection: SeedSelection = QUICKSTART_SELECTION): SeedResult {
  try { assertLosslessJsonRuntime(); } catch { fault('PRECISION_LOST'); }
  const ordered = [...files].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  if (ordered.reduce((n, f) => n + f.bytes.byteLength, 0) > selection.maxInputBytes) fault('INPUT_TOO_LARGE');
  const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const entries = new Map<string, Entry>();
  const byIdentifier = new Map<string, Set<string>>();
  for (const file of ordered) {
    let bundle: unknown;
    try { bundle = parseFhirJson(utf8.decode(file.bytes)); } catch { fault('EXPORT_INVALID'); }
    // Patient files are transactions; Synthea writes the shared hospital and practitioner files as conditional-create
    // batches. Only the resources are read; no input request is replayed.
    if (!isRecord(bundle) || bundle.resourceType !== 'Bundle' || !['transaction', 'batch'].includes(bundle.type as string) || !Array.isArray(bundle.entry)) fault('EXPORT_INVALID');
    for (const raw of (bundle as Rec).entry as unknown[]) {
      const resource = isRecord(raw) ? raw.resource : undefined;
      if (!isRecord(raw) || !isRecord(resource) || typeof resource.resourceType !== 'string' || typeof resource.id !== 'string'
        || raw.fullUrl !== `urn:uuid:${resource.id}`) fault('EXPORT_INVALID');
      // Per resource: the core walk is bounded (and fails closed) at a size a whole export bundle exceeds.
      if (containsPrecisionFault(resource)) fault('PRECISION_LOST');
      const { resourceType: type, id } = resource as { resourceType: string; id: string };
      if (!FHIR_ID.test(id)) fault('ID_INVALID');
      const url = `urn:uuid:${id}`;
      if (entries.has(url)) fault('DUPLICATE_ID');
      entries.set(url, { url, type, id, resource: resource as Rec });
      for (const identifier of Array.isArray((resource as Rec).identifier) ? (resource as Rec).identifier as unknown[] : []) {
        if (!isRecord(identifier) || typeof identifier.system !== 'string' || typeof identifier.value !== 'string') continue;
        const key = `${type}?identifier=${identifier.system}|${identifier.value}`;
        const hits = byIdentifier.get(key) ?? new Set<string>();
        byIdentifier.set(key, hits.add(url));
      }
    }
  }

  /** The one export resource a reference names, or a fault. */
  const resolve = (reference: string): Entry => {
    if (reference.startsWith('#')) return fault('CONTAINED_REFUSED');
    if (reference.startsWith('urn:uuid:')) return entries.get(reference) ?? fault('REFERENCE_UNRESOLVED');
    if (!IDENTIFIER_REFERENCE.test(reference)) return fault('REFERENCE_FOREIGN');
    const hits = byIdentifier.get(reference);
    if (!hits || hits.size === 0) return fault('REFERENCE_UNRESOLVED');
    if (hits.size > 1) return fault('REFERENCE_AMBIGUOUS');
    return entries.get([...hits][0]!)!;
  };
  /** Every link of a resource, resolved: Reference objects with `reference`; logical references, contained and stray urn links refuse. */
  const links = (resource: Rec): Map<string, Entry> => {
    if (resource.contained !== undefined) fault('CONTAINED_REFUSED');
    const found = new Map<string, Entry>();
    const visit = (node: unknown, key: string): void => {
      if (typeof node === 'string') { if (key !== 'reference' && /urn:uuid:/i.test(node)) fault('REFERENCE_FOREIGN'); return; }
      if (Array.isArray(node)) { node.forEach(child => visit(child, key)); return; }
      if (!isRecord(node)) return;
      if (typeof node.reference === 'string') {
        const target = found.get(node.reference) ?? resolve(node.reference);
        if (node.type !== undefined && node.type !== target.type) fault('REFERENCE_TYPE_MISMATCH');
        found.set(node.reference, target);
      } else if (node.reference !== undefined) fault('EXPORT_INVALID');
      else if (isRecord(node.identifier)) fault('REFERENCE_LOGICAL');
      for (const [k, child] of Object.entries(node)) if (k !== 'reference') visit(child, k);
    };
    visit(resource, '');
    return found;
  };
  /** The resource a Reference names. A logical (identifier-only) reference refuses everywhere, selection included; a display-only one names nothing. */
  const target = (value: unknown): Entry | undefined => {
    if (!isRecord(value)) return undefined;
    if (typeof value.reference === 'string') return resolve(value.reference);
    if (value.reference !== undefined) return fault('EXPORT_INVALID');
    if (isRecord(value.identifier)) return fault('REFERENCE_LOGICAL');
    return undefined;
  };
  const subjectOf = (resource: Rec): Entry | undefined => target(resource.subject);

  const living = [...entries.values()].filter(e => e.type === 'Patient' && e.resource.deceasedBoolean !== true && e.resource.deceasedDateTime === undefined);
  if (living.length !== 1) fault('PATIENT_SELECTION');
  const patient = living[0]!;
  const [windowStart] = utcInterval(selection.window.start), [windowEnd] = utcInterval(selection.window.end);
  const inWindow = (resource: Rec) => { const iv = effectiveInterval(resource); return iv !== undefined && iv[0] >= windowStart && iv[1] <= windowEnd; };
  const ownLab = (e: Entry, type: string, category: readonly [string, string]) => e.type === type && hasCoding(e.resource.category, category)
    && inWindow(e.resource) && subjectOf(e.resource)?.url === patient.url;
  const observations = new Set([...entries.values()].filter(e => ownLab(e, 'Observation', OBSERVATION_LAB)).map(e => e.url));
  const reports = [...entries.values()].filter(e => ownLab(e, 'DiagnosticReport', REPORT_LAB) && Array.isArray(e.resource.result)
    && e.resource.result.length > 0 && e.resource.result.every(r => observations.has((target(r) ?? fault('REFERENCE_UNRESOLVED')).url)));
  const eligible = new Set([...observations, ...reports.map(r => r.url)]);
  if (eligible.size + 1 > selection.maxResources) fault('SEED_TOO_LARGE');

  // Reference closure, bounded as it grows: every link must resolve to an allowed export resource of this patient.
  const targets = new Map<string, Map<string, Entry>>();
  const pending = [patient.url, ...eligible];
  const seed = new Set<string>();
  while (pending.length) {
    const url = pending.pop()!;
    if (seed.has(url)) continue;
    const entry = entries.get(url)!;
    if (!(SEED_TYPES as readonly string[]).includes(entry.type)) fault('TYPE_NOT_ALLOWED');
    if (entry.type === 'Patient' && url !== patient.url) fault('FOREIGN_PATIENT');
    if (SLICE_TYPES.has(entry.type) && !eligible.has(url)) fault('SLICE_VIOLATION');
    const found = links(entry.resource);
    if (PATIENT_LINKED.has(entry.type) && subjectOf(entry.resource)?.url !== patient.url) fault('FOREIGN_PATIENT');
    seed.add(url);
    if (seed.size > selection.maxResources) fault('SEED_TOO_LARGE');
    targets.set(url, found);
    for (const target of found.values()) if (!seed.has(target.url)) pending.push(target.url);
  }

  // Rewrite references to Type/id, drop the Patient's synthetic government identifiers, serialize losslessly.
  const dropped = { SS: 0, DL: 0, PPN: 0 };
  const droppedValues: string[] = [];
  const providers = { sanitized: 0, npi_identifiers_dropped: 0 };
  const removedProviderText: ProviderText[] = [];
  const ordinal = new Map<string, number>();
  for (const type of Object.keys(PROVIDER_NOUNS))
    [...seed].map(url => entries.get(url)!).filter(e => e.type === type).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).forEach((e, i) => ordinal.set(e.url, i + 1));
  const bodies = new Map<string, string>();
  let ndjsonBytes = 0;
  for (const url of seed) {
    const entry = entries.get(url)!;
    const map = targets.get(url)!;
    let source = entry.resource;
    if (url === patient.url && Array.isArray(source.identifier)) {
      const kept = source.identifier.filter(identifier => {
        const kind = governmentIdentifierKind(identifier);
        if (!kind) return true;
        dropped[kind] += 1;
        if (isRecord(identifier) && typeof identifier.value === 'string' && identifier.value !== '') droppedValues.push(identifier.value);
        return false;
      });
      source = { ...source, identifier: kept };
    }
    if (PROVIDER_TYPES.has(entry.type)) {
      const standIn: Rec = { ...source };
      const noun = PROVIDER_NOUNS[entry.type];
      if (noun !== undefined) {
        if (source.name !== undefined && (typeof source.name !== 'string' || source.name.trim() === '')) fault('PROVIDER_RESIDUE');
        if (typeof source.name === 'string') removedProviderText.push({ kind: 'name', value: source.name.trim() });
        standIn.name = `Synthetic ${noun} ${ordinal.get(url)!}`;
      }
      // Walk both arrays and single Address/line values, including aliases and nested contact names/telecom.
      for (const key of PROVIDER_CONTACT) collectProviderText(standIn[key], removedProviderText, key);
      for (const key of PROVIDER_CONTACT) delete standIn[key];
      if (Array.isArray(standIn.identifier)) {
        const kept = standIn.identifier.filter(identifier => {
          if (isRecord(identifier) && identifier.system === NPI_SYSTEM) {
            if (!onlyKeys(identifier, ['system', 'value'])) fault('PROVIDER_RESIDUE');
            if (typeof identifier.value !== 'string' || identifier.value.trim() === '') fault('PROVIDER_RESIDUE');
            removedProviderText.push({ kind: 'text', value: (identifier.value as string).trim() });
            return false;
          }
          return true;
        });
        providers.npi_identifiers_dropped += standIn.identifier.length - kept.length;
        if (kept.length) standIn.identifier = kept; else delete standIn.identifier;
      }
      if (!safeProvider(standIn)) fault('PROVIDER_RESIDUE');
      providers.sanitized += 1;
      source = standIn;
    }
    const resource = cloneFhirValue(source);
    const rewrite = (node: unknown, field = ''): void => {
      if (Array.isArray(node)) node.forEach(child => rewrite(child, field));
      else if (isRecord(node)) {
        if (providerDisplayOnly(node, field)) fault('PROVIDER_RESIDUE');
        for (const [key, child] of Object.entries(node)) {
          if (key === 'reference' && typeof child === 'string') {
            const target = map.get(child)!;
            node[key] = `${target.type}/${target.id}`;
            if (PROVIDER_NOUNS[target.type] !== undefined) {
              collectProviderText(node.display, removedProviderText, 'display');
              delete node.display;
            } else if (PROVIDER_TYPES.has(target.type) && 'display' in node
              && !(target.type === 'Practitioner' && syntheticPractitionerDisplay(target.resource, node.display))) fault('PROVIDER_RESIDUE');
          }
          else rewrite(child, key);
        }
      }
    };
    rewrite(resource);
    const body = stringifyFhir(resource);
    // Against the source as parsed, before any clone or rewrite: a lexeme change anywhere in between refuses.
    if (numberLexemes(parseFhirJson(body)).join('\u0000') !== numberLexemes(source).join('\u0000')) fault('LEXEME_CHANGED');
    ndjsonBytes += Buffer.byteLength(body, 'utf8') + 1;
    if (ndjsonBytes > selection.maxBytes) fault('SEED_TOO_LARGE');
    bodies.set(url, body);
  }
  const residue = droppedValues.map(value => new RegExp(`(?:^|[^A-Za-z0-9])${escapeRegExp(value)}(?:$|[^A-Za-z0-9])`));
  for (const body of bodies.values()) {
    const strings = decodedStrings(parseFhirJson(body));
    if (residue.some(pattern => strings.some(text => pattern.test(text)))) fault('IDENTIFIER_RESIDUE');
  }
  const providerResidue = removedProviderText.map(providerTextPattern);
  for (const body of bodies.values()) {
    const strings = decodedStrings(parseFhirJson(body));
    if (providerResidue.some(pattern => strings.some(text => pattern.test(text)))) fault('PROVIDER_RESIDUE');
  }

  // Kahn's order over the reference graph: each target before its referrers; ties by type order, then id.
  const rank = (url: string) => { const e = entries.get(url)!; return [(SEED_TYPES as readonly string[]).indexOf(e.type), e.id] as const; };
  const before = (a: string, b: string) => { const [ra, ia] = rank(a); const [rb, ib] = rank(b); return ra !== rb ? ra - rb : ia < ib ? -1 : ia > ib ? 1 : 0; };
  const indegree = new Map<string, number>(), referrers = new Map<string, string[]>();
  for (const url of seed) {
    // A self-reference counts as its own dependency, so it never reaches zero and is refused as a cycle below.
    const deps = new Set([...targets.get(url)!.values()].map(t => t.url));
    indegree.set(url, deps.size);
    for (const dep of deps) { const list = referrers.get(dep); if (list) list.push(url); else referrers.set(dep, [url]); }
  }
  const ready = [...seed].filter(url => indegree.get(url) === 0).sort(before);
  const order: string[] = [];
  while (ready.length) {
    const next = ready.shift()!;
    order.push(next);
    for (const referrer of referrers.get(next) ?? []) {
      const left = indegree.get(referrer)! - 1;
      indegree.set(referrer, left);
      if (left === 0) {
        let at = 0;
        while (at < ready.length && before(ready[at]!, referrer) < 0) at++;
        ready.splice(at, 0, referrer);
      }
    }
  }
  if (order.length !== seed.size) fault('REFERENCE_CYCLE');

  const resources: SeedResource[] = order.map(url => {
    const { type, id } = entries.get(url)!;
    const body = bodies.get(url)!;
    return { type, id, bytes: Buffer.byteLength(body, 'utf8'), sha256: sha256(body), origin: 'natural' };
  });
  const ndjson = order.map(url => `${bodies.get(url)!}\n`).join('');
  const counts: Record<string, number> = {};
  for (const r of resources) counts[r.type] = (counts[r.type] ?? 0) + 1;
  const result: SeedResult = { ndjson, manifest: {
    schema: 'fireboat-quickstart-seed/1',
    inputs: ordered.map(f => ({ name: f.name, bytes: f.bytes.byteLength, sha256: sha256(f.bytes) })),
    selection, patient: `Patient/${patient.id}`, counts, dropped_patient_identifiers: dropped, providers, resources, ndjson_sha256: sha256(ndjson),
  } };
  checkSeedContract(order.map(url => parseFhirJson(bodies.get(url)!) as Rec), result.manifest);
  return result;
}

/**
 * The contract every seed this transform writes satisfies, checked on the written resources alone; the edge merge
 * applies it to a natural seed it did not produce. Admitted types only; one living Patient, `manifest.patient`, with no
 * government identifiers; the closed synthetic provider shapes, without contact fields or NPI identifiers; no contained resources; every
 * reference a literal `Type/id` to an earlier row, consistent with its `type`, naming no Patient but the selected one
 * and carrying only a matching synthetic Practitioner display (no other provider display, including display-only references);
 * that Patient's lab Observations and lab reports inside the window,
 * and that Patient's Encounters and Conditions; a manifest whose inputs, counts and removal tallies have their shapes.
 */
export function checkSeedContract(resources: readonly Rec[], manifest: SeedManifest): void {
  const bad = (): never => fault('SEED_CONTRACT');
  const tally = (value: unknown, keys: readonly string[]) => isRecord(value) && Object.keys(value).length === keys.length
    && keys.every(key => Number.isSafeInteger(value[key]) && (value[key] as number) >= 0);
  if (!Array.isArray(manifest.inputs) || !manifest.inputs.length || !manifest.inputs.every(i => isRecord(i) && Object.keys(i).length === 3 && typeof i.name === 'string'
    && Number.isSafeInteger(i.bytes) && typeof i.sha256 === 'string' && /^[a-f0-9]{64}$/.test(i.sha256))
    || new Set(manifest.inputs.map(i => i.name)).size !== manifest.inputs.length) bad();
  if (!tally(manifest.dropped_patient_identifiers, ['SS', 'DL', 'PPN']) || !tally(manifest.providers, ['sanitized', 'npi_identifiers_dropped'])) bad();
  const counts: Record<string, number> = {};
  for (const r of resources) counts[r.resourceType as string] = (counts[r.resourceType as string] ?? 0) + 1;
  if (!isRecord(manifest.counts) || JSON.stringify(Object.entries(manifest.counts).sort()) !== JSON.stringify(Object.entries(counts).sort())) bad();
  const [windowStart] = utcInterval(manifest.selection.window.start), [windowEnd] = utcInterval(manifest.selection.window.end);
  const position = new Map(resources.map((r, i) => [`${r.resourceType as string}/${r.id as string}`, i]));
  if (position.size !== resources.length) bad();
  const patients = resources.filter(r => r.resourceType === 'Patient');
  if (patients.length !== 1 || `Patient/${patients[0]!.id as string}` !== manifest.patient || patients[0]!.deceasedBoolean === true
    || patients[0]!.deceasedDateTime !== undefined || (Array.isArray(patients[0]!.identifier) && patients[0]!.identifier.some(i => governmentIdentifierKind(i)))) bad();
  const ownedBy = (resource: Rec) => isRecord(resource.subject) && resource.subject.reference === manifest.patient;
  resources.forEach((resource, i) => {
    const type = resource.resourceType as string;
    if (!(SEED_TYPES as readonly string[]).includes(type) || 'contained' in resource) bad();
    if (PROVIDER_TYPES.has(type) && !safeProvider(resource)) bad();
    const visit = (node: unknown, field = ''): void => {
      if (Array.isArray(node)) { node.forEach(child => visit(child, field)); return; }
      if (!isRecord(node)) return;
      if (providerDisplayOnly(node, field)) bad();
      if ('reference' in node || isRecord(node.identifier) && !('reference' in node) && !Array.isArray(node.identifier)) {
        const match = typeof node.reference === 'string' ? /^([A-Z][A-Za-z]+)\/([A-Za-z0-9.-]{1,64})$/.exec(node.reference) : null;
        const at = match ? position.get(node.reference as string) : undefined;
        if (!match || at === undefined || at >= i || (node.type !== undefined && node.type !== match[1])
          || (match[1] === 'Patient' && node.reference !== manifest.patient) || (PROVIDER_NOUNS[match[1]!] !== undefined && 'display' in node)) bad();
        if (match && at !== undefined && PROVIDER_TYPES.has(match[1]!) && 'display' in node
          && !(match[1] === 'Practitioner' && syntheticPractitionerDisplay(resources[at]!, node.display))) bad();
      }
      for (const [key, child] of Object.entries(node)) if (key !== 'reference') visit(child, key);
    };
    visit(resource);
    if (type === 'Observation' || type === 'DiagnosticReport') {
      const interval = effectiveInterval(resource);
      if (!hasCoding(resource.category, type === 'Observation' ? OBSERVATION_LAB : REPORT_LAB) || !ownedBy(resource)
        || interval === undefined || interval[0] < windowStart || interval[1] > windowEnd) bad();
      if (type === 'DiagnosticReport' && !(Array.isArray(resource.result) && resource.result.length > 0
        && resource.result.every(r => isRecord(r) && typeof r.reference === 'string' && r.reference.startsWith('Observation/')))) bad();
    }
    if (PATIENT_LINKED.has(type) && !ownedBy(resource)) bad();
  });
}

export type TransformCliFault = TransformFault | 'USAGE' | 'EXPORT_MISSING' | 'OUT_NOT_EMPTY';
/**
 * Reads every top-level `*.json` regular file of the export directory (Synthea writes a flat `fhir/` directory; a
 * `.json` entry that is not a regular file refuses) and writes `resources.ndjson` and `seed-manifest.json` into a
 * new or empty directory. Every failure, including filesystem preflight, is a fixed code.
 */
export function runTransformCli(args: readonly string[]): { code: 0 | 1; line: string } {
  const failed = (code: TransformCliFault) => ({ code: 1 as const, line: `transform-synthea: ${code}` });
  try {
    const [exportDir, outDir] = args;
    if (!exportDir || !outDir || args.length !== 2) return failed('USAGE');
    if (!existsSync(exportDir) || !statSync(exportDir).isDirectory()) return failed('EXPORT_MISSING');
    if (existsSync(outDir) && (!lstatSync(outDir).isDirectory() || readdirSync(outDir).length)) return failed('OUT_NOT_EMPTY');
    const json = readdirSync(exportDir, { withFileTypes: true }).filter(d => d.name.endsWith('.json'));
    if (!json.length) return failed('EXPORT_MISSING');
    if (json.some(d => !d.isFile())) return failed('EXPORT_INVALID');
    // Sizes are checked before anything is read; each read is bounded and must return exactly the size seen.
    const sizes = json.map(d => statSync(join(exportDir, d.name)).size);
    if (sizes.reduce((n, size) => n + size, 0) > QUICKSTART_SELECTION.maxInputBytes) return failed('INPUT_TOO_LARGE');
    const readExact = (path: string, size: number): Buffer => {
      const fd = openSync(path, 'r');
      try {
        const buffer = Buffer.alloc(size + 1);
        if (readSync(fd, buffer, 0, size + 1, 0) !== size) throw new TransformError('EXPORT_INVALID');
        return buffer.subarray(0, size);
      } finally { closeSync(fd); }
    };
    const { ndjson, manifest } = transformSyntheaExport(json.map((d, i) => ({ name: d.name, bytes: readExact(join(exportDir, d.name), sizes[i]!) })));
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'resources.ndjson'), ndjson);
    writeFileSync(join(outDir, 'seed-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    const counts = Object.entries(manifest.counts).map(([type, n]) => `${type} ${n}`).join(', ');
    return { code: 0, line: `transform-synthea: ${manifest.resources.length} resources (${counts}); ndjson sha256 ${manifest.ndjson_sha256}` };
  } catch (error) {
    return failed(error instanceof TransformError ? error.code : 'EXPORT_INVALID');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { code, line } = runTransformCli(process.argv.slice(2));
  (code ? process.stderr : process.stdout).write(`${line}\n`);
  process.exitCode = code;
}
