// bench:scripted-report -- --campaign <c> [--fuzz <fuzz campaign>] [--latency <latency campaign>] [--out <dir>]
// Writes RESULTS/dev/scripted-report.json and scripted-report.md (or <--out dir>/...) from scores/<c>/ and the scripted manifests.
// Tables per dataset, category and arm. No single combined score. Raw logs stay where the runner wrote them.
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { COMMON_OPTIONS } from '../lib/cli.js';
import { RESULTS, results } from '../lib/paths.js';
import type { Row, StratumRow } from './summary.js';
import { BANDS } from '../gold/longlist.js';
import { fuzzSection } from '../fuzz/report.js';
import type { ArmSummary as FuzzArmSummary } from '../fuzz/score.js';
import { latencySection } from '../latency/report.js';
import type { ArmLatency } from '../latency/run.js';
import type { ProbeSet } from '../latency/probes.js';

const readJson = async <T>(p: string): Promise<T> => JSON.parse(await readFile(p, 'utf8')) as T;

export const RULES = [
  'Item checks: value and unit only when the gold value is recorded in the resource; derived values are not item checks.',
  'A value passes if some Quantity or value[x] in the returned resource is decimal-equal to the gold (text: exactly equal, including a valueCodeableConcept text or coding display); its unit must equal the record unit (else code, else currency), or be absent when the gold has none.',
  'Time passes if some date-time in the returned resource equals the gold time as an instant at the gold precision.',
  'Identity: the gold resource id was returned and the returned copy names the question patient (or no patient).',
  'Answer text: where the answer is text in the gold record itself (N2, the conditions in a note\'s text; K2, the care-team members and roles), some returned copy of that record must yield exactly the gold answer list when the gold rule\'s own extraction is applied to it (gold/rules.ts ANSWER_FROM_COPY); a copy that withholds the text fails, whatever the arm.',
  'Correct = every gold item passes the value, unit, time and identity checks and, for N2 and K2, the answer-text check; no other-patient record was returned, no read was suppressed (below), and for a list question the returned set covers depends_on (G) and no list operation returned a record outside G or the gold items. The last check is skipped for K2, whose plan reads every CareTeam by design (run/score-lib.ts PLAN_WIDER_THAN_GOLD). A gold without items (explicit none) is also correct only if every operation succeeded.',
  'Completeness verdict uses G = gold depends_on and R = every returned resource id; counted signals are those on the final response of each list operation; a counted signal takes precedence over a completeness claim.',
  'Completeness claim, one rule for every arm: fireboat coverage.state complete_for_query, or a reported total that the server presents as exact and that equals the items returned (a FHIR Bundle.total carries no precision marker and counts; a fireboat total marked estimate or unknown does not). has_more:false or hasMore:false alone is not a claim; it is the absence of a counted signal, like a missing next link.',
  'A list operation that errored or was refused gets no verdict ("no result", NR), not a completeness class, except that a NOT_FOUND answer while the proxy log shows HAPI served the search is a silent truncation.',
  'A read answered NOT_FOUND while the proxy log shows HAPI returned that record with 200 is a silent truncation (a withheld record must not look like a missing one), counted in the "ST reads" column; a list question containing such a read cannot be complete.',
  'Headline summary score: 1, 0.5, 0, 0 over every list question, with NR scored 0. The score over list questions with a verdict only is shown second.',
  'Bytes: content[].text and structuredContent are reported separately, never combined; every arm sends both channels and a host reads one.',
  'fireboat coverage reasons count only when they say items were left out (servers/parsers.ts FIREBOAT_OMISSION_REASONS); other reasons are blanket labels.',
  'Recall and precision: FHIR-AgentBench empty-set convention as implemented in agent/grade.ts (both empty = 1, one empty = 0).',
  'Pass 1 is scored; pass 2 is only compared with pass 1 (consistency.json). Of several records of one run_id, the last is scored; earlier ones may only be server start failures that resume retried.',
  'Confinement outcome: other-patient resource ids in the tool output (subject visible in the item, or listed in the probe gold). Write outcome: the recording proxy answers every write with 403, so the backend never changes; the reported capability is whether the server forwarded a write.',
];

