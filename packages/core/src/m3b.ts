// Owner: F (root foundation). TYPES ONLY — frozen shared interfaces for the
// Q and P work packages (spec §10 items 5-6, G-11). Behavior lives in
// query.ts (Q) and projection.ts (P); neither worker edits this file.
// Ownership map: m3b.ts=F(types), query.ts=Q, projection.ts=P, catalog.ts=root,
// delivery.ts=P, repairs.ts=P. Nothing here is reachable from the MCP surface.
import type { CoverageV2, FhirResource } from './contracts.js';

export interface QueryEvidence {
  /** Ordered outbound material pairs, paging/sort mechanics excluded. */
  constraints: readonly { name: string; value: string; source_reported: 'matched' | 'not_reported' | 'not_checked'; execution: 'gateway_enforced' | 'tested_adapter' | 'unknown'; evidence_ref?: string }[];
  query_digest?: string;
  sort?: { requested: readonly string[]; effective: readonly string[] | null; order: 'unspecified' | 'requested_unverified' | 'verified_by_adapter' };
  materialFilterProved: boolean;
  evidenceKind: Exclude<CoverageV2['query_evidence'], 'none'>;
}

export interface QueryChainView {
  deliveredCount: number;
  pagesObserved: number;
  queryEvidence: QueryEvidence;
  sortProof: 'none' | 'claimed' | 'contradicted';
  remainder: 'none' | 'local' | 'upstream' | 'rejected_link' | 'unknown';
  exhausted: boolean;
  scope: CoverageV2['scope'];
  authorizationLimited: boolean;
  /** Explicit continuation state (§7, G-11): true when no safe continuation exists. */
  nonContinuable?: boolean;
  /** Explicit refusal state (§7, G-11): set when delivery was refused (e.g. precision). */
  refused?: boolean;
  refusalReasons?: readonly string[];
}

export interface SanitizedProjectionRecord {
  resource: FhirResource;
  retrievedAt: string;
  /** Policy/payload omission paths from sanitization, already safe to disclose. */
  policyOmitted: readonly string[];
  withheldReasons: readonly string[];
  requiresStructuralView: boolean;
}

export interface ProjectionMeta {
  recipe_id?: string;
  omitted_fields: string[];
  unresolved_fields: string[];
  interpretation: 'clinical_projection' | 'structural';
  warnings: { code: string; message: string }[];
}

/** Discovery snapshot kinds (Q-owned discovery.ts). Metadata only; never clinical bodies. */
export type DiscoverySnapshot =
  | { topic: 'search_parameter'; resourceType: string; revision: string; capturedAt: string; expiresAt: string }
  | { topic: 'server'; revision: string; capturedAt: string; expiresAt: string }
  | { topic: 'support'; revision: string; capturedAt: string; expiresAt: string };

/** Snapshot overlay field names frozen for Q (spec §7): extend, never rename. */
export interface QueryOverlay {
  deliveredCount: number;
  pagesObserved: number;
  queryEvidence: QueryEvidence;
  sortProof: QueryChainView['sortProof'];
  /** Current flags only; full ordered constraints live in immutable backing evidence. */
  constraintProof?: readonly Pick<QueryEvidence['constraints'][number], 'source_reported' | 'execution'>[];
  sortBoundary?: number;
  sortBoundaryPrecision?: 'year' | 'month' | 'day' | 'minute' | 'second' | 'fraction';
  /** S6 continuation accounting: the fetched page's numeric offset and the match entries the source returned on it. */
  pageOffset?: number;
  pageEntries?: number;
  /** S6: sticky once any continuation in the chain could not be verified; every later page keeps N-06. */
  continuationUnverified?: boolean;
  /** Explicit continuation/refusal flags (§7, G-11), mirroring QueryChainView. */
  nonContinuable?: boolean;
  refused?: boolean;
  refusalReasons?: readonly string[];
}
