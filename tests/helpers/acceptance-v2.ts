import type {
  GoalContractAuthorityProposalV2,
  GoalContractProposal,
} from "../../src/task-flow/finalize.js";
import { passingGoalFitAssessment } from "./goal-fit.js";

// Test-only authority fixture for suites whose subject is not Acceptance semantics.
export function withAcceptanceV2(proposal: GoalContractProposal): GoalContractAuthorityProposalV2 {
  const mustKeys = proposal.obligations.filter((obligation) => obligation.priority === "MUST")
    .map((obligation) => obligation.key);
  if (mustKeys.length === 0 || proposal.user_outcomes.length === 0) {
    throw new TypeError("Acceptance V2 fixture requires an outcome and a MUST obligation");
  }
  const outcomeFacets = proposal.user_outcomes.map((_, index) => ({
    key: `fixture-outcome-${index + 1}`,
    kind: "OUTCOME" as const,
    subject: { kind: "USER_OUTCOME" as const, index },
    source_binding: "ENTIRE_INTAKE" as const,
    obligation_keys: index === 0 ? mustKeys : [mustKeys[Math.min(index, mustKeys.length - 1)]!],
  }));
  const boundedFacets = [
    ...(proposal.constraints ?? []).map((_, index) => ({
      key: `fixture-constraint-${index + 1}`,
      kind: "CONSTRAINT" as const,
      subject: { kind: "CONSTRAINT" as const, index },
      source_binding: "ENTIRE_INTAKE" as const,
      obligation_keys: [mustKeys[0]!],
    })),
    ...(proposal.non_goals ?? []).map((_, index) => ({
      key: `fixture-non-goal-${index + 1}`,
      kind: "NON_GOAL" as const,
      subject: { kind: "NON_GOAL" as const, index },
      source_binding: "ENTIRE_INTAKE" as const,
      obligation_keys: [mustKeys[0]!],
    })),
  ];
  return {
    ...proposal,
    acceptance_facets: [...outcomeFacets, ...boundedFacets],
    goal_fit_assessment: passingGoalFitAssessment(),
  };
}
