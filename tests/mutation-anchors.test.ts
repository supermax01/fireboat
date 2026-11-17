import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

type Edit = { file: string; find: string; replace: string };
type Mutant = Edit & { id: string; edits?: Edit[]; prepare?: string };
const gate = await import(new URL('../scripts/mutation-guards.mjs', import.meta.url).href) as {
  MUTANTS: Mutant[];
  mutationEdits: (mutant: Mutant) => Edit[];
  mutationPreparation: (mutant: Mutant) => { file: string; argv: string[] } | null;
  applyMutationEdits: (mutant: Mutant, source: Map<string, string>) => { failures: { file: string; count: number; reason: string }[] };
};
const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));

// Maintenance only: included in pristine baselines, excluded from all mutant runs.
// Compounds use the judge's shared sequential applicator: each later edit sees
// earlier edits of that mutant, while every mutant starts from pristine files.
test('mutation anchors: all registered edits match exactly once inside the repository', () => {
  const failures: string[] = [], ids = new Set<string>(), contents = new Map<string, string>();
  const inside = (path: string): boolean => {
    const rel = relative(root, path);
    return !!rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  };
  const load = (file: string): string => {
    const path = resolve(root, file);
    if (isAbsolute(file) || !inside(path) || !inside(realpathSync(path))) throw new Error('path escapes repository');
    if (!contents.has(path)) contents.set(path, readFileSync(path, 'utf8'));
    return contents.get(path)!;
  };
  for (const mutant of gate.MUTANTS) {
    if (ids.has(mutant.id)) failures.push(`${mutant.id}: duplicate id`);
    ids.add(mutant.id);
    try {
      const preparation = gate.mutationPreparation(mutant);
      if (preparation) {
        // Fixed preparation has no find/replace anchors. Both the generated
        // artifact restored by the judge and its whitelisted emitter must exist.
        load(preparation.file);
        load(preparation.argv[2]!);
      }
      const sources = new Map<string, string>();
      for (const edit of gate.mutationEdits(mutant)) {
        try { sources.set(edit.file, load(edit.file)); }
        catch (error) { failures.push(`${mutant.id} ${edit.file}: count=unread ${(error as Error).message}`); }
      }
      for (const failure of gate.applyMutationEdits(mutant, sources).failures) {
        failures.push(`${mutant.id} ${failure.file}: count=${failure.count} ${failure.reason}`);
      }
    } catch (error) {
      failures.push(`${mutant.id}: count=unread ${(error as Error).message}`);
    }
  }
  assert.deepEqual(failures, [], `Invalid mutation anchors:\n${failures.join('\n')}`);
});
