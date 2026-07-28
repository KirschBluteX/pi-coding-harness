import { describe, expect, it } from "vitest";
import { createClarificationBatch, mayApplyRecommendedDefault, type ClarificationDecision } from "../../src/planning/clarification.js";

const lowDecision: ClarificationDecision = {
  id: "DEC-LOW", question: "Choose a reversible label", whyItMatters: "Changes display only", materiality: "LOW",
  changeKind: "USER_PREFERENCE",
  reversible: true, privacyRelated: false, options: [{ id: "A", label: "A", impact: "Short" }, { id: "B", label: "B", impact: "Long" }],
  recommendedOptionId: "A", recommendationReason: "Matches existing style", dependsOnDecisionIds: [],
};

describe("clarification batches", () => {
  it("batches only dependency-ready material questions within the hard bound", () => {
    const dependent = { ...lowDecision, id: "DEC-DEPENDENT", dependsOnDecisionIds: ["DEC-LOW"] };
    const batch = createClarificationBatch([lowDecision, dependent], new Set(), 5);
    expect(batch.decisions.map((decision) => decision.id)).toEqual(["DEC-LOW"]);
    expect(batch.deferredDecisionIds).toEqual(["DEC-DEPENDENT"]);
  });

  it("applies defaults only to low-risk reversible non-privacy decisions", () => {
    expect(mayApplyRecommendedDefault(lowDecision, true)).toBe(true);
    expect(mayApplyRecommendedDefault({ ...lowDecision, privacyRelated: true }, true)).toBe(false);
    expect(mayApplyRecommendedDefault({ ...lowDecision, materiality: "HIGH" }, true)).toBe(false);
  });
});
