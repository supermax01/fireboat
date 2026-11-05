import { STUDY, compactResult, quantile, requireS11, type Pair } from './study.js';
import type { Attempt } from './measure.js';

export interface Tokens {
  schema: string; status: 'unmeasured' | 'exploratory' | 'measured';
  attempts: { id: string; tokens: Record<string, { catalog: number; request: number; model: number; wire: number; combined_task: number }> }[];
}
const distribution = (xs: number[]) => xs.length ? { n: xs.length, min: Math.min(...xs), median: quantile(xs, 0.5), p90: quantile(xs, 0.9), max: Math.max(...xs) } : { n: 0, min: null, median: null, p90: null, max: null };
const segmentBytes = (a: Attempt, kind: 'catalog' | 'request') => a.segments.filter(s => s.kind === kind).reduce((n, s) => n + s.file.bytes, 0);
export function analyze(attempts: readonly Attempt[], tokens: Tokens | undefined, fulfilled: boolean, fidelityMutations = false) {
  requireS11(new Set(attempts.map(a => a.id)).size === attempts.length, 'ATTEMPT_DUPLICATE');
  requireS11(!tokens || tokens.schema === 'fireboat-s11-tokens/1', 'TOKEN_SCHEMA');
  const tokenRows = new Map(tokens?.attempts.map(row => [row.id, row]) ?? []);
  requireS11(!tokens || tokenRows.size === tokens.attempts.length && [...tokenRows.keys()].every(id => attempts.some(a => a.id === id)), 'TOKEN_IDENTITY');
  requireS11(!tokens || tokens.attempts.every(row => STUDY.encodings.every(encoding => {
    const t = row.tokens[encoding];
    return t && [t.catalog, t.request, t.model, t.wire, t.combined_task].every(n => Number.isSafeInteger(n) && n >= 0)
      && t.combined_task === t.catalog + t.request + t.model;
  })), 'TOKEN_COUNTS_INVALID');
  const primary = attempts.filter(a => a.split === 'heldout' && a.stratum === 'large');
  const c1 = [], c2 = [], c3 = [];
  for (const era of STUDY.eras) {
    for (const encoding of STUDY.encodings) {
      const cell = primary.filter(a => a.era === era), patients = [...new Set(cell.map(a => a.patient))].sort();
      const pairs: Pair[] = patients.flatMap(patient => STUDY.templates.map(template => {
        const matching = cell.filter(a => a.patient === patient && a.template === template);
        const fhir = matching.filter(a => a.arm === 'fhir'), compact = matching.filter(a => a.arm === 'compact');
        const ft = fhir[0] && tokenRows.get(fhir[0].id)?.tokens[encoding]?.model;
        const ct = compact[0] && tokenRows.get(compact[0].id)?.tokens[encoding]?.model;
        return { patient, template, fhir: ft ?? 0, compact: ct ?? 0,
          success: fhir.length === 1 && compact.length === 1 && fhir[0]!.status === 'pass' && compact[0]!.status === 'pass'
            && fhir[0]!.fidelity.failed === 0 && compact[0]!.fidelity.failed === 0 && fhir[0]!.fidelity.checked > 0 && compact[0]!.fidelity.checked > 0 };
      }));
      const descriptive = compactResult(pairs, fulfilled, fidelityMutations);
      const result = tokens?.status === 'measured' ? descriptive : compactResult(pairs, false, fidelityMutations);
      c1.push({ era, delivery: STUDY.delivery, encoding, ...result, descriptive_statistics: descriptive,
        acceptance: tokens?.status !== 'measured' ? 'unmeasured-reference-tokenizer' : !fidelityMutations ? 'unmeasured-fidelity-mutation-gate' : result.status === 'unmeasured' ? 'unmeasured' : !result.target_met ? 'target-unmet' : result.status === 'smaller' ? 'target-met' : result.status,
        runtime_default: 'fhir', scope: 'scripted full-text evaluation host / synthetic adapter; no real-host or HAPI efficiency claim' });
    }
    for (const arm of STUDY.arms) {
      for (const split of ['development', 'heldout'] as const) {
        const cell = attempts.filter(a => a.era === era && a.arm === arm && a.split === split), successes = cell.filter(a => a.status === 'pass');
        c2.push({ era, delivery: STUDY.delivery, arm, split, attempted: cell.length, correct: successes.length,
          failed: cell.filter(a => a.status === 'fail').length, unsupported: cell.filter(a => a.status === 'unsupported').length,
          model_bytes_per_correct_answer: distribution(successes.map(a => a.model_bytes)),
          catalog_bytes_all_attempts: distribution(cell.map(a => segmentBytes(a, 'catalog'))), request_bytes_all_attempts: distribution(cell.map(a => segmentBytes(a, 'request'))),
          combined_semantic_bytes_all_attempts: distribution(cell.map(a => a.model_bytes + segmentBytes(a, 'catalog') + segmentBytes(a, 'request'))),
          wire_result_bytes_all_attempts: distribution(cell.map(a => a.wire_result_bytes)), frame_bytes_all_attempts: distribution(cell.map(a => a.frame_bytes)),
          token_status: tokens && cell.every(a => tokenRows.has(a.id)) ? tokens.status : 'unmeasured', tokens: STUDY.encodings.map(encoding => ({ encoding,
            per_correct_answer: distribution(successes.flatMap(a => { const row = tokenRows.get(a.id)?.tokens[encoding]; return row ? [row.model] : []; })),
            // Catalog, requests and complete task costs remain separate from C.1's result-token ratio.
            catalog: distribution(cell.flatMap(a => { const row = tokenRows.get(a.id)?.tokens[encoding]; return row ? [row.catalog] : []; })),
            requests: distribution(cell.flatMap(a => { const row = tokenRows.get(a.id)?.tokens[encoding]; return row ? [row.request] : []; })),
            combined_task: distribution(cell.flatMap(a => { const row = tokenRows.get(a.id)?.tokens[encoding]; return row ? [row.combined_task] : []; })),
            wire_results: distribution(cell.flatMap(a => { const row = tokenRows.get(a.id)?.tokens[encoding]; return row ? [row.wire] : []; })),
          })), reduction_threshold: null });
      }
      if (arm === 'selected') continue;
      const cell = primary.filter(a => a.era === era && a.arm === arm);
      const patients = [...new Set(cell.map(a => a.patient))];
      const complete = fulfilled && cell.length === 24 && cell.every(a => a.status === 'pass' && a.envelope.structured > 0)
        && patients.length === 8 && patients.every(patient => STUDY.templates.every(template => cell.filter(a => a.patient === patient && a.template === template).length === 1));
      const shares = cell.filter(a => a.envelope.structured > 0).map(a => (a.envelope.provenance + a.envelope.withheld + a.envelope.coverage) / a.envelope.structured);
      const targetMet = complete && quantile(shares, 0.5) <= STUDY.thresholds.overheadMedian;
      c3.push({ era, delivery: STUDY.delivery, arm, status: complete ? 'measured' : 'unmeasured',
        target_met: targetMet,
        attainment: !complete ? 'unmeasured' : targetMet ? 'target-met' : 'target-unmet',
        combined_share_all_attempts: distribution(shares), structured_bytes: distribution(cell.map(a => a.envelope.structured)),
        provenance_bytes: distribution(cell.map(a => a.envelope.provenance)), withheld_bytes: distribution(cell.map(a => a.envelope.withheld)),
        coverage_bytes: distribution(cell.map(a => a.envelope.coverage)), remaining_nonresource_bytes: distribution(cell.map(a => a.envelope.remaining)),
        attempted: cell.length, complete_successes: cell.filter(a => a.status === 'pass').length });
    }
  }
  return { schema: 'fireboat-s11-report/1', c1, c2, c3,
    structured_delivery: { status: 'unmeasured', reason: 'No verified host/client/version/era/transport/workflow cell is shipped; no structuredContent guess or fixture-only slim claim.', paired_absolute_savings: null },
    defaults: { format: 'fhir', delivery: 'full-text-v1', changed: false },
    attempts: attempts.map(a => ({ id: a.id, patient: a.patient, split: a.split, stratum: a.stratum, template: a.template, era: a.era, arm: a.arm,
      status: a.status, reason: a.reason, fidelity: a.fidelity, model_bytes: a.model_bytes, wire_result_bytes: a.wire_result_bytes,
      negotiated_protocol: a.negotiated_protocol ?? null, eval_identity: a.eval_identity ?? null,
      catalog_bytes: segmentBytes(a, 'catalog'), request_bytes: segmentBytes(a, 'request'),
      frame_bytes: a.frame_bytes, envelope: a.envelope, tokens: tokenRows.get(a.id)?.tokens ?? null,
      tool_calls: a.eval?.metrics.tool_calls ?? 0, upstream_calls: a.eval?.metrics.upstream_calls ?? 0,
      failures: a.eval?.failures.map(f => ({ cause: f.cause, step: f.step, check_id: f.check_id })) ?? [] })),
  };
}