/** Shown when a campaign has no Ws rows. */
export const WS_DEVIATION_NOT_RUN = 'Arm Ws (WSO2 with a patient-scoped token) did not run in this campaign, so WSO2\'s patient scoping as designed is not shown. The W confinement rows run with authorization disabled by benchmark configuration and must not be circulated without a Ws row.';
/** Shown instead when Ws ran: what Ws and Wm are. */
export const WS_DEVIATION_RUN = 'Arm Ws runs WSO2 0.11.0 (W\'s install, authorization on, FHIR_SERVER_ACCESS_TOKEN) against Medplum 5.2.6 with a client whose AccessPolicy confines it to the run patient\'s compartment, read interactions only: the backend enforces the scope, not a harness proxy. Wm is the same WSO2 against the same Medplum with a system-level client (no AccessPolicy), which separates the backend from the scope. Medplum holds Synthea development data only, loaded with the file ids (bench:medplum:load); MIMIC is not loaded into Medplum. The harness obtains the token by client credentials (WSO2 has no client-credentials flow for its backend). Medplum next links point at Medplum itself, not at the recording proxy; WSO2 follows none in the default cell.';
/** What each dataset is, as the report states it beside its seed. */
export const DATASET_LABELS: Record<string, string> = {
  mimic: 'MIMIC-IV demo; fireboat was developed against this data',
  'synthea-dev': 'development data',
  'synthea-holdout': 'fresh held-out Synthea sample (99 patients drawn by drand round 6644725, not used in development)',
};

/** The seed a dataset's questions were drawn with, from its questions manifest. */
export function seedText(seed: { kind?: string; hex?: string; round?: string } | null | undefined): string {
  if (!seed?.kind) return 'not recorded';
  if (seed.kind === 'dev') return 'development seed (64 zeros)';
  if (seed.kind === 'drand') return `drand round ${seed.round} randomness ${seed.hex}`;
  return `${seed.kind} seed ${seed.hex}`;
}

/** One line per dataset in the campaign: its label and the seed its questions were drawn with. */
export const datasetLines = (rows: { dataset: string; seed: string }[]): string[] =>
  rows.map(r => `- ${r.dataset}: ${DATASET_LABELS[r.dataset] ?? r.dataset}. Questions drawn with the ${r.seed}.`);

/** Known limits of the harness, printed with every report. */
export const DEVIATIONS = [
  'Synthea conditional references (Organization, Location and Practitioner by identifier) are not resolved to Type/id, because the shared files organizations.json and practitioners.json are not downloaded. Each becomes a logical reference with type, identifier and display, carrying the same information as the conditional reference. K2 member names come from reference displays.',
  'Scripted arms may run concurrently on separate slots against one HAPI (run/baseline.sh runs four at once); latency in this report is descriptive only and affected by that concurrency. The warm-repetition latency protocol runs separately (bench:latency) and appears in this report only when --latency is given.',
  'Approximate token counts are not computed: no tokenizer is part of the harness.',
  'The second cell is "limits-only": only configuration levers are applied (fireboat limits.defaultBytes 131072 and maxHandles 1000; W _total=accurate). No field-level lever (fireboat output.fields; W response_filter_fhirpaths, _elements, _summary=count, _sort) is implemented for any arm, and M and H run in the default cell only. Its bytes are not a cross-arm comparison and appear only beside the same arm\'s default cell.',
  WS_DEVIATION_NOT_RUN,
  'Next-link replay variant not run: HAPI answers _getpages at a type-level path with 400 (manifests/load-*.json).',
  'No breadth probes. The fuzz corpus runs separately (bench:fuzz) and appears in this report only when --fuzz is given. Write probes run against the blocking proxy, not a disposable HAPI.',
  'Scoring uses the TypeScript gold; the independent Python gold (bench/gold/py) is a cross-check, compared with bench:gold-compare.',
  'Few recorded numbers in either dataset have text a float round trip would change, so the main questions exercise exact decimal text lightly; the decimal stratum and the fuzz corpus test it directly.',
];

export const deviationsFor = (arms: ReadonlySet<string>) => DEVIATIONS.map(d => (d === WS_DEVIATION_NOT_RUN && arms.has('Ws') ? WS_DEVIATION_RUN : d));

/** Observed server behaviour worth recording separately from the scores. */
export const FINDINGS = [
  'FB0 on legal FHIR input: a record whose Patient-capable reference element (DocumentReference.author, MedicationRequest.requester, CareTeam.participant.member) holds an identifier-only logical reference (no reference, no type) is dropped whole, with no omission signal: the record is fetched from HAPI and the response reports coverage.state complete_for_query without it, and a read of such a record answers NOT_FOUND. Logical references without type are legal FHIR R4. The converter now sets the type, so current conversions do not trigger this.',
];

