import type {
  ContentFreshness, EvidenceValidityTransitionRecord, ProjectKnowledgeClaimRecord,
  ReadEvidenceReceiptRecord, RepresentationFidelity, ScopeAuthorization, SemanticApplicability,
} from "./domain.js";

export interface EffectiveEvidenceValidity {
  readonly contentFreshness: ContentFreshness;
  readonly scopeAuthorization: ScopeAuthorization;
  readonly semanticApplicability: SemanticApplicability;
  readonly representationFidelity: RepresentationFidelity;
}

export interface EvidenceEligibility {
  readonly eligible: boolean;
  readonly disposition: "CURRENT_EXACT" | "REREAD_REQUIRED" | "UNAUTHORIZED" | "HISTORICAL_ONLY" | "OPAQUE";
  readonly reasonCode: string;
  readonly validity: EffectiveEvidenceValidity;
}

export type UncertaintyKind = "MISSING" | "CONFLICT" | "STALE" | "UNAUTHORIZED" | "OPAQUE";
export interface UncertaintyItem {
  readonly semanticKey: string;
  readonly kind: UncertaintyKind;
  readonly claimIds: readonly string[];
}
export interface UncertaintyView {
  readonly items: readonly UncertaintyItem[];
  readonly complete: boolean;
}

export function effectiveEvidenceValidity(
  receipt: ReadEvidenceReceiptRecord,
  transitions: readonly EvidenceValidityTransitionRecord[],
): EffectiveEvidenceValidity {
  const result: {
    contentFreshness: ContentFreshness;
    scopeAuthorization: ScopeAuthorization;
    semanticApplicability: SemanticApplicability;
    representationFidelity: RepresentationFidelity;
  } = {
    contentFreshness: receipt.content_freshness,
    scopeAuthorization: receipt.scope_authorization,
    semanticApplicability: receipt.semantic_applicability,
    representationFidelity: receipt.representation_fidelity,
  };
  const ordered = [...transitions].sort((left, right) =>
    left.created_at_ms - right.created_at_ms || left.transition_id.localeCompare(right.transition_id));
  for (const transition of ordered) {
    if (transition.receipt_id !== receipt.receipt_id) throw new TypeError("Evidence validity transition parent substitution");
    if (transition.axis === "CONTENT_FRESHNESS") result.contentFreshness = transition.value as ContentFreshness;
    else if (transition.axis === "SCOPE_AUTHORIZATION") result.scopeAuthorization = transition.value as ScopeAuthorization;
    else if (transition.axis === "SEMANTIC_APPLICABILITY") result.semanticApplicability = transition.value as SemanticApplicability;
    else result.representationFidelity = transition.value as RepresentationFidelity;
  }
  return result;
}

export function evaluateEvidence(
  receipt: ReadEvidenceReceiptRecord,
  transitions: readonly EvidenceValidityTransitionRecord[] = [],
): EvidenceEligibility {
  const validity = effectiveEvidenceValidity(receipt, transitions);
  if (validity.scopeAuthorization !== "AUTHORIZED") {
    return { eligible: false, disposition: "UNAUTHORIZED", reasonCode: `SCOPE_${validity.scopeAuthorization}`, validity };
  }
  if (!["CURRENT", "NOT_APPLICABLE"].includes(validity.semanticApplicability)) {
    return { eligible: false, disposition: "HISTORICAL_ONLY", reasonCode: `SEMANTIC_${validity.semanticApplicability}`, validity };
  }
  if (!["EXACT_RAW", "EXACT_DECODED", "TYPED_EXTRACT"].includes(validity.representationFidelity)) {
    return { eligible: false, disposition: "OPAQUE", reasonCode: `REPRESENTATION_${validity.representationFidelity}`, validity };
  }
  if (!["HASH_CURRENT", "CHANGE_WITNESS_CURRENT", "NOT_APPLICABLE"].includes(validity.contentFreshness)) {
    return { eligible: false, disposition: "REREAD_REQUIRED", reasonCode: `CONTENT_${validity.contentFreshness}`, validity };
  }
  return { eligible: true, disposition: "CURRENT_EXACT", reasonCode: "CURRENT_EXACT", validity };
}

function claimUncertainty(claims: readonly ProjectKnowledgeClaimRecord[]): UncertaintyKind | null {
  if (claims.some((claim) => claim.scope_authorization !== "AUTHORIZED")) return "UNAUTHORIZED";
  if (claims.some((claim) => !["HASH_CURRENT", "CHANGE_WITNESS_CURRENT"].includes(claim.content_freshness)
    || !["CURRENT", "NOT_APPLICABLE"].includes(claim.semantic_applicability))) return "STALE";
  if (claims.some((claim) => !["EXACT_RAW", "EXACT_DECODED", "TYPED_EXTRACT"].includes(claim.representation_fidelity))) return "OPAQUE";
  if (new Set(claims.map((claim) => claim.statement_sha256)).size > 1) return "CONFLICT";
  return null;
}

export function deriveUncertaintyView(
  requiredSemanticKeys: readonly string[],
  claims: readonly ProjectKnowledgeClaimRecord[],
): UncertaintyView {
  const keys = new Set(requiredSemanticKeys);
  for (const claim of claims) keys.add(claim.semantic_key);
  const items: UncertaintyItem[] = [];
  for (const semanticKey of [...keys].sort()) {
    const matching = claims.filter((claim) => claim.semantic_key === semanticKey);
    if (matching.length === 0) {
      items.push({ semanticKey, kind: "MISSING", claimIds: [] });
      continue;
    }
    const kind = claimUncertainty(matching);
    if (kind) items.push({ semanticKey, kind, claimIds: matching.map((claim) => claim.claim_id).sort() });
  }
  return { items, complete: items.length === 0 };
}
