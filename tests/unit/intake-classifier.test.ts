import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/load-config.js";
import {
  classifyGoalIntake,
  inferAcceptanceFacetMinimum,
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
  it("selects BUILD_LIGHT only from explicit low-risk one-stage evidence", () => {
    const result = classifyGoalIntake("Fix the typo in README.md and verify the exact corrected text.", config());
    expect(result).toMatchObject({
      specificationRoute: "BUILD_LIGHT", requirementProfile: "TASK_SPEC", planningDepth: "LIGHT",
      additionalModelRequests: 0,
    });
    if (result.specificationRoute === "BYPASS") throw new Error("unexpected bypass");
    expect(result.classification.facts).toMatchObject({ filesKnown: true, acceptanceClear: true, lowRisk: true, expectedSteps: 1 });
  });

  it("uses TASK_SPEC and STANDARD for a bounded multi-step engineering task", () => {
    const result = classifyGoalIntake("Fix skipped hook state in hooks/src/index.js and add focused regression tests.", config());
    expect(result).toMatchObject({ specificationRoute: "TASK_SPEC", requirementProfile: "TASK_SPEC", planningDepth: "STANDARD" });
  });

  it("uses PRD and FULL for a cross-module product flow", () => {
    const result = classifyGoalIntake("Build a new multi-role dashboard across frontend UI, API service, and database schema with role permissions.", config());
    expect(result).toMatchObject({ specificationRoute: "PRD", requirementProfile: "PRD", planningDepth: "FULL" });
    if (result.specificationRoute === "BYPASS") throw new Error("unexpected bypass");
    expect(result.classification.facts).toMatchObject({ productOrUserFlow: true, crossModule: true });
  });

  it("honors user profile and planning-depth configuration without a model request", () => {
    const forcedPrd = classifyGoalIntake("Fix a bounded regression.", config({ profile: "PRD" }));
    expect(forcedPrd).toMatchObject({ specificationRoute: "PRD", requirementProfile: "PRD", planningDepth: "FULL" });
    const prdWithLightPlan = classifyGoalIntake("Build a new dashboard.", config({ profile: "PRD", depth: "LIGHT" }));
    expect(prdWithLightPlan).toMatchObject({ specificationRoute: "PRD", requirementProfile: "PRD", planningDepth: "LIGHT" });
    const boundedProduct = classifyGoalIntake("Build a new dashboard across frontend UI and API service.", config({ profile: "TASK_SPEC" }));
    expect(boundedProduct).toMatchObject({ specificationRoute: "TASK_SPEC", requirementProfile: "TASK_SPEC", planningDepth: "STANDARD" });
    const forcedFull = classifyGoalIntake("Fix the typo in README.md and verify the exact text.", config({ depth: "FULL" }));
    expect(forcedFull).toMatchObject({ specificationRoute: "TASK_SPEC", requirementProfile: "TASK_SPEC", planningDepth: "FULL" });
    const bypass = classifyGoalIntake("Implement a feature.", config({ depth: "BYPASS" }));
    expect(bypass).toEqual({
      specificationRoute: "BYPASS", requirementProfile: null, planningDepth: null,
      reasonCodes: ["USER_DEPTH_BYPASS"], source: "USER_CONFIG", additionalModelRequests: 0,
    });
  });

  it("produces a strict authority record and rejects incompatible substitutions", () => {
    const result = classifyGoalIntake("Fix the typo in README.md and verify the exact text.", config());
    if (result.specificationRoute === "BYPASS") throw new Error("unexpected bypass");
    expect(validateIntakeClassificationRecord(result.classification)).toEqual([]);
    expect(validateGoalClassificationCompatibility(result.classification, result.requirementProfile, result.planningDepth)).toEqual([]);
    expect(validateGoalClassificationCompatibility(result.classification, "PRD", "FULL")).toContain("BUILD_LIGHT requires TASK_SPEC and LIGHT planning depth");
    expect(validateIntakeClassificationRecord({ ...result.classification, additionalModelRequests: 1 })).toContain("additionalModelRequests must be zero");
  });

  it("keeps text-derived facts deterministic and does not infer low risk from length", () => {
    const short = inferIntakeFacts("Rewrite the architecture.");
    expect(short).toMatchObject({ lowRisk: false, highRework: true, expectedSteps: 3 });
    expect(inferIntakeFacts("Rewrite the architecture.")).toEqual(short);
  });

  it("classifies the exact multipart product task as PRD/FULL and preserves its three acceptance facets", () => {
    const objective = "Implement a new Node.js upload feature across multiple Axios modules: the HTTP adapter must accept standards-compliant FormData and Blob values in addition to the legacy form-data package. Target users are Node application developers using built-in or polyfilled web FormData. Measurable outcomes: spec-compliant multipart bodies preserve fields, filename, MIME type and content length; Blob bodies stream with their content type and length; the existing legacy FormData and toFormData flows still pass. Scope includes the Node HTTP adapter, bounded stream helpers, environment FormData selection, utilities, browser mapping, package metadata, and focused tests.";
    expect(classifyGoalIntake(objective, config())).toMatchObject({
      specificationRoute: "PRD", requirementProfile: "PRD", planningDepth: "FULL",
    });
    expect(inferAcceptanceFacetMinimum(objective)).toBe(3);
  });

  it("uses PRD/FULL for a cross-cutting validation change with multiple regression boundaries", () => {
    const objective = "Fix Terraform validation so import blocks participate in configuration validation instead of being deferred until a later planning path. Users running terraform validate must receive existing-style diagnostics for undefined locals, variables and resource targets referenced by import blocks, and invalid self-references must be rejected across unkeyed resources, keyed instances and module-scoped imports. Preserve valid import planning, generated-config behavior, deferred planning behavior and unrelated graph construction.";
    const result = classifyGoalIntake(objective, config());
    expect(result).toMatchObject({ specificationRoute: "PRD", requirementProfile: "PRD", planningDepth: "FULL" });
    if (result.specificationRoute === "BYPASS") throw new Error("unexpected bypass");
    expect(result.classification.facts).toMatchObject({ crossModule: true, highRework: true, expectedSteps: 3 });
  });

  it("does not promote a bounded validation fix from one preservation clause", () => {
    const objective = "Fix import validation in internal/terraform/context_plan.go, preserve the existing error text, and run the focused regression test.";
    expect(classifyGoalIntake(objective, config())).toMatchObject({
      specificationRoute: "TASK_SPEC", requirementProfile: "TASK_SPEC", planningDepth: "STANDARD",
    });
  });

  it("counts independent MUST clauses without adding a critic request", () => {
    const objective = "If one cleanup throws, every remaining cleanup must still run, the error must reach the existing error-boundary path, and the throwing cleanup must not be invoked again.";
    expect(inferAcceptanceFacetMinimum(objective)).toBe(3);
  });

  it("applies the same safety signals to Chinese task objectives", () => {
    expect(classifyGoalIntake("修复 docs/guide.md 的一个拼写错误，并验收精确结果。", config())).toMatchObject({
      specificationRoute: "BUILD_LIGHT", requirementProfile: "TASK_SPEC", planningDepth: "LIGHT",
    });
    expect(classifyGoalIntake("重新设计支付工作流，涉及界面、接口、数据库迁移、隐私和权限模型。", config())).toMatchObject({
      specificationRoute: "PRD", requirementProfile: "PRD", planningDepth: "FULL",
    });
  });
});
