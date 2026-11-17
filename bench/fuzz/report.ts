// Report section for the robustness fuzz corpus. Used by bench:fuzz (report.md) and bench:scripted-report --fuzz.
import { CATEGORIES } from './corpus.js';
import { FUZZ_RULES, type ArmSummary } from './score.js';

const ARM_ORDER = ['FB0', 'FBd', 'FB', 'FBt', 'W', 'M', 'H'];
const byArm = (a: ArmSummary, b: ArmSummary) => a.dataset.localeCompare(b.dataset) || (ARM_ORDER.indexOf(a.arm) - ARM_ORDER.indexOf(b.arm)) || a.arm.localeCompare(b.arm);
const frac = (k: number, n: number) => (n ? `${k}/${n}` : '-');

/** Markdown lines; `level` is the heading depth of the section title. */
export function fuzzSection(arms: readonly ArmSummary[], o: { campaign: string; corpus: { version: string; sha256: string; label: string }; level?: number }): string[] {
  const h = '#'.repeat(o.level ?? 2);
  const rows = [...arms].sort(byArm);
  const md = [
    `${h} Robustness fuzz corpus: ${o.campaign}`, '',
    `Corpus version ${o.corpus.version}, sha256 ${o.corpus.sha256.slice(0, 16)}..., 100 cases. ${o.corpus.label}. Development data; descriptive.`, '',
    '| dataset | arm | expressible | survived | crashes | timeouts | structured error where expected | success-shaped failures (HAPI accepted the forwarded query) | acceptable (all expressible) | malformed input refused before upstream | canary hits | stack / path / secret in error text | numbers preserved / refused / altered / dropped | other-patient data | write attempts |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const r of rows) {
    md.push(`| ${r.dataset} | ${r.arm} | ${r.expressible}/${r.cases} | ${r.survived}/${r.cases} | ${r.crashes} | ${r.timeouts} | ${frac(r.expect_error.structured, r.expect_error.n)} | ${r.expect_error.success_shaped_failures} (${r.expect_error.backend_accepted}) | ${frac(r.acceptable.k, r.acceptable.n)} | ${frac(r.malformed_mcp.refused_before_upstream, r.malformed_mcp.n)} | ${r.canary_hit_cases} | ${r.leak_cases.stack_trace} / ${r.leak_cases.file_path} / ${r.leak_cases.secret} | ${r.numbers.preserved} / ${r.numbers.refused} / ${r.numbers.silently_altered} / ${r.numbers.dropped}${r.numbers.not_expressible ? ` (${r.numbers.not_expressible} n/e)` : ''} | ${r.other_patient_cases} | ${r.write_attempt_cases} |`);
  }
  md.push('', `${h}# Acceptable outcomes by category (k/expressible)`, '', `| dataset | arm | ${CATEGORIES.join(' | ')} |`, `| --- | --- | ${CATEGORIES.map(() => '---').join(' | ')} |`);
  for (const r of rows) md.push(`| ${r.dataset} | ${r.arm} | ${CATEGORIES.map(c => { const x = r.by_category[c]!; return `${x.acceptable}/${x.expressible}${x.expressible < x.n ? ` (of ${x.n})` : ''}`; }).join(' | ')} |`);
  const outcomes = [...new Set(rows.flatMap(r => Object.keys(r.outcomes)))].sort();
  md.push('', `${h}# Outcome classes`, '', `| dataset | arm | ${outcomes.join(' | ')} |`, `| --- | --- | ${outcomes.map(() => '---').join(' | ')} |`);
  for (const r of rows) md.push(`| ${r.dataset} | ${r.arm} | ${outcomes.map(k => r.outcomes[k] ?? 0).join(' | ')} |`);
  md.push('', `${h}# Fuzz scoring rules`, '', ...FUZZ_RULES.map(x => `- ${x}`), '');
  return md;
}

export function fuzzReport(arms: readonly ArmSummary[], o: { campaign: string; corpus: { version: string; sha256: string; label: string }; raw: string }): string[] {
  return [
    `# Fuzz report: ${o.campaign}`, '',
    ...fuzzSection(arms, { ...o, level: 2 }),
    '## Raw data', '', `- Records, proxy and canary logs, scores, summary and the blinded rating sheet: ${o.raw}`, '',
  ];
}
