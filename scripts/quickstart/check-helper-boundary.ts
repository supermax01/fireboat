#!/usr/bin/env node
// Packaging slice 8 (design D4/H07): the compiled quickstart helper's import boundary, over the graph Node itself resolves
// (scripts/quickstart/module-graph.ts). The bin's closure may load only Node built-ins, the helper manifest's own dependency
// and an explicit list of reviewed pure shared modules; the observer preload (launched by the helper client) and the
// standalone timer load built-ins only. A separate syntax check refuses named loading/evaluation forms in reviewed source. The CLI then copies that closure
// into the nested helper layout beside a node_modules holding exactly the helper lock's packages and runs the bin there.
// usage (postbuild): node --import tsx scripts/quickstart/check-helper-boundary.ts
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { observedGraph, type ModuleGraph } from './module-graph.js';
import { SyntaxKind, type Node, type StringLiteral, type ParenthesizedExpression, type BinaryExpression, type TemplateExpression, type Identifier, type CallExpression, type PropertyAccessExpression, type BindingElement, type MetaProperty, type ImportDeclaration, type ExportDeclaration } from 'typescript/unstable/ast';
import { API } from 'typescript/unstable/sync';
import { createVirtualFileSystem } from 'typescript/unstable/fs';

/** Reviewed pure modules outside the helper directory: the lossless reader and the narrow oracle with its task contracts. */
export const HELPER_SHARED: readonly string[] = [
  'packages/core/src/decimal.js', 'packages/evals/src/check-contracts.js', 'packages/evals/src/evidence-oracle.js', 'packages/evals/src/package-tasks.js',
];
/** Dist-relative entry points. Only the bin's own helper modules may reach the SDK. */
export const HELPER_ENTRIES: Readonly<Record<string, 'sdk' | 'builtin'>> = {
  'examples/quickstart/main.js': 'sdk', 'examples/quickstart/request-observer.js': 'builtin', 'examples/quickstart/timing.js': 'builtin',
};
const HELPER_DIRECTORY = 'examples/quickstart/';
/**
 * Separate from the observed graph: inspect the parsed JavaScript, including unexecuted functions. This restricts
 * named loading/evaluation forms in reviewed source, not arbitrary JavaScript obfuscation. The pinned compiler parses
 * a single virtual file with no libraries or resolution; its local native API is closed before returning. No source
 * is evaluated and no files are written. Only import.meta.url is admitted, so the metadata object cannot escape.
 */
