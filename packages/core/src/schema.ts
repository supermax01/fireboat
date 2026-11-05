import source from './generated/r4-index.json' with { type: 'json' };
import { GatewayFault } from './transport.js';

interface ElementDefinition {
  min: number; max: string; types: string[]; modifier?: boolean;
  content_reference?: string; short?: string;
  binding?: { strength?: string; valueSet: string }; targets?: string[];
}
interface Definition { url: string; kind: string; elements: Record<string, ElementDefinition> }
interface Catalog {
  package: string; version: string; license: string; source_url: string; source_sha256: string;
  definitions: Record<string, Definition>;
}
export interface TypeContext { definition: string; path: string }
/** `name` is the declared element name (`effective[x]` for `effectiveInstant`); `modifier` mirrors R4 isModifier. */
export interface ResolvedElement { context?: TypeContext; types: string[]; name?: string; modifier?: boolean; targets?: string[] }

const catalog = source as unknown as Catalog;
export const R4_SCHEMA = { package: catalog.package, version: catalog.version, source_url: catalog.source_url, source_sha256: catalog.source_sha256, definitions: Object.keys(catalog.definitions).length };
const children = new Map<string, Map<string, Map<string, ElementDefinition>>>();
for (const [name, definition] of Object.entries(catalog.definitions)) {
  const parents = new Map<string, Map<string, ElementDefinition>>();
  for (const [path, element] of Object.entries(definition.elements)) {
    const dot = path.lastIndexOf('.');
    const parent = dot < 0 ? '' : path.slice(0, dot);
    const key = path.slice(dot + 1);
    if (!parents.has(parent)) parents.set(parent, new Map());
    parents.get(parent)!.set(key, element);
  }
  children.set(name, parents);
}

export function resourceTypeContext(name: string): TypeContext | undefined {
  return Object.hasOwn(catalog.definitions, name) ? { definition: name, path: '' } : undefined;
}

/** F-1: true only for a pinned R4 definition whose kind is `resource` (not a datatype or primitive). */
export function isFhirResourceType(name: string): boolean {
  return catalog.definitions[name]?.kind === 'resource';
}

function followReference(context: TypeContext, element: ElementDefinition): ResolvedElement {
  let current = context;
  let found = element;
  for (let hops = 0; found.content_reference && hops < 8; hops++) {
    if (!found.content_reference.startsWith('#')) return { types: [] };
    const [definition, ...parts] = found.content_reference.slice(1).split('.');
    current = { definition: definition!, path: parts.join('.') };
    const next = catalog.definitions[current.definition]?.elements[current.path];
    if (!next) return { types: [] };
    found = next;
  }
  if (found.content_reference) return { types: [] };
  if (children.get(current.definition)?.has(current.path)) return { context: current, types: found.types };
  const type = found.types.length === 1 ? found.types[0] : undefined;
  return { types: found.types, ...(type && resourceTypeContext(type) ? { context: resourceTypeContext(type) } : {}) };
}

/** Resolve actual JSON choice names, backbone paths, references and datatypes. */
export function resolveElement(parent: TypeContext | undefined, key: string): ResolvedElement {
  if (!parent) return { types: [] };
  if (key.startsWith('_')) {
    // A primitive companion carries only Element content (id, extension); the
    // base Element definition is emitted by the generator for this purpose.
    const base = resolveElement(parent, key.slice(1));
    // Only a primitive has a companion: `_x` beside a complex x is judged by x's own rules, so a scalar there is a
    // malformed x rather than an Element.
    if (base.types.length && !base.types.some(type => /^[a-z]/.test(type))) return base;
    return base.types.length ? { types: ['Element'], context: { definition: 'Element', path: '' }, ...(base.name ? { name: base.name } : {}), ...(base.modifier ? { modifier: true } : {}) } : { types: [] };
  }
  const fields = children.get(parent.definition)?.get(parent.path);
  if (!fields) return { types: [] };
  let name = key;
  let element = fields.get(key);
  let chosen: string | undefined;
  if (!element) {
    for (const [candidate, field] of fields) {
      if (!candidate.endsWith('[x]')) continue;
      const stem = candidate.slice(0, -3);
      chosen = field.types.find(type => `${stem}${type[0]?.toUpperCase()}${type.slice(1)}` === key);
      if (chosen) { name = candidate; element = field; break; }
    }
  }
  if (!element) return { types: [] };
  const path = parent.path ? `${parent.path}.${name}` : name;
  const resolved = followReference({ definition: parent.definition, path }, chosen ? { ...element, types: [chosen] } : element);
  return { ...resolved, name, ...(element.modifier ? { modifier: true } : {}), ...(element.targets && resolved.types.includes('Reference') ? { targets: element.targets } : {}) };
}

/** Root-level R4 isModifier element names (choice names keep `[x]`). */
export function modifierElements(type: string): string[] {
  return [...(children.get(type)?.get('')?.entries() ?? [])].filter(([, element]) => element.modifier).map(([name]) => name);
}

/** Declared element names of a definition context, for policy allowlists and recipe checks. */
export function elementNames(type: string, path = ''): string[] {
  return [...(children.get(type)?.get(path)?.keys() ?? [])];
}

export function isUriElement(element: ResolvedElement): boolean {
  return element.types.some(type => ['uri', 'url', 'canonical', 'oid', 'uuid'].includes(type));
}

export function schemaPage(type: string, path: string, offset: number, limit: number) {
  let context = resourceTypeContext(type);
  if (!context) throw new GatewayFault('UNSUPPORTED_DEFINITION', 'No pinned R4 base definition is available for this type.');
  if (path) for (const key of path.split('.')) {
    const next = resolveElement(context, key);
    if (!next.context) throw new GatewayFault('INVALID_ELEMENT_PATH', 'Element path is absent, primitive, or not traversable in the pinned R4 definition.');
    context = next.context;
  }
  const definition = catalog.definitions[context.definition]!;
  const fields = [...(children.get(context.definition)?.get(context.path) ?? new Map<string, ElementDefinition>())];
  return {
    resource_type: type, path, definition: definition.url,
    schema: R4_SCHEMA, evidence: 'pinned_base_definition', profile_validation: 'not_performed',
    total_elements: fields.length,
    elements: fields.slice(offset, offset + limit).map(([name, field]) => ({
      path: path ? `${path}.${name}` : name,
      ...field,
      ...(name.endsWith('[x]') ? { json_names: field.types.map(value => `${name.slice(0, -3)}${value[0]?.toUpperCase()}${value.slice(1)}`) } : {}),
    })),
  };
}
