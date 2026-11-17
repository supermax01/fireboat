// bench:gold-compare -- --ts <gold.ts.jsonl> --py <gold.py.jsonl> [--label <name>] [--out <file.json>]
// Compares the two gold implementations question by question on answer, answer_list, item refs, items (ref, value,
// recorded value, unit, time) and depends_on, exactly. "Agree on all" means answer, answer_list, item refs and depends_on. answer_list differences are also checked with the agent grader's field matching
// (agent/grade.ts listEqual, both directions), so a difference in how a composite entry is written is told apart from a
// difference in content. Prints the counts and every difference; never edits either file.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { listEqual } from '../agent/grade.js';
import { parseNumbersAsStrings } from '../lib/json.js';

interface Item { ref: string; value: string | null; value_as_recorded: string | null; unit: string | null; time: string | null }
interface Gold { question_id: string; answer: string | null; answer_list: string[] | null; items: Item[]; depends_on: string[] }

export const FIELDS = ['answer', 'answer_list', 'item_refs', 'items', 'depends_on'] as const;
/** The fields "agree on all" requires; full item fields are counted beside them. */
const CORE: readonly Field[] = ['answer', 'answer_list', 'item_refs', 'depends_on'];
type Field = typeof FIELDS[number];

const read = (path: string): Map<string, Gold> =>
  new Map(readFileSync(path, 'utf8').split('\n').filter(Boolean).map(l => parseNumbersAsStrings(l) as unknown as Gold).map(g => [g.question_id, g]));
const sorted = (xs: readonly string[] | null | undefined) => [...new Set(xs ?? [])].sort();
const itemKey = (i: Item) => JSON.stringify([i.ref, i.value ?? null, i.value_as_recorded ?? null, i.unit ?? null, i.time ?? null]);

export function compareGold(ts: Map<string, Gold>, py: Map<string, Gold>) {
  const agree: Record<Field, number> = { answer: 0, answer_list: 0, item_refs: 0, items: 0, depends_on: 0 };
  const differences: { question_id: string; template: string; fields: Field[]; answer_list_equal_by_fields: boolean | null; detail: Record<string, unknown> }[] = [];
  const missing = { only_ts: [...ts.keys()].filter(k => !py.has(k)), only_py: [...py.keys()].filter(k => !ts.has(k)) };
  let full = 0;
  for (const [id, t] of ts) {
    const p = py.get(id);
    if (!p) continue;
    const same: Record<Field, boolean> = {
      answer: (t.answer ?? null) === (p.answer ?? null),
      answer_list: JSON.stringify(sorted(t.answer_list)) === JSON.stringify(sorted(p.answer_list)),
      item_refs: JSON.stringify(t.items.map(i => i.ref).sort()) === JSON.stringify(p.items.map(i => i.ref).sort()),
      items: JSON.stringify(t.items.map(itemKey).sort()) === JSON.stringify(p.items.map(itemKey).sort()),
      depends_on: JSON.stringify(sorted(t.depends_on)) === JSON.stringify(sorted(p.depends_on)),
    };
    for (const f of FIELDS) if (same[f]) agree[f]++;
    const fields = FIELDS.filter(f => !same[f]);
    if (CORE.every(f => same[f])) full++;
    if (fields.length === 0) continue;
    const byFields = same.answer_list ? null : listEqual(t.answer_list ?? [], p.answer_list ?? []).equal && listEqual(p.answer_list ?? [], t.answer_list ?? []).equal;
    const tDep = new Set(t.depends_on), pDep = new Set(p.depends_on);
    differences.push({
      question_id: id, template: id.split('.')[1] ?? '', fields, answer_list_equal_by_fields: byFields,
      detail: {
        ...(same.answer ? {} : { answer: { ts: t.answer, py: p.answer } }),
        ...(same.answer_list ? {} : { answer_list: { ts: sorted(t.answer_list).slice(0, 5), py: sorted(p.answer_list).slice(0, 5) } }),
        ...(same.items ? {} : { items: { ts_only: t.items.map(itemKey).filter(k => !p.items.map(itemKey).includes(k)).slice(0, 3), py_only: p.items.map(itemKey).filter(k => !t.items.map(itemKey).includes(k)).slice(0, 3) } }),
        ...(same.depends_on ? {} : { depends_on: { ts_only: [...tDep].filter(r => !pDep.has(r)).sort().slice(0, 5), py_only: [...pDep].filter(r => !tDep.has(r)).sort().slice(0, 5), ts_n: tDep.size, py_n: pDep.size } }),
      },
    });
  }
  return { compared: [...ts.keys()].filter(k => py.has(k)).length, agree_on_all: full, agree, missing, differences };
}

function main() {
  const { values } = parseArgs({ options: { ts: { type: 'string' }, py: { type: 'string' }, label: { type: 'string' }, out: { type: 'string' } }, strict: true });
  if (!values.ts || !values.py) throw new Error('--ts and --py are required');
  const r = compareGold(read(values.ts), read(values.py));
  const label = values.label ?? values.ts;
  process.stdout.write(`${label}: ${r.agree_on_all}/${r.compared} agree on answer, answer_list, item refs and depends_on; answer ${r.agree.answer}, answer_list ${r.agree.answer_list}, item refs ${r.agree.item_refs}, items (all fields) ${r.agree.items}, depends_on ${r.agree.depends_on}`
    + `${r.missing.only_ts.length || r.missing.only_py.length ? `; only in TS ${r.missing.only_ts.length}, only in Python ${r.missing.only_py.length}` : ''}\n`);
  for (const d of r.differences) process.stdout.write(`  ${d.question_id} [${d.fields.join(',')}]${d.answer_list_equal_by_fields ? ' (answer_list equal by fields)' : ''} ${JSON.stringify(d.detail)}\n`);
  if (values.out) writeFileSync(values.out, JSON.stringify({ label, ts: values.ts, py: values.py, ...r }, null, 2) + '\n');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
