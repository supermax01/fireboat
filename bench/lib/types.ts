// Record formats the harness writes and reads. Records carry a `schema` field; change it when a format changes.
import type { DatasetId } from './paths.js';

export type { DatasetId } from './paths.js';
export type Category = 'R' | 'V' | 'C' | 'T';
export type AnswerForm = 'value' | 'datetime' | 'list' | 'count' | 'yes_no';
export type AnswerKind = 'value' | 'list' | 'none';
/** "Type/id", e.g. "Observation/123". */
export type Ref = string;
/** FHIR search parameters in FHIR terms, ordered, repeatable: [["patient","Patient/x"],["date","ge2150-01-01T00:00:00Z"]]. */
export type SearchParams = [name: string, value: string][];

// ---- Abstract operations -------------------------------------------------------------------------

export type AbstractOp =
  | { op: 'capabilities'; type: string | null }
  | { op: 'read'; type: string; id: string }
  | { op: 'search'; type: string; params: SearchParams }
  | { op: 'next'; of: number } // follow the page handle of operations[of] (a search or next)
  | { op: 'drain'; type: string; params: SearchParams; call_cap: number }; // search + next until no handle or cap

/** kind 'drand': a public drand round's randomness (`round`, `chain_hash` recorded); the holdout's sets use the round that drew it. */
export interface SeedInfo { kind: 'dev' | 'preregistered' | 'drand'; hex: string; purpose: string; round?: string; chain_hash?: string }

// ---- questions.jsonl ----------------------------------------------------------------------------------------

export interface QuestionRecord {
  schema: 'fbbench.question/1';
  id: string; // `${dataset}.${template_id}.${rank_hash.slice(0, 12)}`
  dataset: DatasetId;
  patient_id: string; // Patient.id without "Patient/"
  template_id: string; // template ids: L1, G2, O1, ... (gold/templates.ts)
  group: string; // template group name
  category: Category;
  encounter_scoped: boolean;
  phrasing: 'concept' | 'code';
  question: string;
  reference_time: string | null; // explicit offset
  mimic_subject_id: string | null;
  parameters: Record<string, string>;
  operations: AbstractOp[];
  answer_form: AnswerForm;
  seed: SeedInfo;
  rank_hash: string;
  candidate_key: string;
}

// ---- gold.jsonl ---------------------------------------------------------------------------------------------

export interface GoldItem {
  ref: Ref;
  value: string | null; // decimal string or text
  value_as_recorded: string | null; // exact lexeme in the file
  unit: string | null; // record's unit, else code
  unit_code: string | null;
  unit_system: string | null;
  time: string | null; // as recorded, with offset
  display: string | null;
}

export interface GoldRecord {
  schema: 'fbbench.gold/1';
  question_id: string;
  dataset: DatasetId;
  patient_id: string;
  implementation: 'ts' | 'py' | 'reconciled';
  answer_form: AnswerForm;
  answer_kind: AnswerKind;
  answer: string | null; // value | datetime | count | "yes" | "no"
  answer_list: string[] | null; // sorted by UTF-8 byte order
  value_as_recorded: string | null;
  unit: string | null;
  timestamp: string | null;
  items: GoldItem[]; // what a scripted probe must return; [] when not item-based
  provenance: Ref[]; // records the answer is read from
  depends_on: Ref[]; // G: every record needed to know the answer is right
  completeness: { size: number; pages_at_100: number };
  lexeme_eligible: boolean; // a float round trip would change value_as_recorded
  rule_notes: string[];
}

// ---- arms ---------------------------------------------------------------------------------------------------

export type ArmId = 'FB0' | 'W' | 'M' | 'H' | 'NT' | 'FB' | 'FBd' | 'FBt' | 'Ws' | 'Wm' | 'Wn' | 'L' | 'FBh' | 'FBdh' | 'AH'; // Ws, Wm: Medplum backend; FBh, FBdh, AH: HealthLake backend
/** Arms that run fireboat (same tools, adapter, parser and page size). FBd, FBt: FB's build with other privacy lists; FBh, FBdh: FB and FBd against HealthLake. */
export const FIREBOAT_ARMS: readonly ArmId[] = ['FB0', 'FBd', 'FB', 'FBt', 'FBdh', 'FBh'];
export const isFireboatArm = (arm: ArmId): boolean => FIREBOAT_ARMS.includes(arm);
export type Cell = 'default' | 'best_effort';

