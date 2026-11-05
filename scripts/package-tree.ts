import { createHash } from 'node:crypto';

export type TreeFaultCode = 'TREE_INVALID' | 'TREE_LIMIT' | 'TREE_PROBLEM' | 'TREE_INTEGRITY_MISSING' | 'TREE_OPTIONAL_MISMATCH' | 'TREE_MISMATCH';
export class TreeFault extends Error {
  readonly code: TreeFaultCode;
  constructor(code: TreeFaultCode) { super(code); this.name = 'TreeFault'; this.code = code; }
}
const fault = (code: TreeFaultCode): TreeFault => new TreeFault(code);
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const packageName = (v: unknown): v is string => typeof v === 'string' && /^(?:@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(v) && v.length <= 214;
const version = (v: unknown): v is string => typeof v === 'string' && /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/.test(v) && v.length <= 128;
const sri = (v: unknown): v is string => typeof v === 'string' && /^sha512-[A-Za-z0-9+/]{86}==$/.test(v) &&
  Buffer.from(v.slice(7), 'base64').toString('base64') === v.slice(7);
export type OptionalSelection = Readonly<{ name: string; version: string; os: readonly string[]; cpu: readonly string[]; selected: boolean }>;
export type TreeContext = Readonly<{ platform: Readonly<{ os: string; arch: string }>; optional: readonly OptionalSelection[] }>;
type CanonicalNode = Readonly<{ name: string; version: string; integrity: string | null; optional: boolean; dependencies: readonly CanonicalNode[] }>;
export type CanonicalTree = Readonly<{ schema: 1; platform: TreeContext['platform']; optional: readonly OptionalSelection[]; tree: CanonicalNode }>;
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const selector = (v: unknown): v is readonly string[] => Array.isArray(v) && v.length <= 16 && v.every(s =>
  typeof s === 'string' && /^!?[a-z0-9_-]{1,32}$/.test(s)) && new Set(v).size === v.length;
const matches = (values: readonly string[], actual: string): boolean =>
  !values.includes(`!${actual}`) && (values.every(v => v.startsWith('!')) || values.includes(actual) || values.includes('any'));

// Collectors must add observed installed SRI to each dependency node. npm ls
// alone often omits integrity; absence refuses rather than borrowing the approved
// lock's value and claiming that it was observed. No install or IO occurs here.
export function canonicalDependencyTree(input: unknown, context: TreeContext): CanonicalTree {
  if (!record(context) || Object.keys(context).length !== 2 || !record(context.platform) || Object.keys(context.platform).length !== 2 ||
    typeof context.platform.os !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(context.platform.os) ||
    typeof context.platform.arch !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(context.platform.arch) ||
    !Array.isArray(context.optional) || context.optional.length > 1024) throw fault('TREE_INVALID');
  const selections = new Map<string, OptionalSelection>();
  for (const s of context.optional) {
    if (!record(s) || Object.keys(s).length !== 5 || !packageName(s.name) || !version(s.version) || !selector(s.os) || !selector(s.cpu) ||
      typeof s.selected !== 'boolean' || selections.has(`${s.name}@${s.version}`) ||
      (s.selected && (!matches(s.os, context.platform.os) || !matches(s.cpu, context.platform.arch)))) throw fault('TREE_OPTIONAL_MISMATCH');
    selections.set(`${s.name}@${s.version}`, s as OptionalSelection);
  }
  let nodes = 0;
  const ancestors = new Set<object>(), observed = new Set<string>();
  const visit = (value: unknown, edge: string | undefined, depth: number): CanonicalNode => {
    if (++nodes > 8192 || depth > 64) throw fault('TREE_LIMIT');
    if (!record(value) || ancestors.has(value)) throw fault('TREE_INVALID');
    if (['missing', 'extraneous', 'invalid', 'error', 'link', 'dev'].some(k => Boolean(value[k])) ||
      (value.problems !== undefined && (!Array.isArray(value.problems) || value.problems.length !== 0))) throw fault('TREE_PROBLEM');
    const name = edge ?? value.name;
    if (!packageName(name) || !version(value.version) || (value.name !== undefined && value.name !== name) ||
      (value.optional !== undefined && typeof value.optional !== 'boolean')) throw fault('TREE_INVALID');
    if (depth > 0 && !sri(value.integrity)) throw fault('TREE_INTEGRITY_MISSING');
    const key = `${name}@${value.version}`, selection = selections.get(key);
    if (depth > 0) observed.add(key);
    if ((selection && !selection.selected) || (value.optional === true && !selection?.selected)) throw fault('TREE_OPTIONAL_MISMATCH');
    if (value.dependencies !== undefined && !record(value.dependencies)) throw fault('TREE_INVALID');
    ancestors.add(value);
    const dependencies = Object.entries(value.dependencies ?? {}).sort(([a], [b]) => compare(a, b)).map(([name, v]) => visit(v, name, depth + 1));
    ancestors.delete(value);
    return { name, version: value.version, integrity: depth === 0 ? null : value.integrity as string,
      optional: value.optional === true || selection?.selected === true, dependencies };
  };
  const tree = visit(input, undefined, 0);
  for (const [key, selection] of selections) if (selection.selected !== observed.has(key)) throw fault('TREE_OPTIONAL_MISMATCH');
  const optional = [...selections.values()].sort((a, b) => compare(`${a.name}@${a.version}`, `${b.name}@${b.version}`))
    .map(s => ({ ...s, os: [...s.os].sort(), cpu: [...s.cpu].sort() }));
  return { schema: 1, platform: { os: context.platform.os, arch: context.platform.arch }, optional, tree };
}
export const dependencyTreeHash = (input: unknown, context: TreeContext): string =>
  createHash('sha256').update(JSON.stringify(canonicalDependencyTree(input, context))).digest('hex');
export function verifyDependencyTree(input: unknown, context: TreeContext, approvedTreeHash: string): string {
  if (!/^[a-f0-9]{64}$/.test(approvedTreeHash)) throw fault('TREE_INVALID');
  const actualTreeHash = dependencyTreeHash(input, context);
  if (actualTreeHash !== approvedTreeHash) throw fault('TREE_MISMATCH');
  return actualTreeHash;
}
