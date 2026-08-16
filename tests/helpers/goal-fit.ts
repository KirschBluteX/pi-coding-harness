import type { GoalFitAssessmentProposalV2 } from "../../src/intake-v2/domain.js";

export function passingGoalFitAssessment(): GoalFitAssessmentProposalV2 {
  const pass = {
    status: "PASS" as const,
    reason_codes: ["CURRENT_CLOSURE_PASSED"],
    coverage: "ALL_CURRENT" as const,
  };
  return {
    proposal_origin: "CURRENT_AGENT_TYPED_PROPOSAL",
    outcome_fidelity: pass,
    obligation_coverage: pass,
    unnecessary_design: pass,
    current_decisions: pass,
    invalidations: {
      status: "NOT_APPLICABLE",
      reason_codes: ["NO_ACTIVE_INVALIDATIONS"],
      coverage: "NOT_APPLICABLE",
    },
    gate_specific_evidence: pass,
  };
}

export function passingMaterialChangeGoalFitAssessment(): GoalFitAssessmentProposalV2 {
  return {
    ...passingGoalFitAssessment(),
    invalidations: {
      status: "PASS",
      reason_codes: ["CURRENT_INVALIDATION_CLOSURE_PASSED"],
      coverage: "ALL_CURRENT",
    },
  };
}
