import { describe, expect, it } from "vitest";
import { allocateContextBudget } from "../../src/input-context/budget.js";

describe("allocateContextBudget", () => {
  it("derives pressure from usable headroom including the output reserve", () => {
    const budget = (currentInputTokens: number) => allocateContextBudget({
      contextWindowTokens: 10_000,
      currentInputTokens,
      outputReserveTokens: 1_000,
      softEvidenceTokens: 500,
      hardEvidenceTokens: 2_000,
    });

    expect(budget(0)).toMatchObject({ evidenceTokens: 2_000, pressure: "LOW" });
    expect(budget(6_000).pressure).toBe("MEDIUM");
    expect(budget(8_000).pressure).toBe("HIGH");
    expect(budget(9_000)).toMatchObject({ evidenceTokens: 0, pressure: "HIGH" });
  });

  it("never reports LOW when the output reserve consumes all headroom", () => {
    expect(allocateContextBudget({
      contextWindowTokens: 1_000,
      currentInputTokens: 0,
      outputReserveTokens: 1_000,
      softEvidenceTokens: 100,
      hardEvidenceTokens: 200,
    })).toMatchObject({ evidenceTokens: 0, pressure: "HIGH" });
  });
});
