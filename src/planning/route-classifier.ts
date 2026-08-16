import type { IntakeFacts, SpecificationClassification } from "./types.js";

export function classifySpecificationRoute(facts: IntakeFacts): SpecificationClassification {
  if (!facts.requiresPersistentWork) {
    return { route: "BYPASS", reasonCodes: ["NO_PERSISTENT_WORK"], additionalModelRequests: 0 };
  }

  const productSignals = [facts.productOrUserFlow, facts.crossModule, facts.highRework].filter(Boolean).length;
  if (facts.highImpactUnknowns > 0 || productSignals >= 2 || facts.irreversibleOrSensitive) {
    const reasons = [
      ...(facts.highImpactUnknowns > 0 ? ["HIGH_IMPACT_UNKNOWN"] : []),
      ...(productSignals >= 2 ? ["PRODUCT_COMPLEXITY"] : []),
      ...(facts.irreversibleOrSensitive ? ["IRREVERSIBLE_OR_SENSITIVE"] : []),
    ];
    return { route: "PRD", reasonCodes: reasons, additionalModelRequests: 0 };
  }

  if (facts.semanticAssessment === "UNRESOLVED" && facts.structuralComplexity >= 3) {
    return {
      route: "PRD",
      reasonCodes: ["STRUCTURAL_COMPLEXITY_REQUIRES_REVIEW"],
      additionalModelRequests: 0,
    };
  }

  if (facts.objectiveClear && facts.filesKnown && facts.acceptanceClear && facts.lowRisk && facts.expectedSteps <= 1) {
    return { route: "BUILD_LIGHT", reasonCodes: ["CLEAR_LOW_RISK_SINGLE_STAGE"], additionalModelRequests: 0 };
  }

  return {
    route: "TASK_SPEC",
    reasonCodes: [facts.expectedSteps > 1 ? "MULTI_STEP" : "BOUNDED_AMBIGUITY"],
    additionalModelRequests: 0,
  };
}