const FORBIDDEN_NAMES = new Set(['getBuiltinModule', 'createRequire', 'require', 'eval', 'Function', 'binding', 'dlopen']);
const FORBIDDEN_MODULES = new Set(['node:module', 'node:vm', 'node:worker_threads']);
export function forbiddenLoadingForm(code: string): boolean {
  const config = '/boundary/tsconfig.json', file = '/boundary/code.js';
  const files: Record<string, string> = {
    [config]: JSON.stringify({ compilerOptions: { allowJs: true, noLib: true, noResolve: true, types: [], module: 'esnext', target: 'esnext' }, files: ['code.js'] }), [file]: code,
  };
  const fs = createVirtualFileSystem(files);
  fs.readFile = path => files[path] ?? null; // Never fall back to the host filesystem for compiler input.
  const api = new API({ fs });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [config] });
    try {
      const program = snapshot.getProject(config)?.program, source = program?.getSourceFile(file);
      if (!source || program!.getSyntacticDiagnostics(file).length) return true;
      let forbidden = false;
      const constant = (node: Node): string | undefined => {
        if (node.kind === SyntaxKind.StringLiteral || node.kind === SyntaxKind.NoSubstitutionTemplateLiteral) return (node as StringLiteral).text;
        if (node.kind === SyntaxKind.ParenthesizedExpression) return constant((node as ParenthesizedExpression).expression);
        if (node.kind === SyntaxKind.BinaryExpression) {
          const n = node as BinaryExpression, left = constant(n.left), right = constant(n.right);
          if (n.operatorToken.kind === SyntaxKind.PlusToken && left !== undefined && right !== undefined) return left + right;
        }
        if (node.kind === SyntaxKind.TemplateExpression) {
          const n = node as TemplateExpression; let text = n.head.text;
          for (const span of n.templateSpans) { const part = constant(span.expression); if (part === undefined) return undefined; text += part + span.literal.text; }
          return text;
        }
        return undefined;
      };
      const visit = (node: Node): void => {
        if (node.kind === SyntaxKind.Identifier && ['getBuiltinModule', 'createRequire', 'require', 'eval', 'Function'].includes((node as Identifier).text)) forbidden = true;
        const name = constant(node);
        if (name !== undefined && FORBIDDEN_NAMES.has(name)) forbidden = true;
        if (node.kind === SyntaxKind.CallExpression && (node as CallExpression).expression.kind === SyntaxKind.ImportKeyword) forbidden = true;
        if (node.kind === SyntaxKind.PropertyAccessExpression && FORBIDDEN_NAMES.has((node as PropertyAccessExpression).name.text)) forbidden = true;
        if (node.kind === SyntaxKind.BindingElement) {
          const n = node as BindingElement, key = n.propertyName ?? n.name;
          if (key?.kind === SyntaxKind.Identifier && FORBIDDEN_NAMES.has((key as Identifier).text)) forbidden = true;
        }
        if (node.kind === SyntaxKind.MetaProperty && (node as MetaProperty).keywordToken === SyntaxKind.ImportKeyword) {
          const parent = node.parent;
          if (parent.kind !== SyntaxKind.PropertyAccessExpression || (parent as PropertyAccessExpression).name.text !== 'url' || (parent as PropertyAccessExpression).questionDotToken) forbidden = true;
        }
        if (node.kind === SyntaxKind.ImportDeclaration || node.kind === SyntaxKind.ExportDeclaration) {
          const specifier = (node as ImportDeclaration | ExportDeclaration).moduleSpecifier;
          if (specifier?.kind === SyntaxKind.StringLiteral && FORBIDDEN_MODULES.has((specifier as StringLiteral).text)) forbidden = true;
        }
        node.forEachChild(visit);
      };
      visit(source); return forbidden;
    } finally { snapshot.dispose(); }
  } finally { api.close(); }
}
// Compatibility for callers of the earlier source-form check; the check uses a parsed syntax tree.
export const DYNAMIC = Object.freeze({ test: forbiddenLoadingForm });

export class BoundaryFault extends Error {
  constructor(readonly code: 'HELPER_BOUNDARY' | 'HELPER_LOAD', readonly detail: string) { super(`${code} ${detail}`); }
}
export type Boundary = Readonly<{ modules: readonly string[]; packages: readonly string[] }>;

const helperModule = (path: string): boolean =>
  path.startsWith(HELPER_DIRECTORY) && !path.slice(HELPER_DIRECTORY.length).includes('/') && /\.(?:js|json)$/.test(path);
const allowedModule = (target: string, local: boolean): boolean => HELPER_SHARED.includes(target) || (local && helperModule(target));
const dependencyOf = (specifier: string, dependencies: readonly string[]): string | undefined =>
  dependencies.find(name => specifier === name || specifier.startsWith(`${name}/`));

