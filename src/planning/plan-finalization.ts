import type { ValidationResult } from "../foundation/validation.js";
import type { PlanPackage, RequirementPackage } from "./types.js";

export const PLAN_FINALIZATION_REVIEW_AREAS = [
  "REQUIREMENT_AND_ACCEPTANCE",
  "ASSUMPTIONS_AND_EVIDENCE",
  "STAGE_BOUNDARIES_AND_DEPENDENCIES",
  "FILE_INTERFACE_MIGRATION_SCOPE",
  "FAILURE_RECOVERY_AND_REVERSIBILITY",
  "TESTS_REVIEW_GATES_AND_EXIT_EVIDENCE",
  "PERFORMANCE_WAIT_TOKEN_AND_INTERRUPTION_COST",
  "REDUNDANCY_AND_USER_EXPERIENCE",
] as const;

export const PLAN_FINALIZATION_DETERMINISTIC_CHECKS = [
  "SCHEMA_HASH_AND_REQUIREMENT_BINDING",
  "DAG_AND_SINGLE_STAGE_OWNERSHIP",
  "ACCEPTANCE_COVERAGE",
  "STAGE_EXECUTABILITY_AND_FILE_SCOPE",
  "PERFORMANCE_CONTRACT_BINDING",
  "RISK_OWNER",
  "LEXICOGRAPHIC_ROUTE_SELECTION",
] as const;

export interface PlanFinalizationReport {
  readonly schemaVersion: 1;
  readonly mode: "SAME_NORMAL_TURN_PLUS_LOCAL_GATE";
  readonly planId: string;
  readonly planPayloadSha256: string;
  readonly requirementId: string;
  readonly requirementPayloadSha256: string;
  readonly planningDepth: "LIGHT" | "STANDARD" | "FULL";
  readonly reviewPasses: 1;
  readonly reviewRequestedAreas: typeof PLAN_FINALIZATION_REVIEW_AREAS;
  readonly deterministicChecks: typeof PLAN_FINALIZATION_DETERMINISTIC_CHECKS;
  readonly stageCount: number;
  readonly acceptanceCount: number;
  readonly routeCandidateCount: number;
  readonly issueCodes: readonly string[];
  readonly valid: boolean;
  readonly additionalModelRequests: 0;
}

export function createPlanFinalizationReport(
  plan: PlanPackage,
  requirement: RequirementPackage,
  validation: ValidationResult,
): PlanFinalizationReport {
  return {
    schemaVersion: 1,
    mode: "SAME_NORMAL_TURN_PLUS_LOCAL_GATE",
    planId: plan.package.plan_id,
    planPayloadSha256: plan.integrity.plan_payload_sha256,
    requirementId: requirement.package.requirement_id,
    requirementPayloadSha256: requirement.integrity.requirements_payload_sha256,
    planningDepth: plan.plan.planning_depth,
    reviewPasses: 1,
    reviewRequestedAreas: PLAN_FINALIZATION_REVIEW_AREAS,
    deterministicChecks: PLAN_FINALIZATION_DETERMINISTIC_CHECKS,
    stageCount: plan.plan.stages.length,
    acceptanceCount: requirement.requirements.acceptance_criteria.filter((entry) => entry.required).length,
    routeCandidateCount: plan.plan.route_selection.candidates.length,
    issueCodes: validation.issues.map((entry) => entry.code),
    valid: validation.valid,
    additionalModelRequests: 0,
  };
}

export function validatePlanFinalizationReport(report: PlanFinalizationReport, plan: PlanPackage): void {
  const exactArray = (left: readonly string[], right: readonly string[]): boolean =>
    left.length === right.length && left.every((entry, index) => entry === right[index]);
  if (report.schemaVersion !== 1 || report.mode !== "SAME_NORMAL_TURN_PLUS_LOCAL_GATE"
    || report.reviewPasses !== 1 || report.additionalModelRequests !== 0 || !report.valid
    || report.issueCodes.length !== 0) {
    throw new TypeError("Plan finalization report is not a successful zero-request finalization");
  }
  if (report.planId !== plan.package.plan_id || report.planPayloadSha256 !== plan.integrity.plan_payload_sha256
    || report.requirementId !== plan.package.requirement_id
    || report.requirementPayloadSha256 !== plan.package.requirement_payload_sha256
    || report.planningDepth !== plan.plan.planning_depth) {
    throw new TypeError("Plan finalization report does not bind the submitted Plan and Requirement");
  }
  if (!exactArray(report.reviewRequestedAreas, PLAN_FINALIZATION_REVIEW_AREAS)
    || !exactArray(report.deterministicChecks, PLAN_FINALIZATION_DETERMINISTIC_CHECKS)
    || report.stageCount !== plan.plan.stages.length
    || report.acceptanceCount !== new Set(plan.plan.acceptance_coverage.map((entry) => entry.criterion_id)).size
    || report.routeCandidateCount !== plan.plan.route_selection.candidates.length) {
    throw new TypeError("Plan finalization report coverage or counts are incomplete");
  }
}
