import type { Ledger } from './case-schema.js';
/** Port of the reviewed extract-ledger.py: derive identities from the design's tables, not the ledger's own totals. */
export function extractDesignRecords(text: string): Ledger['records'] {
  const lines = text.split('\n'), records: Ledger['records'] = [], seen = new Set<string>();
  const add = (id: string, cls: Ledger['records'][number]['class'], line: number, duplicate_of: string | null = null, mapped_shape = false) => {
    if (seen.has(id)) throw new Error(`duplicate design id ${id}`); seen.add(id);
    records.push({ id, family: id.slice(0, 3), class: cls, duplicate_of, mapped_shape, first_slice: false, design_line: line });
  };
  let family: string | undefined; const families = new Map<string, number>();
  for (const [i, line] of lines.entries()) {
    const heading = /^### ([A-Z]{3}) \((\d+) independent cases\)/.exec(line);
    if (heading) { family = heading[1]; families.set(family!, Number(heading[2])); }
    if (line.startsWith('## 3.')) break;
    const row = /^\| ([A-Z]{3}-\d{2})(\*?) \|/.exec(line);
    if (row && family) { if (!row[1]!.startsWith(`${family}-`)) throw new Error('design family differs'); add(row[1]!, 'counted', i + 1, null, !!row[2]); }
  }
  const section = (start: string, end: string) => {
    const at = lines.indexOf(start); if (at < 0) throw new Error(`missing design section ${start}`);
    return lines.slice(at).map((line, i) => ({ line, i: at + i })).slice(0, lines.slice(at).findIndex(line => line.startsWith(end)));
  };
  for (const { line, i } of section('### Complete round-1 disposition ledger', '### Existing mappings')) {
    const row = /^\| ([A-Z]{3}) \| (.+) \|$/.exec(line); if (!row) continue;
    for (const clause of row[2]!.replace(/\([^)]*\)/g, '').split(';').map(s => s.trim()).filter(Boolean)) {
      const [left, right] = clause.split('→').map(s => s.trim()); if (!left || !right) throw new Error('invalid design alias');
      const target = /^[A-Z]{3}-\d{2}$/.test(right) ? right : `${row[1]}-${right}`;
      for (const num of left.split('/')) add(`${row[1]}-${num.trim()}`, 'alias', i + 1, target);
    }
  }
  for (const { line, i } of section('## Appendix A — B3 completeness (not counted)', '## Appendix B')) {
    const row = /^\| ([A-Z]{3})-([\d/]+) \|/.exec(line); if (!row) continue;
    for (const num of row[2]!.split('/')) add(`${row[1]}-${num}`, 'B3', i + 1);
  }
  const appendix = lines.indexOf('## Appendix B — Other uncounted scope');
  for (const line of lines.slice(appendix)) {
    const row = /^- \*\*([A-Z]{3}-\d{2}) \(1 (S2|residual) case\):/.exec(line);
    if (row) add(row[1]!, row[2] as 'S2' | 'residual', appendix + 1);
  }
  const first = new Set<string>();
  for (const { line } of section('## 5. v1 first slice', '## 6.')) {
    const row = /^\| \d+ \| (.+?) \|/.exec(line);
    if (row) for (const id of row[1]!.match(/[A-Z]{3}-\d{2}/g) ?? []) first.add(id);
  }
  for (const r of records) r.first_slice = first.has(r.id);
  for (const [fam, count] of families) if (records.filter(r => r.family === fam && r.class === 'counted').length !== count) throw new Error(`design family count ${fam}`);
  for (const r of records.filter(r => r.class === 'alias')) if (!records.some(c => c.id === r.duplicate_of && c.class === 'counted')) throw new Error('design alias target');
  if (records.length !== 287 || records.filter(r => r.class === 'counted').length !== 216 || records.filter(r => r.class === 'alias').length !== 42 || first.size !== 61 || [...first].some(id => !records.some(r => r.id === id && r.class === 'counted'))) throw new Error('design arithmetic');
  return records.sort((a, b) => a.id.localeCompare(b.id));
}