export interface LaunchContext {
  arm: ArmId;
  dataset: DatasetId;
  patientId: string;
  slot: number;
  fhirBaseUrl: string; // the slot's recording proxy, e.g. http://127.0.0.1:18210/fhir
  runDir: string; // fresh empty directory; the server's cwd and HOME
  runTmp: string; // per-run TMPDIR
  cell?: Cell; // default 'default'; fireboat's best-effort cell changes its config
}

export interface ServerCommand {
  command: string; // absolute path
  args: string[];
  env: Record<string, string>; // the complete environment (env -i semantics)
  cwd: string;
  files: Record<string, string>; // runDir-relative path -> content, written before start
}

export interface ToolCall { tool: string; arguments: Record<string, unknown> }

export type CountedSignal =
  | 'next_link' | 'cursor' | 'total_gt_returned' | 'has_more' | 'more_pages_reason' | 'coverage_partial' | 'withheld_manifest';

export interface ParsedItem {
  ref: Ref;
  patient: string | null; // Patient.id the item names, if visible
  value: string | null; // lexeme string; never a JS number
  comparator: string | null; // Quantity.comparator as returned (servers that drop it report null)
  unit: string | null;
  unit_code: string | null;
  unit_system: string | null;
  time: string | null;
  display: string | null;
}

export interface ParsedResult {
  items: ParsedItem[];
  signals: { kind: CountedSignal; detail: string }[];
  blanket: string[]; // labels attached to every response; never counted
  explicit_complete: boolean; // the output claims completeness or reports total == |items|
  page_handle: string | null; // what the adapter's next() would follow
  refused: { code: string; message: string } | null;
  is_error: boolean;
}

// ---- run-results.jsonl (scripted track) ---------------------------------------------------------------------

export interface CallBytes { content_text: number; structured_content: number; result: number; line: number }

export interface CallRecord {
  seq: number;
  op_index: number;
  op: 'capabilities' | 'read' | 'search' | 'next' | 'operation' | 'write'; // operation, write: probes only
  tool: string;
  arguments: Record<string, unknown>;
  started_at: string;
  latency_ms: number;
  response_raw: string | null; // exact JSON-RPC response line, without the trailing newline
  is_error: boolean | null;
  bytes: CallBytes | null;
  error: { kind: 'timeout' | 'transport' | 'protocol' | 'client_validation' | 'crash'; message: string } | null;
}

export type OpOutcome = 'ok' | 'tool_error' | 'cannot_continue' | 'refused_by_adapter' | 'call_cap' | 'failed';

export interface RunRecord {
  schema: 'fbbench.run/1';
  campaign: string;
  run_id: string; // `${arm}__${cell}__p${pass}__${question_id}`
  pass: 1 | 2;
  arm: ArmId;
  cell: Cell;
  dataset: DatasetId;
  question_id: string;
  patient_id: string;
  slot: number;
  started_at: string;
  wall_ms: number;
  server: {
    command: ServerCommand;
    pid: number | null;
    cold_start_ms: number | null; // spawn -> initialize result
    protocol_version: string | null;
    server_info: unknown;
    instructions_bytes: number;
    tools_list_bytes: number;
    exit: { code: number | null; signal: string | null } | null;
    stderr_path: string;
    egress_sandbox: 'sandbox-exec' | 'none';
  };
  calls: CallRecord[];
  op_outcomes: { op_index: number; outcome: OpOutcome; detail: string }[];
  flags: string[];
  upstream: { proxy_log: string; requests: number; blocked_writes: number; first_seq: number | null; last_seq: number | null };
  /**
   * arm_pin: the arm's commit, else its version. arm_tree_dirty: for a fireboat arm built from the checkout's HEAD,
   * whether that checkout had uncommitted changes (ArmPin.treeDirty); absent otherwise.
   */
  versions: { bench_commit: string; bench_dirty: boolean; bench_tree_sha256?: string; bench_tree_files?: number; arm_pin: string; arm_tree_dirty?: boolean };
}

export interface ProxyLogRecord {
  schema: 'fbbench.proxy/1';
  run_id: string;
  slot: number;
  seq: number;
  started_at: string;
  method: string;
  path: string;
  query: string;
  status: number;
  request_bytes: number;
  response_bytes_decoded: number;
  ms: number;
  blocked: boolean; // write attempt answered 403 by the harness
}

// ---- scores.jsonl (scripted track) --------------------------------------------------------------------------

export type Verdict = 'complete' | 'signalled_partial' | 'silent_truncation' | 'false_completeness';

