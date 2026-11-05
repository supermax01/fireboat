// The module graph Node itself resolves (packaging slice 8): each entry is imported in a fresh child whose resolve hook
// (module.registerHooks) records every (parent, specifier) pair as V8 parsed it, whatever comments or spellings the source
// uses. Linking resolves every static import before any module runs, so an entry that throws while evaluating (the
// observer preload without its pipe) still yields its whole static graph; entries load concurrently and the record is
// written on exit, so one that never settles hides nothing. Executed dynamic loads are recorded too; latent ones are the
// caller's separate source-form check. This graph describes observed resolution, not all possible runtime capabilities.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** `imports`: module path relative to the graph root (POSIX separators) -> the specifiers it requested, in order; `loaded`: every module below the root that resolved. */
export type ModuleGraph = Readonly<{ imports: ReadonlyMap<string, readonly string[]>; loaded: ReadonlySet<string> }>;

const OBSERVER = `
import { registerHooks } from 'node:module';
import { writeFileSync } from 'node:fs';
const seen = [];
registerHooks({ resolve(specifier, context, next) {
  let url = null;
  try { const result = next(specifier, context); url = result.url; return result; } finally { seen.push([context.parentURL ?? null, specifier, url]); }
} });
process.on('exit', () => writeFileSync(process.env.GRAPH_OUT, JSON.stringify(seen)));
await Promise.allSettled(JSON.parse(process.env.GRAPH_ENTRIES).map(entry => import(entry)));
process.exit(0);
`;

/** Observes the graph below `root` reached from `entries` (root-relative paths); requests from outside `root` are dropped. */
export function observedGraph(root: string, entries: readonly string[]): ModuleGraph {
  const scratch = mkdtempSync(join(tmpdir(), 'fireboat-graph-')), out = join(scratch, 'graph.json');
  try {
    // Any exit status: an unsettled entry ends the child with 13, after the record is written. No record, no graph.
    spawnSync(process.execPath, ['--input-type=module', '-e', OBSERVER], { cwd: root, encoding: 'utf8', timeout: 30_000,
      env: { PATH: process.env.PATH ?? '', GRAPH_OUT: out, GRAPH_ENTRIES: JSON.stringify(entries.map(entry => pathToFileURL(join(root, entry)).href)) } });
    // Node reports real paths; compare them with the root's own real path.
    const imports = new Map<string, string[]>(), loaded = new Set<string>(), real = realpathSync(root);
    const below = (url: string | null): string | undefined => {
      if (!url?.startsWith('file:')) return undefined;
      const path = relative(real, fileURLToPath(url));
      return path.startsWith('..') || path.startsWith(sep) ? undefined : path.split(sep).join('/');
    };
    for (const [parent, specifier, url] of JSON.parse(readFileSync(out, 'utf8')) as [string | null, string, string | null][]) {
      const resolved = below(url);
      if (resolved !== undefined) loaded.add(resolved);
      const from = below(parent);
      if (from !== undefined) imports.set(from, [...(imports.get(from) ?? []), specifier]);
    }
    return { imports, loaded };
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
