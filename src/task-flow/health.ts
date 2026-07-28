import { canonicalJsonSha256 } from "../authority/canonical-json.js";
import type { RouteHealthLevel } from "./domain.js";

export interface RouteHealthInput {
  readonly activeObligationCount: number;
  readonly currentRecordCount: number;
  readonly unknownEffect: boolean;
  readonly authorityIntegrityFailure: boolean;
  readonly materialDecisionOpen: boolean;
  readonly assumptionInvalidated: boolean;
  readonly acceptanceUnreachable: boolean;
  readonly failureSignatureSha256: string | null;
  readonly failureOccurrence: number;
  readonly retryLimit: number;
  readonly transientFailure: boolean;
  readonly localRepairAvailable: boolean;
  readonly routeAlternativeAvailable: boolean;
  readonly progressObserved: boolean;
}

export interface DeterministicRouteDecision {
  readonly level: RouteHealthLevel;
  readonly reasonCode: string;
  readonly invalidateAuthorization: boolean;
  readonly askUser: boolean;
  readonly retryAllowed: boolean;
  readonly triggerSha256: string;
  readonly additionalModelRequests: 0;
}

export function assessRouteHealth(input: RouteHealthInput): DeterministicRouteDecision {
  if (!Number.isInteger(input.activeObligationCount) || input.activeObligationCount < 0 || input.activeObligationCount > 256) {
    throw new TypeError("RouteHealth activeObligationCount must be an integer in 0..256");
  }
  if (!Number.isInteger(input.currentRecordCount) || input.currentRecordCount < 0 || input.currentRecordCount > 10_000) {
    throw new TypeError("RouteHealth currentRecordCount must be an integer in 0..10000");
  }
  const triggerSha256 = canonicalJsonSha256(input);
  const value = (level: RouteHealthLevel, reasonCode: string, invalidateAuthorization: boolean, askUser: boolean, retryAllowed: boolean): DeterministicRouteDecision => ({
    level, reasonCode, invalidateAuthorization, askUser, retryAllowed, triggerSha256, additionalModelRequests: 0,
  });
  if (input.authorityIntegrityFailure) return value("H5_RECONCILE_OR_STOP", "AUTHORITY_INTEGRITY_FAILURE", true, false, false);
  if (input.unknownEffect) return value("H5_RECONCILE_OR_STOP", "UNKNOWN_EFFECT_REQUIRES_RECONCILIATION", true, false, false);
  if (input.materialDecisionOpen) return value("H4_ASK", "MATERIAL_USER_AUTHORITY_REQUIRED", true, true, false);
  if (input.assumptionInvalidated || input.acceptanceUnreachable) return value("H3_REFRAME", input.acceptanceUnreachable ? "ACCEPTANCE_ROUTE_UNREACHABLE" : "ASSUMPTION_INVALIDATED", true, false, false);
  if (input.failureSignatureSha256 !== null && input.failureOccurrence >= Math.max(1, input.retryLimit)) {
    return input.routeAlternativeAvailable
      ? value("H3_REFRAME", "FAILURE_SIGNATURE_LIMIT", true, false, false)
      : value("H5_RECONCILE_OR_STOP", "FAILURE_SIGNATURE_EXHAUSTED", true, false, false);
  }
  if (input.localRepairAvailable && input.failureOccurrence > 0) return value("H2_REPAIR", "LOCAL_REPAIR_AVAILABLE", false, false, false);
  if (input.transientFailure && input.failureOccurrence > 0) return value("H1_RETRY", "BOUNDED_TRANSIENT_RETRY", false, false, true);
  return value("H0_CONTINUE", input.progressObserved ? "PROGRESS_OBSERVED" : "ROUTE_STILL_VALID", false, false, false);
}
