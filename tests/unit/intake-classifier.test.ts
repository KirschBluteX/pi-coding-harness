import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/load-config.js";
import {
  classifyGoalIntake,
  inferIntakeFacts,
  validateGoalClassificationCompatibility,
  validateIntakeClassificationRecord,
} from "../../src/planning/intake-classifier.js";
import type { CodingHarnessConfig } from "../../src/config/types.js";

function config(patch: {
  readonly profile?: CodingHarnessConfig["requirements"]["profile"];
  readonly depth?: CodingHarnessConfig["execution"]["planning_depth"];
} = {}): CodingHarnessConfig {
  const value = structuredClone(loadConfig("config/default.json"));
  return {
    ...value,
    requirements: { ...value.requirements, ...(patch.profile ? { profile: patch.profile } : {}) },
    execution: { ...value.execution, ...(patch.depth ? { planning_depth: patch.depth } : {}) },
  };
}

describe("runtime intake classifier", () => {
  it("keeps semantic authority unresolved instead of claiming confidence from keywords", () => {
    const result = classifyGoalIntake("Rewrite the architecture.", config());
    expect(result).toMatchObject({
      specificationRoute: "TASK_SPEC",
      requirementProfile: "TASK_SPEC",
      planningDepth: "STANDARD",
      classification: {
        source: "AUTO_STRUCTURAL",
        confidence: "MEDIUM",
        facts: { semanticAssessment: "UNRESOLVED", highRework: false, lowRisk: false },
      },
    });
  });

  it("does not grant BUILD_LIGHT from a short low-risk-looking phrase", () => {
    expect(classifyGoalIntake("Fix the typo in README.md and verify it.", config())).toMatchObject({
      specificationRoute: "TASK_SPEC",
      requirementProfile: "TASK_SPEC",
      planningDepth: "STANDARD",
    });
    expect(classifyGoalIntake(
      "Fix the typo in README.md and verify it.",
      config({ profile: "TASK_SPEC", depth: "LIGHT" }),
    )).toMatchObject({
      specificationRoute: "BUILD_LIGHT",
      requirementProfile: "TASK_SPEC",
      planningDepth: "LIGHT",
    });
  });

  it("routes a structurally large specification to PRD without interpreting its vocabulary", () => {
    const objective = [
      "Objective: deliver the requested behavior with a reviewable contract.",
      "Scope:",
      "- update packages/a/src/input.ts",
      "- update packages/b/src/output.ts",
      "- preserve packages/c/src/compat.ts",
      "Acceptance:",
      "1. normal flow has deterministic evidence",
      "2. failure flow has deterministic evidence",
      "3. recovery has deterministic evidence",
      "4. unrelated behavior remains covered",
      "Constraints: changes must remain reversible and bounded while the user reviews the contract.",
    ].join("\n").repeat(5);
    const result = classifyGoalIntake(objective, config());
    expect(result).toMatchObject({
      specificationRoute: "PRD",
      requirementProfile: "PRD",
      planningDepth: "FULL",
      classification: { facts: { structuralComplexity: 4, semanticAssessment: "UNRESOLVED" } },
    });
  });

  it("is metamorphic under vocabulary replacement when structural evidence is unchanged", () => {
    const left = "Rewrite architecture in src/a.ts; preserve behavior in src/b.ts; verify output.";
    const right = "Paint scenery in src/a.ts; collect numbers in src/b.ts; record output.";
    expect(inferIntakeFacts(left)).toEqual(inferIntakeFacts(right));
    expect(classifyGoalIntake(left, config()).specificationRoute)
      .toBe(classifyGoalIntake(right, config()).specificationRoute);
  });

  it("uses the same structural evidence for Chinese and English objectives", () => {
    const chinese = "修改 src/a.ts；保持 src/b.ts；验证结果。";
    const english = "Modify src/a.ts; preserve src/b.ts; verify the result.";
    expect(inferIntakeFacts(chinese)).toEqual(inferIntakeFacts(english));
  });

  it("honors explicit user profile and planning-depth configuration without another request", () => {
    expect(classifyGoalIntake("A bounded change.", config({ profile: "PRD" }))).toMatchObject({
      specificationRoute: "PRD", requirementProfile: "PRD", planningDepth: "FULL",
    });
    expect(classifyGoalIntake("A bounded change.", config({ profile: "TASK_SPEC", depth: "LIGHT" })))
      .toMatchObject({ specificationRoute: "BUILD_LIGHT", requirementProfile: "TASK_SPEC", planningDepth: "LIGHT" });
    expect(classifyGoalIntake("A bounded change.", config({ depth: "BYPASS" }))).toEqual({
      specificationRoute: "BYPASS",
      requirementProfile: null,
      planningDepth: null,
      reasonCodes: ["USER_DEPTH_BYPASS"],
      source: "USER_CONFIG",
      additionalModelRequests: 0,
    });
  });

  it("produces a strict authority record and rejects incompatible substitutions", () => {
    const result = classifyGoalIntake("Modify src/a.ts and verify the result.", config());
    if (result.specificationRoute === "BYPASS") throw new Error("unexpected bypass");
    expect(validateIntakeClassificationRecord(result.classification)).toEqual([]);
    expect(validateGoalClassificationCompatibility(
      result.classification, result.requirementProfile, result.planningDepth,
    )).toEqual([]);
    expect(validateIntakeClassificationRecord({
      ...result.classification,
      facts: { ...result.classification.facts, semanticAssessment: "KEYWORD_GUESS" },
    })).toContain("facts.semanticAssessment is invalid");
  });
});
