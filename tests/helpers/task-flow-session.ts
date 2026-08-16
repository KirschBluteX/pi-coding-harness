import type { TaskFlowSession } from "../../src/runtime/task-flow-session.js";

export function approvePendingTaskFlowContract(session: TaskFlowSession): void {
  const review = session.contractReview();
  if (!review) throw new TypeError("Test fixture expected a pending Goal Contract review");
  session.resolveContractReview({
    expectedDecisionRequirementRevisionId: review.decisionRequirementRevisionId,
    expectedRequirementRevisionSha256: review.requirementRevisionSha256,
    expectedDecisionFrontierSha256: review.decisionFrontierSha256,
    action: "APPROVE",
    selectedValue: true,
    turnId: `TEST-CONTRACT-REVIEW-${review.decisionRequirementRevisionId}`,
  });
  if (session.current()?.nextAction !== "SUBMIT_ROUTE") {
    throw new TypeError("Contract approval did not reach SUBMIT_ROUTE");
  }
}
