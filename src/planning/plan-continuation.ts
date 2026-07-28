export const PLAN_CONTINUE_BUILD = "PLAN_CONTINUE_BUILD";
export const PLAN_CONTINUE_KEEP = "PLAN_CONTINUE_KEEP";
export const PLAN_CONTINUE_REVISE = "PLAN_CONTINUE_REVISE";

export type PlanContinuationSelection =
  | typeof PLAN_CONTINUE_BUILD
  | typeof PLAN_CONTINUE_KEEP
  | typeof PLAN_CONTINUE_REVISE;

export interface PlanContinuationRequest {
  readonly goalId: string;
  readonly question: string;
  readonly options: readonly {
    readonly id: PlanContinuationSelection;
    readonly label: string;
    readonly description: string;
    readonly bindingSha256: string;
  }[];
  readonly recommendedOptionId: PlanContinuationSelection;
  readonly recommendationReason: string;
  readonly materiality: "MEDIUM";
  readonly reversible: true;
  readonly defaultOptionId: null;
}

export interface PlanContinuationReceiptLike {
  readonly receiptType: string;
  readonly subjectId: string;
  readonly outputSha256: string | null;
  readonly body: unknown;
  readonly issuedEventSequence: number;
}

export interface PlanContinuationResolution {
  readonly decisionId: string;
  readonly selection: PlanContinuationSelection;
  readonly resolutionSha256: string;
  readonly issuedEventSequence: number;
}

export function planContinuationRequest(
  goalId: string,
  planId: string,
  planPayloadSha256: string,
): PlanContinuationRequest {
  const bindingSha256 = planPayloadSha256;
  return {
    goalId,
    question: `Plan ${planId} passed finalization and BuildEntryGate. What should PCH do next?`,
    options: [
      {
        id: PLAN_CONTINUE_BUILD,
        label: "Enter BUILD now",
        description: "Authorize the first Stage and implement this final Plan in the current Goal.",
        bindingSha256,
      },
      {
        id: PLAN_CONTINUE_KEEP,
        label: "Keep the plan only",
        description: "Finish with the frozen PRD and final Plan without modifying the target project.",
        bindingSha256,
      },
      {
        id: PLAN_CONTINUE_REVISE,
        label: "Revise the plan",
        description: "Invalidate this technical route and create a new PlanRevision before implementation.",
        bindingSha256,
      },
    ],
    recommendedOptionId: PLAN_CONTINUE_BUILD,
    recommendationReason: "The requirement and final Plan are already frozen, so continuing in this Goal avoids duplicate planning while retaining every BuildEntryGate.",
    materiality: "MEDIUM",
    reversible: true,
    defaultOptionId: null,
  };
}

function selection(value: unknown): PlanContinuationSelection | null {
  return value === PLAN_CONTINUE_BUILD || value === PLAN_CONTINUE_KEEP || value === PLAN_CONTINUE_REVISE
    ? value
    : null;
}

export function latestPlanContinuationResolution(
  receipts: readonly PlanContinuationReceiptLike[],
  planCreatedEventSequence: number,
): PlanContinuationResolution | null {
  for (const receipt of [...receipts].reverse()) {
    if (receipt.receiptType !== "DECISION" || receipt.issuedEventSequence <= planCreatedEventSequence
      || typeof receipt.body !== "object" || receipt.body === null || Array.isArray(receipt.body)) continue;
    const selected = selection((receipt.body as Record<string, unknown>).selectedOptionId);
    if (!selected || !receipt.outputSha256) continue;
    return {
      decisionId: receipt.subjectId,
      selection: selected,
      resolutionSha256: receipt.outputSha256,
      issuedEventSequence: receipt.issuedEventSequence,
    };
  }
  return null;
}

export function effectivePlanContinuationResolution(
  receipts: readonly PlanContinuationReceiptLike[],
  planCreatedEventSequence: number,
): PlanContinuationResolution | null {
  const currentPlanDecision = latestPlanContinuationResolution(receipts, planCreatedEventSequence);
  if (currentPlanDecision) return currentPlanDecision;
  const priorDecision = latestPlanContinuationResolution(receipts, 0);
  return priorDecision?.selection === PLAN_CONTINUE_BUILD ? priorDecision : null;
}