/** Walks the observed graph from every entry over dist-relative POSIX paths, refusing anything outside that entry's allowance. */
export async function helperBoundary(graph: ModuleGraph, read: (path: string) => Promise<string>, dependencies: readonly string[]): Promise<Boundary> {
  const modules = new Set<string>(), packages = new Set<string>();
  for (const [entry, allowance] of Object.entries(HELPER_ENTRIES)) {
    const pending = [entry], seen = new Set<string>();
    while (pending.length) {
      const path = pending.pop()!;
      if (seen.has(path)) continue;
      if (!graph.loaded.has(path)) throw new BoundaryFault('HELPER_LOAD', `${path} did not resolve`);
      seen.add(path); modules.add(path);
      if (path.endsWith('.json')) continue;
      if (DYNAMIC.test(await read(path))) throw new BoundaryFault('HELPER_BOUNDARY', `${path} uses a forbidden loading form`);
      // Shared modules stay pure: built-ins and other shared modules only.
      const local = allowance === 'sdk' && !HELPER_SHARED.includes(path);
      for (const specifier of graph.imports.get(path) ?? []) {
        if (FORBIDDEN_MODULES.has(specifier)) throw new BoundaryFault('HELPER_BOUNDARY', `${path} -> ${specifier}`);
        if (specifier.startsWith('node:')) continue;
        if (allowance === 'builtin') throw new BoundaryFault('HELPER_BOUNDARY', `${path} -> ${specifier}`);
        if (specifier.startsWith('.')) {
          const target = posix.normalize(posix.join(posix.dirname(path), specifier));
          if (!allowedModule(target, local)) throw new BoundaryFault('HELPER_BOUNDARY', `${path} -> ${specifier}`);
          pending.push(target);
          continue;
        }
        const dependency = local ? dependencyOf(specifier, dependencies) : undefined;
        if (dependency === undefined) throw new BoundaryFault('HELPER_BOUNDARY', `${path} -> ${specifier}`);
        packages.add(dependency);
      }
    }
  }
  return { modules: [...modules].sort(), packages: [...packages].sort() };
}

type HelperManifest = Readonly<{ bin?: Record<string, string>; dependencies?: Record<string, string> }>;
type HelperLock = Readonly<{ packages: Record<string, { version?: string }> }>;

/** Boundary of root's compiled helper, then its bin run with no command from the nested layout (expects exit 2, CLI_USAGE). */
export async function checkHelperBoundary(root: string): Promise<string> {
  const json = async <T>(path: string): Promise<T> => JSON.parse(await readFile(join(root, path), 'utf8')) as T;
  const helper = await json<HelperManifest>('examples/quickstart/package.json');
  const lock = await json<HelperLock>('examples/quickstart/package-lock.json');
  if (helper.bin?.['fireboat-quickstart'] !== 'dist/examples/quickstart/main.js') throw new BoundaryFault('HELPER_BOUNDARY', 'bin');
  const dist = join(root, 'dist');
  const boundary = await helperBoundary(observedGraph(dist, Object.keys(HELPER_ENTRIES)), path => readFile(join(dist, path), 'utf8'), Object.keys(helper.dependencies ?? {}));
  const stage = await mkdtemp(join(tmpdir(), 'fireboat-helper-boundary-'));
  try {
    for (const name of ['package.json', 'package-lock.json']) await copyFile(join(root, 'examples/quickstart', name), join(stage, name));
    for (const path of boundary.modules) {
      await mkdir(dirname(join(stage, 'dist', path)), { recursive: true });
      await copyFile(join(root, 'dist', path), join(stage, 'dist', path));
    }
    for (const [path, entry] of Object.entries(lock.packages)) {
      if (!path) continue;
      const installed = await json<{ version?: string }>(join(path, 'package.json'));
      if (installed.version !== entry.version) throw new BoundaryFault('HELPER_LOAD', `${path} ${installed.version}`);
      await mkdir(dirname(join(stage, path)), { recursive: true });
      await symlink(join(root, path), join(stage, path), 'dir');
    }
    const run = spawnSync(process.execPath, [join(stage, helper.bin['fireboat-quickstart'])], { cwd: stage, encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
    if (run.status !== 2 || run.stderr !== 'CLI_USAGE\n') throw new BoundaryFault('HELPER_LOAD', `exit ${run.status}`);
  } finally { await rm(stage, { recursive: true, force: true }); }
  return `modules=${boundary.modules.length} packages=${boundary.packages.join(',')} locked=${Object.keys(lock.packages).length - 1}`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(`check-helper-boundary: ${await checkHelperBoundary(fileURLToPath(new URL('../../', import.meta.url)))}`); }
  catch (error) {
    console.error(`check-helper-boundary: ${error instanceof BoundaryFault ? error.message : 'HELPER_LOAD'}`);
    process.exitCode = 1;
  }
}
