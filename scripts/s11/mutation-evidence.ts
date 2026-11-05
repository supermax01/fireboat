import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { hash, requireS11 } from './study.js';
// Passive imports only: no main(), judge(), worker, test suite or aggregate command is invoked.
// @ts-expect-error The existing registry/gate is a JavaScript module.
import { MUTANTS, mutationEdits, mutantListHash, candidateBinding, aggregateShardReports } from '../mutation-guards.mjs';

type Mutant = { id: string };
type Declared = { id: string; justification: string };
/** The preregistered selection rule: every registered mutant with an edit in these files is applicable. */
export const FIDELITY_SELECTION_RULE = 'packages/core/src/{projection,privacy,decimal,withheld,contracts,index,store}.ts | packages/server/src/index.ts | packages/evals/src/{runner,evidence-oracle}.ts | scripts/s11/**';
const APPLICABLE_FILE = /^packages\/(?:core\/src\/(?:projection|privacy|decimal|withheld|contracts|index|store)\.ts|server\/src\/index\.ts|evals\/src\/(?:runner|evidence-oracle)\.ts)$/;

/**
 * The reviewed fidelity set, frozen before generation. An applicable mutant listed in scripts/mutation-survivors.json is a
 * reviewed equivalent mutant: the official aggregate REJECTS it when killed ("declared survivor was killed"), so it can
 * never be a required kill. It is frozen instead as a declared survivor, bound to its justification hash, and must be
 * reported as survived. Every other applicable mutant is a required kill.
 */
export function fidelityMutantSet(mutants: readonly Mutant[], declared: readonly Declared[]) {
  const survivors = new Map(declared.map(entry => [entry.id, entry]));
  requireS11(survivors.size === declared.length, 'FIDELITY_SURVIVORS_INVALID');
  const applicable = mutants.filter(m => mutationEdits(m).some((e: { file: string }) => APPLICABLE_FILE.test(e.file) || e.file.startsWith('scripts/s11/'))).map(m => m.id);
  return {
    rule: FIDELITY_SELECTION_RULE,
    required_ids: applicable.filter(id => !survivors.has(id)),
    declared_survivors: applicable.filter(id => survivors.has(id)).map(id => ({ id, justification_sha256: hash(String(survivors.get(id)!.justification)) })),
  };
}
const readDeclared = async (root: string): Promise<Declared[]> => JSON.parse(await readFile(join(root, 'scripts/mutation-survivors.json'), 'utf8'));

export async function mutationProtocol(root: string) {
  return { binding: await candidateBinding(root), list_sha256: mutantListHash(MUTANTS) as string, ...fidelityMutantSet(MUTANTS, await readDeclared(root)) };
}
export type MutationProtocol = Awaited<ReturnType<typeof mutationProtocol>>;

export async function fidelityMutationEvidence(root: string, protocol: MutationProtocol, directory?: string) {
  if (!directory) return { passed: false, status: 'unmeasured', required: protocol.required_ids.length, declared_survivors: protocol.declared_survivors.length, report_hashes: [] };
  const names = (await readdir(directory)).filter(n => /^mutation-shard-\d+-of-14\.json$/.test(n)).sort();
  const reports = [], reportHashes = [];
  for (const name of names) { const bytes = await readFile(join(directory, name)); reports.push(JSON.parse(bytes.toString('utf8'))); reportHashes.push({ name, sha256: hash(bytes) }); }
  const declared = await readDeclared(root);
  // The survivors in force must be exactly the frozen, reviewed ones; a later edit cannot move a required kill.
  const current = fidelityMutantSet(MUTANTS, declared);
  requireS11(mutantListHash(MUTANTS) === protocol.list_sha256 && JSON.stringify(current) === JSON.stringify({ rule: protocol.rule, required_ids: protocol.required_ids, declared_survivors: protocol.declared_survivors }), 'FIDELITY_SET_CHANGED');
  const verdict = aggregateShardReports(reports, { mutants: MUTANTS, declared, expectedShardCount: 14, binding: protocol.binding });
  requireS11(verdict.ok, 'FIDELITY_AGGREGATE_INVALID');
  const results = reports.flatMap(r => r.results) as { id: string; verdict: string }[];
  const exactlyOnce = (id: string, wanted: string) => { const rows = results.filter(r => r.id === id); return rows.length === 1 && rows[0]!.verdict === wanted; };
  const passed = protocol.required_ids.length > 0 && protocol.required_ids.every(id => exactlyOnce(id, 'killed'))
    && protocol.declared_survivors.every(s => exactlyOnce(s.id, 'survived'));
  return { passed, status: passed ? 'passed' : 'unmet', required: protocol.required_ids.length, declared_survivors: protocol.declared_survivors.length, report_hashes: reportHashes };
}