/** One line per arm for the report's arm legend (pins are in run_manifests). */
export const ARM_LABELS: Record<string, string> = {
  FB0: 'fireboat as first published (ad7f9f2)',
  FB: 'fireboat built from this repository, with the deployment\'s shared-record lists (privacy.sharedIdentifierSystems, privacy.sharedProfiles)',
  FBd: 'fireboat, the same build as FB, with the default privacy configuration: patient identifier systems only, no shared-record lists (what a new user gets)',
  FBt: 'fireboat, tuned: FB plus a listing written for one dataset (a MIMIC medication-mix identifier system); reported separately',
  W: 'WSO2 fhir-mcp-server 0.11.0',
  Ws: 'WSO2 against Medplum with a patient-scoped AccessPolicy (backend-enforced)',
  Wm: 'WSO2 against Medplum with a system-level client',
  M: 'the-momentum/fhir-mcp-server 0.1.0',
  H: 'fhirhydrant 0.17.3',
  FBdh: 'fireboat as FBd (default configuration) against AWS HealthLake, through a loopback SigV4 signing proxy that rewrites Bundle links to its own base',
  FBh: 'fireboat as FB (operator configuration) against AWS HealthLake, through the same signing proxy',
  AH: 'AWS HealthLake MCP server 0.0.21 (awslabs, --readonly) against the same data store; connects to AWS itself (no egress sandbox, not in the proxy log)',
};
export const armLabel = (arm: string) => ARM_LABELS[arm] ?? arm;

/** Display order: the fireboat arms from default to tuned, then the other servers; unknown arms last, by name. */
export const ARM_ORDER = ['FB0', 'FBd', 'FB', 'FBt', 'FBdh', 'FBh', 'W', 'Ws', 'Wm', 'M', 'H', 'AH', 'NT', 'Wn', 'L'];
const armRank = (a: string) => { const i = ARM_ORDER.indexOf(a); return i < 0 ? ARM_ORDER.length : i; };
export const byArm = (a: string, b: string) => armRank(a) - armRank(b) || a.localeCompare(b);
const byArmThenCell = (a: { arm: string; cell: string }, b: { arm: string; cell: string }) => byArm(a.arm, b.arm) || a.cell.localeCompare(b.cell);

export const FIREBOAT_LEGEND = 'fireboat arms: FBd = default configuration; FB = operator configuration with general lists; FBt = FB plus a listing written for one dataset (reported separately).';

/** Labels on confinement rows: how each server's patient scope was configured. */
export const CONFINEMENT_ROW_LABEL: Record<string, string> = {
  W: ' (authorization disabled by benchmark configuration)',
  Ws: ' (Medplum, patient-scoped AccessPolicy, backend-enforced)',
  Wm: ' (Medplum, system-level client)',
  AH: ' (HealthLake; no patient scope by design: every tool takes any patient id)',
};

export const cellLabel = (cell: string) => (cell === 'best_effort' ? 'limits-only' : cell);

const pct = (k: number, n: number) => (n ? `${k}/${n} (${Math.round((k / n) * 100)}%)` : '-');
const num = (x: number | null | undefined, d = 2) => (x === null || x === undefined ? '-' : String(Math.round(x * 10 ** d) / 10 ** d));
const kb = (x: number | null | undefined) => (x === null || x === undefined ? '-' : `${Math.round(x / 102.4) / 10}`);

interface Summary {
  campaign: string; generated_at: string; bench_commit: string; bench_dirty: boolean; bench_tree_sha256?: string;
  inputs?: { scored: unknown; recorded: unknown; mismatches: string[] };
  by_category: Row[]; by_template: Row[]; by_arm?: Row[]; // by_arm: absent in older summaries
  by_stratum?: StratumRow[]; strata?: { dir: string; base_rate: Record<string, { numbers: number; float_changing: number } | null> }; // only when strata were scored
  probes_detail: { dataset: string; arm: string; cell: string; probe_set: string; template_id: string; kind: string; n: number; outcomes: Record<string, number>; other_patient_refs: number; upstream_requests: number; blocked_writes: number }[];
  probes_collapsed: { dataset: string; arm: string; cell: string; probe_set: string; n: number; outcomes: Record<string, number>; other_patient_refs: number }[];
  sessions: { dataset: string; arm: string; cell: string; runs: number; start_failed: number; nonzero_exit: number; tools_list_bytes: number; instructions_bytes: number;
    cold_start_ms: { median: number | null; p95: number | null; max: number | null }; wall_ms: { median: number | null } }[];
}

const CATEGORY_NAMES: Record<string, string> = { R: 'R (retrieval)', V: 'V (values)', C: 'C (completeness)', T: 'T (time)' };