export interface ScoreRecord {
  schema: 'fbbench.score/1';
  campaign: string;
  run_id: string;
  arm: ArmId;
  cell: Cell;
  pass: 1 | 2;
  dataset: DatasetId;
  question_id: string;
  template_id: string;
  category: Category;
  correct: 0 | 1;
  items: { gold: number; returned: number; matched: number; value_ok: number; unit_ok: number; time_ok: number; identity_ok: number; unit_code_kept: number; unit_code_eligible: number };
  other_patient_refs: Ref[];
  verdict: Verdict | null; // null when the question is not a list probe
  first_page_coverage: number | null;
  recall: number | null;
  precision: number | null;
  extra_records?: number; // list-operation records outside the gold set
  suppressed_reads?: Ref[]; // reads answered NOT_FOUND although HAPI served them (silent truncation)
  lexeme: { eligible: number; exact: number };
  // Templates whose answer is read from a record (gold/rules.ts ANSWER_ENTRIES): gold items with a returned copy (checked)
  // and those where some copy yields the item's expected answer entries (ok). Absent for other templates, for band B4
  // (scored on the verdict) and in older scores.
  answer_text?: { checked: number; ok: number };
  calls: number;
  bytes: CallBytes;
  latency_ms: number; // sum of call latencies
  // Session cost versus per-call cost. Absent in older scores.
  first_call_ms?: number | null; // latency of the run's first call (null: no call); pays once-per-session work such as a CapabilityStatement fetch
  later_calls_median_ms?: number | null; // median latency of the calls after the first (null: at most one call)
  signals: CountedSignal[];
  failure: string[]; // e.g. "cannot_continue", "tool_error", "server_crash", "refused"
  notes: string[];
  // Strata: "answer" (LS2 in B1-B3: correct on the answer; verdict reported beside it) or
  // "verdict" (B4: correct = signalled_partial, or complete with the whole set returned). Absent for every other question.
  scored_on?: 'answer' | 'verdict';
}

// ---- agent-runs.jsonl ------------------------------------------------------------------

export interface AgentAnswer {
  answer_kind: AnswerKind;
  answer: string | null;
  answer_list: string[] | null;
  value_as_recorded: string | null;
  unit: string | null;
  timestamp: string | null;
  resource_ids: string[];
  completeness: 'all_retrieved' | 'not_all_retrieved' | 'not_sure';
  abstained: boolean;
  explanation: string;
}

export interface AgentRunRecord {
  schema: 'fbbench.agent/1';
  run_id: string; // `${arm}__agent__r${repetition}__${question_id}`
  kind: 'smoke' | 'pilot' | 'test' | 'mock'; // mock: harness self-test against the local mock Messages API (agent/mock-api.ts), never a model run
  arm: ArmId;
  dataset: DatasetId;
  question_id: string;
  patient_id: string;
  repetition: number;
  slot: number;
  started_at: string;
  host: { path: string; version: string; sha256: string };
  model_requested: string;
  effort: string;
  models_seen: string[]; // model id of every assistant message
  argv: string[]; // with the prompt and schema replaced by their sha256
  env_names: string[]; // variable names only; values of secrets never recorded
  prompt_sha256: string;
  schema_sha256: string;
  mcp_config: unknown; // as passed, secrets removed
  paths: { run_dir: string; prompt: string; stream: string; stderr: string; proxy_log: string };
  init: { server_status: unknown; tools: string[]; claude_code_version: string | null; model: string | null } | null;
  structured_output_raw: string | null; // exact JSON text of the structured output
  structured_output: AgentAnswer | null; // parsed with numbers as strings; null if absent or invalid
  terminal_status: string | null; // result event subtype, e.g. "success", "error_max_turns"
  num_turns: number | null;
  usage: { input: number; output: number; cache_write: number; cache_read: number } | null;
  total_cost_usd: string | null; // as reported, lexeme kept
  wall_ms_from_init: number | null;
  tool_calls: { name: string; arguments: unknown; is_error: boolean; result_bytes: number }[];
  invalid_tool_calls: number;
  tool_result_bytes: number;
  flags: { f4_host: boolean; host_altered_context: boolean; wrong_model: boolean; server_connect_failed: boolean };
  infra_retry: number;
  exit: { code: number | null; signal: string | null };
}

export interface AgentScoreRecord {
  schema: 'fbbench.agent-score/1';
  run_id: string;
  arm: ArmId;
  question_id: string;
  correct: 0 | 1;
  answered: boolean;
  resource_id_precision: number | null;
  resource_id_recall: number | null;
  completeness_claim: AgentAnswer['completeness'] | null;
  all_retrieved_from_log: boolean | null;
  lexeme_match: boolean | null; // S9, eligible items only
  failure: string[]; // F1..F13 codes
}
