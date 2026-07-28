import { hmacSha256Hex } from "../foundation/crypto.js";
import type {
  ContextCandidateRecord, ContextIrItemRecord, EvidenceObligationRecord,
} from "./domain.js";

export interface RetainedCandidateBinding {
  readonly candidateId: string;
  readonly retainedEntryId: string;
  readonly contentIdentityHmac: string;
}

export interface DeliveryPlan {
  readonly items: readonly ContextIrItemRecord[];
  readonly projectedTokens: number;
  readonly onDemandCandidateIds: readonly string[];
  readonly omittedOptionalCount: number;
}

function candidateIdentity(candidate: ContextCandidateRecord, key: string | Uint8Array): string {
  return hmacSha256Hex(key, [
    "PCH-CONTEXT-CANDIDATE-IDENTITY-V1", candidate.evidence_sha256, candidate.source_kind,
    candidate.trust, candidate.representation_fidelity, candidate.classification,
  ].join("\0"));
}

function validityDisposition(
  candidate: ContextCandidateRecord,
  obligations: ReadonlyMap<string, EvidenceObligationRecord>,
): ContextIrItemRecord["disposition"] | null {
  if (candidate.scope_authorization !== "AUTHORIZED") return "OMIT_UNAUTHORIZED";
  if (!["CURRENT", "NOT_APPLICABLE"].includes(candidate.semantic_applicability)) return "HISTORICAL_ONLY";
  if (!["HASH_CURRENT", "CHANGE_WITNESS_CURRENT", "NOT_APPLICABLE"].includes(candidate.content_freshness)) return "REREAD_REQUIRED";
  if (!["EXACT_RAW", "EXACT_DECODED", "TYPED_EXTRACT"].includes(candidate.representation_fidelity)) return "REREAD_REQUIRED";
  const bound = candidate.obligation_ids.flatMap((id) => {
    const obligation = obligations.get(id);
    return obligation ? [obligation] : [];
  });
  if (bound.some((obligation) => obligation.must_be_current)
    && candidate.content_freshness === "NOT_APPLICABLE"
    && !["AUTHORITY", "ARTIFACT"].includes(candidate.source_kind)) return "REREAD_REQUIRED";
  if (bound.some((obligation) => obligation.must_be_exact)
    && !["EXACT_RAW", "EXACT_DECODED", "TYPED_EXTRACT"].includes(candidate.representation_fidelity)) return "REREAD_REQUIRED";
  return null;
}

export function planDeliveries(input: {
  readonly candidates: readonly ContextCandidateRecord[];
  readonly obligations: readonly EvidenceObligationRecord[];
  readonly retainedCandidates: readonly RetainedCandidateBinding[];
  readonly evidenceTokenBudget: number;
  readonly optionalTokenBudget: number;
  readonly unknownCandidateTokens: number;
  readonly hmacKey: string | Uint8Array;
}): DeliveryPlan {
  const obligationMap = new Map(input.obligations.map((entry) => [entry.obligation_id, entry]));
  const retained = new Map(input.retainedCandidates.map((entry) => [entry.candidateId, entry]));
  const ranked = [...input.candidates].sort((left, right) => {
    const leftMandatory = left.obligation_ids.some((id) => obligationMap.get(id)?.confidence === "PROVEN_REQUIRED") ? 1 : 0;
    const rightMandatory = right.obligation_ids.some((id) => obligationMap.get(id)?.confidence === "PROVEN_REQUIRED") ? 1 : 0;
    return rightMandatory - leftMandatory
      || (left.estimated_tokens ?? input.unknownCandidateTokens) - (right.estimated_tokens ?? input.unknownCandidateTokens)
      || left.candidate_id.localeCompare(right.candidate_id);
  });
  const identities = new Set<string>();
  const items: ContextIrItemRecord[] = [];
  const onDemandCandidateIds: string[] = [];
  let remaining = input.evidenceTokenBudget;
  let projectedTokens = 0;
  let omittedOptionalCount = 0;
  let optionalBudgetApplied = false;
  for (let index = 0; index < ranked.length; index += 1) {
    const candidate = ranked[index]!;
    const obligations = [...new Set(candidate.obligation_ids)].sort();
    const mandatory = obligations.some((id) => obligationMap.get(id)?.confidence === "PROVEN_REQUIRED");
    if (!mandatory && !optionalBudgetApplied) {
      remaining = Math.min(remaining, Math.max(0, input.optionalTokenBudget - projectedTokens));
      optionalBudgetApplied = true;
    }
    const estimated = candidate.estimated_tokens ?? input.unknownCandidateTokens;
    const identity = candidateIdentity(candidate, input.hmacKey);
    let disposition = validityDisposition(candidate, obligationMap);
    let reasonCode = disposition === "OMIT_UNAUTHORIZED" ? "SCOPE_NOT_AUTHORIZED"
      : disposition === "HISTORICAL_ONLY" ? "SEMANTIC_NOT_CURRENT"
        : disposition === "REREAD_REQUIRED" ? "CURRENT_EXACT_SOURCE_REQUIRED" : "";
    let retainedEntryId: string | null = null;
    let projected = 0;
    if (disposition === null && identities.has(identity)) {
      disposition = "OMIT_CLOSED";
      reasonCode = "DUPLICATE_ROLE_TRUST_REPRESENTATION_IDENTITY";
    }
    if (disposition === null) {
      identities.add(identity);
      const retainedBinding = retained.get(candidate.candidate_id);
      if (retainedBinding?.contentIdentityHmac === identity) {
        disposition = "ALREADY_RETAINED";
        retainedEntryId = retainedBinding.retainedEntryId;
        reasonCode = "ACTUAL_RETAINED_IDENTITY_MATCH";
      } else if (estimated <= remaining) {
        disposition = mandatory ? "MANDATORY_INLINE"
          : candidate.representation_fidelity === "TYPED_EXTRACT" ? "INLINE_TYPED_EXTRACT" : "INLINE_EXACT";
        reasonCode = mandatory ? "MANDATORY_PRIORITY" : "OPTIONAL_WITHIN_BUDGET";
        remaining -= estimated;
        projected = estimated;
        projectedTokens += estimated;
      } else if (candidate.artifact_locator !== null) {
        disposition = "ON_DEMAND";
        reasonCode = mandatory ? "MANDATORY_COMPLETE_ON_DEMAND" : "OPTIONAL_COMPLETE_ON_DEMAND";
        onDemandCandidateIds.push(candidate.candidate_id);
        if (!mandatory) omittedOptionalCount += 1;
      } else {
        disposition = "OMIT_BUDGET_OPTIONAL";
        reasonCode = "OPTIONAL_BUDGET_EXHAUSTED";
        omittedOptionalCount += 1;
      }
    }
    items.push({
      candidate_id: candidate.candidate_id, obligation_ids: obligations,
      evidence_sha256: candidate.evidence_sha256, disposition, reason_code: reasonCode,
      ordinal_class: candidate.source_kind === "AUTHORITY" ? "CONTROL" : candidate.source_kind === "OUTPUT_DIRECTIVE" ? "DIRECTIVE" : "EVIDENCE",
      content_identity_hmac: identity, retained_entry_id: retainedEntryId,
      source_version_handle_hmac: ["INLINE_EXACT", "INLINE_TYPED_EXTRACT"].includes(disposition)
        || ["HASH_CURRENT", "CHANGE_WITNESS_CURRENT"].includes(candidate.content_freshness)
        ? candidate.dependency_signature_sha256 : null,
      projected_tokens: projected,
    });
  }
  return { items, projectedTokens, onDemandCandidateIds, omittedOptionalCount };
}