const split = (x: { median: number | null; p95: number | null } | undefined) => (x ? `${num(x.median, 0)}, ${num(x.p95, 0)}` : '-');

export const LATENCY_NOTE = 'Latency: a fresh server is started per question, so the first call\'s once-per-session cost (fireboat: the CapabilityStatement fetch) is paid per question here but once per session in real use. "First call" is each run\'s first call; "later calls" is each run\'s median over the calls after the first (runs with one call have none); total is the sum of a run\'s call latencies.';

/** Default-cell latency split per arm over every question of the dataset (empty when the summary predates the split). */
export function latencyTable(rows: Row[]): string[] {
  const out = ['| arm | runs | total/run median, p95 (ms) | first call median, p95 (ms) | later calls (per-run median) median, p95 (ms) | runs with later calls |', '| --- | --- | --- | --- | --- | --- |'];
  for (const r of [...rows].sort(byArmThenCell)) out.push(`| ${r.arm} | ${r.n} | ${split(r.latency_ms_per_run)} | ${split(r.first_call_ms)} | ${split(r.later_calls_median_ms)} | ${r.later_calls_median_ms?.n ?? '-'} |`);
  return out;
}

const verdictCell = (r: Row) => (r.list_n ? `${r.verdicts.complete}/${r.verdicts.signalled_partial}/${r.verdicts.silent_truncation}/${r.verdicts.false_completeness}/${r.verdicts.no_result}` : '-');

/** Default-cell rows only: limits-only rows are not part of any cross-arm comparison. */
function categoryTable(rows: Row[]): string[] {
  const out = ['| arm | n | correct | verdicts C/SP/ST/FC/NR | summary score (NR = 0) | summary score (verdicts only) | ST reads | first-page cov. | precision | runs with extra records | value / unit / time ok (of gold items) | lexeme exact | UCUM code kept | other-patient refs | calls | content text KiB/run median, total | structuredContent KiB/run median, total | latency/run median, p95 (ms) | first call median, p95 (ms) | later calls median, p95 (ms) | failures |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'];
  for (const r of [...rows].sort(byArmThenCell)) {
    out.push(`| ${r.arm} | ${r.n} | ${pct(r.correct, r.n)} | ${verdictCell(r)} | ${num(r.summary_score_mean_no_result_as_0)} | ${num(r.summary_score_mean)} | ${r.suppressed_reads} | ${num(r.first_page_coverage_mean)} | ${num(r.precision_mean)} | ${r.runs_with_extra_records} | ${r.items.value_ok}/${r.items.unit_ok}/${r.items.time_ok} of ${r.items.gold} | ${r.lexeme.exact}/${r.lexeme.eligible} | ${r.unit_code.kept}/${r.unit_code.eligible} | ${r.other_patient_refs} | ${r.calls_total} | ${kb(r.bytes_content_text.median)}, ${kb(r.bytes_content_text.total)} | ${kb(r.bytes_structured.median)}, ${kb(r.bytes_structured.total)} | ${num(r.latency_ms_per_run.median, 0)}, ${num(r.latency_ms_per_run.p95, 0)} | ${split(r.first_call_ms)} | ${split(r.later_calls_median_ms)} | ${Object.entries(r.failures).map(([k, n]) => `${k} ${n}`).join(', ') || '-'} |`);
  }
  return out;
}

const BAND_ROLE: Record<string, string> = { B1: 'control', B2: 'control', B3: 'main', B4: 'partial expected' };
const SCORED_ON: Record<string, string> = { answer: 'answer (verdict beside it)', verdict: 'verdict', standard: 'items and depends_on' };

/**
 * Strata sections: every long-list band and the decimal stratum on their own rows, default
 * cell only, never pooled with the main question set or with each other. Empty when the summary has no stratum rows.
 */
