import { canonicalJsonSha256 } from "../authority/canonical-json.js";
import type { PlanningSnapshot } from "./types.js";

export type CorrectionLevel = "L0" | "L1" | "L2" | "L3" | "L4" | "L5";
export type PlanHealthStatus = "HEALTHY" | "DEGRADED" | "INVALID" | "NEEDS_USER" | "RECONCILING";

export interface EvidenceDelta {
  readonly evidenceId: string;
  readonly securityViolation?: boolean;
  readonly authorityIntegrityFailure?: boolean;
  readonly unknownSideEffect?: boolean;
  readonly acceptanceReachable?: boolean;
  readonly refutedAssumptionIds?: readonly string[];
  readonly invalidatedDependencyIds?: readonly string[];
  readonly failureSignature?: string | null;
  readonly transientFailure?: boolean;
  readonly idempotentOperation?: boolean;
  readonly retryLimit?: number;
  readonly localRepairAvailable?: boolean;
  readonly replanAvailable?: boolean;
  readonly requiresUserDecision?: boolean;
  readonly externalBlocker?: boolean;
  readonly performanceBudgetAlive?: boolean;
  readonly mandatoryOutputPossible?: boolean;
}

export interface RouteDecision {
  readonly status: PlanHealthStatus;
  readonly level: CorrectionLevel;
  readonly action: "CONTINUE" | "RETRY" | "LOCAL_REPAIR" | "REPLAN" | "ASK_USER" | "BLOCK_OR_RECONCILE";
  readonly reasonCode: string;
  readonly triggerSha256: string;
  readonly invalidatedIds: readonly string[];
  readonly additionalModelRequests: 0;
}

export function assessPlanHealth(evidence: EvidenceDelta, snapshot: PlanningSnapshot): RouteDecision {
  const invalidatedIds = [...(evidence.refutedAssumptionIds ?? []), ...(evidence.invalidatedDependencyIds ?? [])];
  const decide = (status: PlanHealthStatus, level: CorrectionLevel, action: RouteDecision["action"], reasonCode: string): RouteDecision => ({
    status, level, action, reasonCode, invalidatedIds, triggerSha256: canonicalJsonSha256(evidence), additionalModelRequests: 0,
  });
  if (evidence.unknownSideEffect) return decide("RECONCILING", "L5", "BLOCK_OR_RECONCILE", "UNKNOWN_SIDE_EFFECT");
  if (evidence.securityViolation || evidence.authorityIntegrityFailure) return decide("INVALID", "L5", "BLOCK_OR_RECONCILE", evidence.securityViolation ? "SECURITY_VIOLATION" : "AUTHORITY_INTEGRITY");
  if (evidence.requiresUserDecision) return decide("NEEDS_USER", "L4", "ASK_USER", "MATERIAL_USER_DECISION");
  if (evidence.acceptanceReachable === false) return evidence.replanAvailable
    ? decide("INVALID", "L3", "REPLAN", "ACCEPTANCE_ROUTE_INVALID")
    : decide("INVALID", "L5", "BLOCK_OR_RECONCILE", "NO_ACCEPTANCE_ROUTE");
  if (invalidatedIds.length > 0) return decide("INVALID", "L3", "REPLAN", "ASSUMPTION_OR_DEPENDENCY_INVALIDATED");

  if (evidence.failureSignature) {
    const occurrence = snapshot.failureOccurrences[evidence.failureSignature] ?? 1;
    const limit = evidence.retryLimit ?? 3;
    if (occurrence >= limit) return evidence.replanAvailable
      ? decide("INVALID", "L3", "REPLAN", "FAILURE_SIGNATURE_LIMIT")
      : decide("INVALID", "L5", "BLOCK_OR_RECONCILE", "FAILURE_SIGNATURE_EXHAUSTED");
    if (occurrence >= 2) return evidence.localRepairAvailable
      ? decide("DEGRADED", "L2", "LOCAL_REPAIR", "REPEATED_FAILURE_LOCAL_REPAIR")
      : decide("INVALID", "L3", "REPLAN", "REPEATED_FAILURE_REPLAN");
    if (evidence.transientFailure && evidence.idempotentOperation) return decide("DEGRADED", "L1", "RETRY", "TRANSIENT_IDEMPOTENT_FAILURE");
    if (evidence.localRepairAvailable) return decide("DEGRADED", "L2", "LOCAL_REPAIR", "LOCAL_REPAIR_AVAILABLE");
    if (evidence.replanAvailable) return decide("INVALID", "L3", "REPLAN", "NONTRANSIENT_FAILURE");
  }
  if (evidence.performanceBudgetAlive === false && evidence.localRepairAvailable) return decide("DEGRADED", "L2", "LOCAL_REPAIR", "PERFORMANCE_BUDGET_REPAIR");
  if (evidence.mandatoryOutputPossible === false) return decide("INVALID", "L3", "REPLAN", "MANDATORY_OUTPUT_AT_RISK");
  if (evidence.externalBlocker) return decide("INVALID", "L5", "BLOCK_OR_RECONCILE", "EXTERNAL_BLOCKER");
  return decide("HEALTHY", "L0", "CONTINUE", "ROUTE_HEALTHY");
}
