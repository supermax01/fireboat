/**
 * Packaging slice 7: the check vocabulary shared by the eval runner and the packaged quickstart oracle. Types and one
 * constant only; no runtime imports, so the helper can load the oracle without the eval runner, SDK or gateway.
 */
export type ArmName = 'fhir' | 'compact' | 'selected';

/**
 * Every check is bound to the step whose response must supply it (`step`, an index into `steps`; implicit only for
 * single-step tasks). A fact found in a different step's response does not satisfy it. Resource facts also bind the
 * resource version: the same response must carry provenance with `version` (default: the fixture's meta.versionId).
 */
interface Bound {
  id: string; step?: number; arms?: ArmName[]; incomparableReason?: string;
  /**
   * M3b (gate F): which response of the bound step must supply the fact; omitted = 0 for M3b kinds (the whole step for
   * the others), 'all' = every response. With `evaluateStepCheck` it indexes the step's recorded calls, envelope-less
   * calls included; with `evaluateBoundCheck` it indexes the delivered envelopes.
   */
  response_index?: number | 'all';
}
export type Check = Bound & (
  | { kind: 'fact'; resource: string; path: string; equals: unknown; version?: string }
  | { kind: 'factAbsent'; resource: string; path: string; version?: string }
  | { kind: 'resourceIds'; equals: string[] }
  /** Exact membership independent of source order; duplicate returned identities always fail. */
  | { kind: 'resourceIdSet'; equals: string[] }
  | { kind: 'resourceAbsent'; resource: string }
  | { kind: 'dataPath'; path: string; equals: unknown }
  | { kind: 'dataPathIncludes'; path: string; includes: unknown }
  | { kind: 'envelopePath'; path: string; equals: unknown }
  | { kind: 'schemaElement'; elementPath: string; types?: string[]; min?: number; max?: string; jsonNamesInclude?: string }
  | { kind: 'withheld'; minCount: number; reasonsInclude?: string }
  | { kind: 'omittedIncludes'; path: string }
  /** Every search/page request the step sent upstream carries name=value (from the fixture's request log). */
  | { kind: 'upstreamConstraint'; name: string; value: string }
  /** No response in the step that still has more pages publishes an upstream total. */
  | { kind: 'totalWithheldWhileMore' }
  /** The value at `path` is identical in every response of the step (a signal independent of the data seen). */
  | { kind: 'consistentAcross'; path: string }
  /** No response claims the named constraint in coverage.executed_constraints. */
  | { kind: 'constraintNotClaimed'; name: string }
  // M3b kinds, frozen at gate F (spec §9). `path` is an eval JSON path with numeric
  // indices; decimalLexeme.equals is raw numeric token text from the serialized frame.
  | { kind: 'decimalLexeme'; resource_type: string; id_value: string; path: string; equals: string }
  | { kind: 'citationTuple'; resource_type: string; id_value: string; source: string; version: string | null }
  | { kind: 'queryEvidence'; state: 'complete_for_query' | 'partial' | 'unknown'; query_exhausted: boolean | null; reasons_include?: string[]; constraints?: { name: string; value: string; source_reported: 'matched' | 'not_reported' | 'not_checked'; execution: 'gateway_enforced' | 'tested_adapter' | 'unknown' }[] }
  | { kind: 'sortEvidence'; requested: string[]; effective: string[] | null; order: 'unspecified' | 'requested_unverified' | 'verified_by_adapter' }
  | { kind: 'callOutcome'; outcome: 'json_rpc_error' | 'sdk_text_error' | 'application_error'; code: number | string }
  /**
   * Independently counted upstream work, summed over the selected calls: every call of the bound step when no
   * `response_index` is given, else the selected call. Unknown or missing counts never pass.
   */
  | { kind: 'upstreamWork'; clinical?: number; metadata?: number }
  /**
   * One cited occurrence, bound end to end (packaging slice 7, for the packaged tasks): in the selected response,
   * exactly one resource with this type, id and version, cited by valid response-local provenance from `source`, whose
   * raw wire form at the same index decodes to the delivered resource. `equals` compares the decoded value at `path`,
   * `lexeme` the raw numeric token there, `absent` requires the path to be absent; the path must exist otherwise.
   */
  | { kind: 'citedFact'; source: string; resource_type: string; id_value: string; version: string | null; path: string; equals?: unknown; lexeme?: string; absent?: true }
  /**
   * Upstream paging of a drained step (packaging slice 8): every call answers with an envelope, makes at most one clinical
   * request, the first makes one, and the calls from one clinical request up to the next deliver exactly `page_size`
   * resources (the last run at most that): a retained remainder is served before the next upstream page. Unknown work fails.
   */
  | { kind: 'upstreamPaging'; page_size: number }
  /**
   * A retained-result read against the response that issued its handle (the first answered call of the earlier
   * `from_step`): its rows (`omissions` entries for inspect, `resources` otherwise) are exactly that response's resources
   * `offset` to `offset + limit`, by type, id and version and in order; each of `fields` decodes identically in both;
   * Controls, omission indexes/details, cited retrieval times and raw numeric tokens are bound to that issuing call.
   * `whole_count` requires `data.resource_count` to equal that response's resource count.
   */
  | { kind: 'retainedSlice'; from_step: number; view: 'omissions' | 'resources'; offset: number; limit: number; fields?: string[]; whole_count?: true; action?: 'project' | 'page'; omissions?: { format: 'fhir' | 'compact'; omitted_fields: string[] | 'issuing_transform'; withheld_reasons: string[]; recipe_id?: string }[] }
);

export type M3bCheckKind = 'decimalLexeme' | 'citationTuple' | 'queryEvidence' | 'sortEvidence' | 'callOutcome' | 'citedFact' | 'retainedSlice';
export const M3B_CHECK_KINDS: ReadonlySet<string> = new Set(['decimalLexeme', 'citationTuple', 'queryEvidence', 'sortEvidence', 'callOutcome', 'citedFact', 'retainedSlice']);