export function strataSection(rows: StratumRow[], baseRate: { numbers: number; float_changing: number } | null | undefined): string[] {
  const md: string[] = [];
  const def = rows.filter(r => r.cell === 'default');
  const ll = def.filter(r => r.stratum !== 'decimal');
  if (ll.length) {
    md.push('### Long-list stratum (separate question set; bands never pooled)', '',
      'LS1: distinct codes across the set (list; correct needs every record). LS2: largest value (scored on the answer; the depends_on verdict is reported beside it, not folded in). B4 exceeds the 20-call drain cap at every page size in use and is scored on the verdict: SP passes, C passes only with the whole set returned, ST, FC and NR fail. W and M cannot continue in the default cell, so they fail B3 and B4 by construction; the next-link replay column is not run in this phase.', '',
      '| band | form | scored on | arm | n | correct | verdicts C/SP/ST/FC/NR | first-page cov. | recall | calls | failures |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    const order = (r: StratumRow) => `${BANDS.findIndex(b => b.id === r.stratum)}${r.group.slice(0, 3)}`;
    for (const r of [...ll].sort((a, b) => order(a).localeCompare(order(b)) || byArm(a.arm, b.arm))) {
      const band = BANDS.find(b => b.id === r.stratum)!;
      md.push(`| ${band.id} ${band.min}-${band.max} (${BAND_ROLE[band.id]}) | ${r.group.slice(0, 3)} | ${SCORED_ON[r.scored_on]} | ${r.arm} | ${r.n} | ${pct(r.correct, r.n)} | ${verdictCell(r)} | ${num(r.first_page_coverage_mean)} | ${num(r.recall_mean)} | ${r.calls_total} | ${Object.entries(r.failures).map(([k, n]) => `${k} ${n}`).join(', ') || '-'} |`);
    }
    md.push('');
  }
  const dec = def.filter(r => r.stratum === 'decimal');
  if (dec.length) {
    md.push('### Decimal stratum (separate question set)', '',
      baseRate
        ? `Base rate: ${baseRate.float_changing} of ${baseRate.numbers} JSON numbers (${Math.round((baseRate.float_changing / baseRate.numbers) * 10000) / 100}%) in this dataset's question patients have text a binary-float round trip changes.`
        : 'Base rate: not recorded (no strata measurement beside the stratum files).',
      'Eligibility follows JavaScript float printing; a server that prints through a Python float keeps texts such as 1.0 and passes those items, which is fair because the check is exact text match. CL1 is a financial amount written for this stratum. Decimal-equal correctness and the exact-text count are in the same row.', '',
      '| template | arm | n | correct (decimal-equal value, unit, time, identity) | value / unit ok (of gold items) | lexeme exact |', '| --- | --- | --- | --- | --- | --- |');
    for (const r of [...dec].sort((a, b) => a.group.localeCompare(b.group) || byArm(a.arm, b.arm))) {
      md.push(`| ${r.group} | ${r.arm} | ${r.n} | ${pct(r.correct, r.n)} | ${r.items.value_ok}/${r.items.unit_ok} of ${r.items.gold} | ${r.lexeme.exact}/${r.lexeme.eligible} |`);
    }
    md.push('');
  }
  return md;
}

/** The limits-only cell beside the same arm's default cell (never across arms). */
function limitsTable(rows: Row[]): string[] {
  const out = ['| arm / cell | category | n | correct | verdicts C/SP/ST/FC/NR | summary score (NR = 0) | content text KiB total | structuredContent KiB total | failures |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |'];
  for (const r of rows) out.push(`| ${r.arm} ${cellLabel(r.cell)} | ${r.group} | ${r.n} | ${pct(r.correct, r.n)} | ${verdictCell(r)} | ${num(r.summary_score_mean_no_result_as_0)} | ${kb(r.bytes_content_text.total)} | ${kb(r.bytes_structured.total)} | ${Object.entries(r.failures).map(([k, n]) => `${k} ${n}`).join(', ') || '-'} |`);
  return out;
}

async function main() {
  const { values } = parseArgs({ options: { ...COMMON_OPTIONS, superseded: { type: 'string' }, out: { type: 'string' }, fuzz: { type: 'string' }, latency: { type: 'string' } }, strict: true });
  // --out <dir>: write the report there instead of RESULTS/dev (so a side campaign does not replace the main report).
  const campaign = values.campaign ?? '';
  // --superseded <campaign>: an earlier campaign (re-scored with the current rules) whose FB0 Synthea rows were harness artifacts.
  const superseded = values.superseded ? await readJson<Summary>(join(results.scores(values.superseded), 'summary.json')) : null;
  const dir = results.scores(campaign);
  const summary = await readJson<Summary>(join(dir, 'summary.json'));
  const cons = await readJson<{ compared: number; unpaired: number; differences: unknown[]; byte_differences: { count: number } }>(join(dir, 'consistency.json'));
  const manifests = readdirSync(results.manifests).filter(f => f.startsWith(`scripted-${campaign}-`)).sort();
  const tools: Record<string, { name: string; mutating: string | null }[]> = {};
  const runManifests = [];
  for (const f of manifests) {
    const m = await readJson<{ arms: string[]; dataset: string; cell: string; pass: number; tools_listed?: Record<string, { name: string; mutating: string | null }[]>; served_counts: unknown; arm_pins: unknown; page_sizes: unknown; finished_at: string }>(join(results.manifests, f));
    for (const [arm, t] of Object.entries(m.tools_listed ?? {})) if (!tools[arm] || tools[arm].length < t.length) tools[arm] = t;
    runManifests.push({ file: f, dataset: m.dataset, arms: m.arms, cell: m.cell, pass: m.pass, finished_at: m.finished_at, arm_pins: m.arm_pins, page_sizes: m.page_sizes });
  }
  const datasets = [...new Set([...summary.by_category, ...summary.probes_collapsed, ...(summary.by_stratum ?? [])].map(r => r.dataset))].sort();
  const allArms = new Set([...summary.by_category, ...summary.probes_collapsed, ...(summary.by_stratum ?? [])].map(r => r.arm));
  const deviations = deviationsFor(allArms);
  const datasetSeeds = [];
  for (const d of datasets) {
    const mp = join(results.manifests, `questions-${d}.json`);
    const m = existsSync(mp) ? await readJson<{ seed?: { kind?: string; hex?: string; round?: string } }>(mp) : null;
    datasetSeeds.push({ dataset: d, label: DATASET_LABELS[d] ?? d, seed: seedText(m?.seed) });
  }
  const md: string[] = [
    `# Scripted runs: ${campaign}`, '',
    `Generated ${new Date().toISOString()} from scores of ${summary.generated_at}; bench commit ${summary.bench_commit}${summary.bench_dirty ? ' (dirty worktree)' : ''}, bench tree sha256 ${summary.bench_tree_sha256 ?? 'not recorded'}.`,
    '', 'Datasets:', '', ...datasetLines(datasetSeeds), '',
    ...(summary.inputs?.mismatches.length ? ['**Scored against inputs that differ from what the campaign ran against:** ' + summary.inputs.mismatches.join('; '), ''] : []),
    'Verdicts: C complete, SP signalled partial, ST silent truncation, FC false completeness, NR no result (the list operation errored or was refused). Summary score: 1, 0.5, 0, 0 per list question; the headline column scores NR as 0. ST reads: reads answered NOT_FOUND although HAPI returned the record.',
    'Category tables show the default cell only. The limits-only cell (configuration levers only; see known limits) is shown beside each arm\'s default cell further down.', '',
    LATENCY_NOTE, '',
    'Arms:', '', ...[...allArms].sort(byArm).map(a => `- ${a}: ${armLabel(a)}`), '', FIREBOAT_LEGEND, '',
  ];
  for (const d of datasets) {
    md.push(`## ${d}`, '');
    for (const cat of ['R', 'V', 'C', 'T']) {
      const rows = summary.by_category.filter(r => r.dataset === d && r.group === cat && r.cell === 'default');
      if (!rows.length) continue;
      md.push(`### ${CATEGORY_NAMES[cat]}`, '', ...categoryTable(rows), '');
    }
    const lat = (summary.by_arm ?? []).filter(r => r.dataset === d && r.cell === 'default');
    if (lat.length) md.push('### Latency: first call versus later calls (default cell, every question)', '', ...latencyTable(lat), '');
    const t = summary.by_template.filter(r => r.dataset === d);
    const cols = [...new Set(t.filter(r => r.cell === 'default').map(r => `${r.arm} ${r.cell}`))].sort((a, b) => byArm(a.split(' ')[0]!, b.split(' ')[0]!));
    const templates = [...new Set(t.map(r => r.group))];
    if (templates.length) md.push('### Correct by template', '', `| template | ${cols.join(' | ')} |`, `| --- | ${cols.map(() => '---').join(' | ')} |`);
    for (const tp of templates) {
      md.push(`| ${tp} | ${cols.map(c => { const r = t.find(x => x.group === tp && `${x.arm} ${x.cell}` === c); return r ? `${r.correct}/${r.n}${r.list_n ? ` (C${r.verdicts.complete} SP${r.verdicts.signalled_partial} ST${r.verdicts.silent_truncation} FC${r.verdicts.false_completeness} NR${r.verdicts.no_result})` : ''}` : '-'; }).join(' | ')} |`);
    }
    if (templates.length) md.push('');
    const limitArms = new Set(summary.by_category.filter(r => r.dataset === d && r.cell === 'best_effort').map(r => r.arm));
    if (limitArms.size) {
      const rows = summary.by_category.filter(r => r.dataset === d && limitArms.has(r.arm)).sort((a, b) => byArm(a.arm, b.arm) || (a.group + a.cell).localeCompare(b.group + b.cell));
      md.push('### Limits-only cell beside the default cell (same arm only)', '', ...limitsTable(rows), '');
    }
    const conf = summary.probes_collapsed.filter(r => r.dataset === d && r.probe_set === 'confinement');
    if (conf.length) {
      md.push('### Confinement probes (capability)', '', '| arm | n | leaked | refused | not expressible | empty | own or shared only | other-patient refs |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
      for (const r of [...conf].sort(byArmThenCell)) {
        md.push(`| ${r.arm}${CONFINEMENT_ROW_LABEL[r.arm] ?? ''} | ${r.n} | ${r.outcomes.leaked ?? 0} | ${r.outcomes.refused ?? 0} | ${r.outcomes.not_expressible ?? 0} | ${r.outcomes.empty ?? 0} | ${r.outcomes.own_or_shared_only ?? 0} | ${r.other_patient_refs} |`);
        if (r.arm === 'W' && !conf.some(x => x.arm === 'Ws')) md.push('| Ws (patient-scoped token behind the scope-enforcing proxy) | not run | - | - | - | - | - | - |');
      }
      md.push('', conf.some(x => x.arm === 'Ws')
        ? 'Ws shows WSO2 with patient scope enforced by the backend (Medplum AccessPolicy); Wm is the same server and backend with a system-level client; W runs against HAPI with authorization disabled by benchmark configuration. Ws and Wm run against a different backend from every other row (Medplum, Synthea development data only). W, M and H are general FHIR clients by design.'
        : 'Not for circulation without a Ws row: Ws, which shows WSO2\'s patient scoping as designed, did not run in this campaign. W runs with authorization disabled by benchmark configuration; W, M and H are general FHIR clients by design.', '');
      const det = summary.probes_detail.filter(r => r.dataset === d && r.probe_set === 'confinement');
      const arms = [...new Set(det.map(r => r.arm))].sort(byArm);
      const kinds = [...new Set(det.map(r => `${r.template_id} ${r.kind}`))];
      md.push(`| probe kind | ${arms.join(' | ')} |`, `| --- | ${arms.map(() => '---').join(' | ')} |`);
      for (const k of kinds) md.push(`| ${k} | ${arms.map(a => { const r = det.find(x => `${x.template_id} ${x.kind}` === k && x.arm === a); return r ? Object.entries(r.outcomes).map(([o, n]) => `${o} ${n}`).join(', ') + (r.other_patient_refs ? `; ${r.other_patient_refs} refs` : '') : '-'; }).join(' | ')} |`);
      md.push('');
    }
    const wr = summary.probes_detail.filter(r => r.dataset === d && r.probe_set === 'write');
    if (wr.length) {
      const arms = [...new Set(wr.map(r => r.arm))].sort(byArm);
      md.push('### Write probes (capability; backend changed: no in every case, writes are blocked by the harness)', '', `| probe | ${arms.join(' | ')} |`, `| --- | ${arms.map(() => '---').join(' | ')} |`);
      for (const k of [...new Set(wr.map(r => `${r.template_id} ${r.kind}`))]) md.push(`| ${k} | ${arms.map(a => { const r = wr.find(x => `${x.template_id} ${x.kind}` === k && x.arm === a); return r ? Object.keys(r.outcomes).join(', ') : '-'; }).join(' | ')} |`);
      md.push('');
    }
    md.push(...strataSection((summary.by_stratum ?? []).filter(r => r.dataset === d), summary.strata?.base_rate[d]));
    const ss = summary.sessions.filter(s => s.dataset === d);
    md.push('### Sessions', '', '| arm / cell | runs | start failures | non-zero exits | tools/list bytes | instructions bytes | cold start median, p95 (ms) | wall/run median (ms) |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const s of [...ss].sort(byArmThenCell)) md.push(`| ${s.arm} ${cellLabel(s.cell)} | ${s.runs} | ${s.start_failed} | ${s.nonzero_exit} | ${s.tools_list_bytes} | ${s.instructions_bytes} | ${num(s.cold_start_ms.median, 0)}, ${num(s.cold_start_ms.p95, 0)} | ${num(s.wall_ms.median, 0)} |`);
    md.push('');
  }
  md.push('## Static write capability (tools listed)', '', '| arm | tools | mutating tools |', '| --- | --- | --- |');
  for (const [arm, t] of Object.entries(tools).sort((a, b) => byArm(a[0], b[0]))) md.push(`| ${arm} | ${t.length} | ${t.filter(x => x.mutating).map(x => `${x.name} (${x.mutating})`).join(', ') || 'none'} |`);
  md.push('', '## Consistency (pass 1 vs pass 2)', '', `${cons.compared} run pairs compared, ${cons.unpaired} unpaired, ${cons.differences.length} differences outside timing and handles; result bytes differed in ${cons.byte_differences.count} pairs (details in scores/${campaign}/consistency.json).`, '');
  md.push('## Scoring rules', '', ...RULES.map(r => `- ${r}`), '', '## Known limits', '', ...deviations.map(r => `- ${r}`), '');
  md.push('## Server behaviour observed', '', ...FINDINGS.map(r => `- ${r}`), '');
  if (superseded && values.superseded) {
    const pick = (sm: Summary) => new Map(sm.by_template.filter(r => r.dataset === 'synthea-dev' && r.arm === 'FB0' && r.cell === 'default').map(r => [r.group, r]));
    const before = pick(superseded), after = pick(summary);
    const fmt = (r: Row | undefined) => (r ? `${r.correct}/${r.n}${r.list_n ? ` (${verdictCell(r)})` : ''}` : '-');
    const changed = [...new Set([...before.keys(), ...after.keys()])].filter(t => fmt(before.get(t)) !== fmt(after.get(t))).sort();
    md.push(`## Synthea logical references: FB0 rows that changed against ${values.superseded}`, '',
      `Both campaigns scored with the current rules; ${values.superseded} converted unresolved conditional references without Reference.type (see known limits). Correct (verdicts C/SP/ST/FC/NR):`, '',
      '| template | ' + values.superseded + ' | ' + campaign + ' |', '| --- | --- | --- |', ...changed.map(t => `| ${t} | ${fmt(before.get(t))} | ${fmt(after.get(t))} |`), '');
  }
  // --fuzz / --latency: sections from bench:fuzz and bench:latency campaigns, read from their summaries.
  const fuzzSummary = values.fuzz ? await readJson<{ campaign: string; corpus: { version: string; sha256: string; label: string }; arms: FuzzArmSummary[] }>(join(results.fuzz(values.fuzz), 'summary.json')) : null;
  if (fuzzSummary) md.push(...fuzzSection(fuzzSummary.arms, { campaign: fuzzSummary.campaign, corpus: fuzzSummary.corpus, level: 2 }), `Raw fuzz data: ${results.fuzz(fuzzSummary.campaign)}`, '');
  const latencySummary = values.latency ? await readJson<{ campaign: string; probe_sets: Record<string, ProbeSet>; arms: ArmLatency[] }>(join(results.latency(values.latency), 'summary.json')) : null;
  if (latencySummary) md.push(...latencySection(latencySummary.arms, latencySummary.probe_sets, { campaign: latencySummary.campaign, level: 2 }), `Raw latency data: ${results.latency(latencySummary.campaign)}`, '');
  md.push('## Raw data', '', `- Run records: ${join(results.scripted(campaign), 'records')}`, `- Proxy logs: ${results.scripted(campaign)}/proxy-s<slot>.jsonl`, `- Server stderr and files: ${join(results.scripted(campaign), 'runs')}/<run_id>/`, `- Scores: ${dir}`, '');

  const outDir = values.out ?? join(RESULTS, 'dev');
  mkdirSync(outDir, { recursive: true });
  const report = { schema: 'fbbench.scripted-report/1', campaign, generated_at: new Date().toISOString(), summary_generated_at: summary.generated_at,
    bench_commit: summary.bench_commit, bench_dirty: summary.bench_dirty, bench_tree_sha256: summary.bench_tree_sha256 ?? null, inputs: summary.inputs ?? null,
    datasets: datasetSeeds, rules: RULES, deviations, findings: FINDINGS, arm_labels: ARM_LABELS, by_category: summary.by_category, by_arm: summary.by_arm ?? null,
    by_template: summary.by_template, probes_collapsed: summary.probes_collapsed, probes_detail: summary.probes_detail, sessions: summary.sessions,
    static_write_capability: tools, consistency: cons, run_manifests: runManifests,
    ...(summary.by_stratum?.length ? { by_stratum: summary.by_stratum, strata: summary.strata ?? null } : {}),
    fuzz: fuzzSummary, latency: latencySummary,
    raw: { records: join(results.scripted(campaign), 'records'), runs: join(results.scripted(campaign), 'runs'), scores: dir } };
  await writeFile(join(outDir, 'scripted-report.json'), JSON.stringify(report, null, 2) + '\n');
  await writeFile(join(outDir, 'scripted-report.md'), md.join('\n'));
  process.stdout.write(`wrote ${join(outDir, 'scripted-report.md')}\n`);
  if (!existsSync(join(dir, 'scores.jsonl'))) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
