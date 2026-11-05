import * as ts from 'typescript/unstable/ast';
import { API } from 'typescript/unstable/sync';
import { createVirtualFileSystem } from 'typescript/unstable/fs';
const cache = new Map<string, ts.SourceFile>();
function parseSource(source: string): ts.SourceFile {
  const cached = cache.get(source); if (cached) return cached;
  const path = '/b2-oracle/source.ts', config = '/b2-oracle/tsconfig.json';
  const api = new API({ fs: createVirtualFileSystem({ [path]: source, [config]: JSON.stringify({ compilerOptions: { noLib: true, noResolve: true }, files: ['source.ts'] }) }) });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [config] });
    const file = snapshot.getProject(config)!.program.getSourceFile(path)!;
    if (!file) throw new Error('TypeScript parser returned no source');
    cache.set(source, file); return file;
  } finally { api.close(); }
}
/** Parse syntax, never search source text: comments and non-literal channel/predicate arguments are ignored. */
export function literalOracles(source: string): Set<string> {
  const result = new Set<string>();
  const literal = (node: ts.Node | undefined) => node && ts.isStringLiteral(node) ? node.text : undefined;
  const add = (channel: string | undefined, predicate: string | undefined) => { if (channel && predicate && !['harness', 'determinism'].includes(channel)) result.add(`${channel}:${predicate}`); };
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'check') add(literal(node.arguments[1]), literal(node.arguments[2]));
    if (ts.isObjectLiteralExpression(node)) {
      const field = (name: string) => node.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === name);
      add(literal(field('channel')?.initializer), literal(field('predicate')?.initializer));
    }
    node.forEachChild(visit);
  };
  visit(parseSource(source)); return result;
}
/** Fall-through labels share a body; bind only predicates in that clause, not any other case's predicate. */
export function scenarioClauses(source: string): Map<string, string> {
  const result = new Map<string, string>();
  const visit = (node: ts.Node) => {
    if (ts.isCaseBlock(node)) {
      let pending: string[] = [];
      for (const clause of node.clauses) {
        if (ts.isCaseClause(clause) && ts.isStringLiteral(clause.expression) && /^[A-Z]{3}-\d{2}$/.test(clause.expression.text)) pending.push(`B2-${clause.expression.text}`);
        if (clause.statements.length) { for (const id of pending) result.set(id, clause.statements.map(s => s.getText()).join('\n')); pending = []; }
      }
    }
    node.forEachChild(visit);
  };
  visit(parseSource(source)); return result;
}
