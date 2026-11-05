/** Regenerate reviewed scenario contracts, record fields and the fixture/matrix/harness/ledger/mutant pins; installs nothing.
 *   node --import tsx tests/isolation/generate-manifest.mjs [--hashes-only]
 * B2-0: every record stays counted:false (B2-1 flips cases one by one with measured budgets, authored fault
 * intents and production anchors). `hashes.mutants` is refreshed LAST, after any registry change, by `--hashes-only`. */
import { readFileSync, writeFileSync } from 'node:fs';
import { SCENARIO_CONTRACTS } from './registry.ts';
import { overblockingFeature } from './stubs.ts';
import { parseKillMatrix, parseLedger, registryMutants } from './case-schema.ts';
import { expectedPins } from './report.ts';
const path = new URL('./cases-v1.json', import.meta.url);
const manifest = JSON.parse(readFileSync(path, 'utf8'));
const hashesOnly = process.argv.includes('--hashes-only');
if (!hashesOnly) {
  const source = readFileSync(new URL('./scenarios.ts', import.meta.url), 'utf8');
  const ledger = parseLedger();
  const mappings = { 'B2-SEL-19': [], 'B2-PAY-01': [], 'B2-BAS-01': [], 'B2-XRF-01': [], 'B2-REF-11': [], 'B2-SHR-05': [], 'B2-SHR-06': [], 'B2-SHR-17': [], 'B2-DIR-01': [] };
  for (const c of manifest.cases) {
    const r = SCENARIO_CONTRACTS[c.id]; if (!r) throw new Error('no scenario contract');
    const label = `case '${c.id.slice(3)}'`;
    if (!source.includes(label)) throw new Error('no executable branch');
    const line = source.slice(0, source.indexOf(label)).split('\n').length;
    // Legacy harness anchor: allowed only while counted:false. Counted records get a production {file, find} anchor in B2-1.
    c.signature = { primary_decision: r.decision, adversarial_goal: r.goal, protected_element_class: c.disclosure_class, state_transition: `${r.oracle}:control-then-attack-and-retained-followups`, source_anchor: `tests/isolation/scenarios.ts:${line}`, discriminating_fault_intent: r.fault };
    c.attack_description = r.goal; c.independence = `${r.decision}; ${r.goal}`;
    c.counted = false; delete c.counts_toward_b2; c.classification = 'diagnostic'; c.boundary = 'decidable'; c.duplicate_of = null;
    c.oracle_type = r.oracle; c.expected_outcome_class = r.outcome; c.expected_assertions = [r.predicate_id, 'b2.all.forbidden-markers-absent', 'b2.all.egress-bound'];
    c.mutant_intent = r.fault; if (c.id in mappings) c.critical_mutants = mappings[c.id];
    c.controls[0].assertions = [`${r.predicate_id}.positive`, `b2.control.${overblockingFeature(c.id)}`];
    c.controls[0].near_twin_delta = `Remove only the attack feature: ${r.goal}`;
    c.controls[0].overblocking_challenges = [overblockingFeature(c.id)];
    c.budgets = { max_tool_calls: 100, max_total_upstream_calls: c.budgets.max_total_upstream_calls ?? 100, max_clinical_calls: 60, max_result_bytes: c.budgets.max_result_bytes ?? 60000, deadline_ms: c.budgets.deadline_ms ?? 15000, max_task_bytes: null, budget_source: null };
    c.known_failure = null;
    if (!ledger.records.some(l => `B2-${l.id}` === c.id && l.class === 'counted')) throw new Error(`${c.id} is not a counted ledger id`);
  }
  manifest.suite_id = 'b2-v1-first-slice';
  manifest.frozen_ids = manifest.cases.map(c => c.id);
  manifest.aliases ??= []; manifest.catalogue ??= [];
  manifest.scope_revision = 'v1.2 diagnostic union; B2-0 counting machinery; 68 frozen catalogue IDs, 0 counted';
}
manifest.hashes = expectedPins(await registryMutants(), parseKillMatrix());
writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
console.log(`${hashesOnly ? 'hashes refreshed' : 'manifest regenerated'}: ${manifest.cases.length} cases, ${manifest.cases.filter(c => c.counted).length} counted`);
