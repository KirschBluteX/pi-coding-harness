import type { Impact } from "./types.js";

export interface ClarificationOption {
  readonly id: string;
  readonly label: string;
  readonly impact: string;
}

export type RequirementChangeKind = "BEHAVIOR" | "SCOPE" | "ACCEPTANCE" | "USER_PREFERENCE";

export interface ClarificationDecision {
  readonly id: string;
  readonly question: string;
  readonly whyItMatters: string;
  readonly changeKind: RequirementChangeKind;
  readonly materiality: Exclude<Impact, "CRITICAL">;
  readonly reversible: boolean;
  readonly privacyRelated: boolean;
  readonly options: readonly ClarificationOption[];
  readonly recommendedOptionId: string;
  readonly recommendationReason: string;
  readonly dependsOnDecisionIds: readonly string[];
}

export interface ClarificationBatch {
  readonly decisions: readonly ClarificationDecision[];
  readonly deferredDecisionIds: readonly string[];
  readonly additionalModelRequests: 0;
}

function assertDecision(decision: ClarificationDecision): void {
  if (decision.options.length < 2 || decision.options.length > 3) throw new TypeError(`${decision.id} must contain two or three mutually exclusive options`);
  const optionIds = new Set(decision.options.map((option) => option.id));
  if (optionIds.size !== decision.options.length) throw new TypeError(`${decision.id} contains duplicate option ids`);
  if (!optionIds.has(decision.recommendedOptionId)) throw new TypeError(`${decision.id} recommendation is not one of its options`);
}

export function createClarificationBatch(
  decisions: readonly ClarificationDecision[],
  resolvedDecisionIds: ReadonlySet<string> = new Set(),
  maximum = 5,
): ClarificationBatch {
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 8) throw new RangeError("Clarification batch maximum must be between 1 and 8");
  for (const decision of decisions) assertDecision(decision);
  const unresolved = decisions.filter((decision) => !resolvedDecisionIds.has(decision.id));
  const eligible = unresolved.filter((decision) => decision.dependsOnDecisionIds.every((id) => resolvedDecisionIds.has(id)));
  const selected = eligible.slice(0, maximum);
  return {
    decisions: selected,
    deferredDecisionIds: unresolved.filter((decision) => !selected.includes(decision)).map((decision) => decision.id),
    additionalModelRequests: 0,
  };
}

export function mayApplyRecommendedDefault(decision: ClarificationDecision, allowLowRiskDefaults: boolean): boolean {
  return allowLowRiskDefaults && decision.materiality === "LOW" && decision.reversible && !decision.privacyRelated;
}
