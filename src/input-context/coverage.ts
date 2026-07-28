import { canonicalJsonSha256 } from "../authority/canonical-json.js";
import type { ContextIrItemRecord, EvidenceObligationRecord } from "./domain.js";

const coveredDispositions = new Set([
  "MANDATORY_INLINE", "ALREADY_RETAINED", "INLINE_EXACT", "INLINE_TYPED_EXTRACT", "ON_DEMAND",
]);

export interface CoverageResult {
  readonly mandatoryObligationIds: readonly string[];
  readonly coveredMandatoryObligationIds: readonly string[];
  readonly uncoveredMandatoryObligationIds: readonly string[];
  readonly discoveryDebtObligationIds: readonly string[];
  readonly rootSha256: string;
}

export function validateCoverage(
  obligations: readonly EvidenceObligationRecord[],
  items: readonly ContextIrItemRecord[],
): CoverageResult {
  const mandatoryObligationIds = obligations
    .filter((obligation) => obligation.confidence === "PROVEN_REQUIRED")
    .map((obligation) => obligation.obligation_id).sort();
  const discoveryDebtObligationIds = obligations
    .filter((obligation) => obligation.confidence === "UNKNOWN_DISCOVERY")
    .map((obligation) => obligation.obligation_id).sort();
  const covered = new Set<string>();
  for (const item of items) {
    if (!coveredDispositions.has(item.disposition)) continue;
    for (const obligationId of item.obligation_ids) covered.add(obligationId);
  }
  const coveredMandatoryObligationIds = mandatoryObligationIds.filter((id) => covered.has(id));
  const uncoveredMandatoryObligationIds = mandatoryObligationIds.filter((id) => !covered.has(id));
  const closure = {
    mandatoryObligationIds, coveredMandatoryObligationIds,
    uncoveredMandatoryObligationIds, discoveryDebtObligationIds,
  };
  return { ...closure, rootSha256: canonicalJsonSha256({ domain: "PCH-CONTEXT-COVERAGE-V1", closure }) };
}
