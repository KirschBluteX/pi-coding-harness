import { describe, expect, it } from "vitest";
import { classifySpecificationRoute } from "../../src/planning/route-classifier.js";
import type { IntakeFacts, SpecificationRoute } from "../../src/planning/types.js";

const base: IntakeFacts = {
  requiresPersistentWork: true, objectiveClear: true, filesKnown: true, acceptanceClear: true,
  lowRisk: true, expectedSteps: 1, productOrUserFlow: false, crossModule: false,
  highRework: false, highImpactUnknowns: 0, irreversibleOrSensitive: false,
  semanticAssessment: "USER_CONFIRMED", structuralComplexity: 1,
};

const cases: readonly [string, Partial<IntakeFacts>, SpecificationRoute][] = [
  ["explanation", { requiresPersistentWork: false }, "BYPASS"],
  ["translation", { requiresPersistentWork: false, objectiveClear: false }, "BYPASS"],
  ["architecture question", { requiresPersistentWork: false, crossModule: true }, "BYPASS"],
  ["single typo", {}, "BUILD_LIGHT"],
  ["known config edit", { filesKnown: true }, "BUILD_LIGHT"],
  ["one test assertion", { acceptanceClear: true }, "BUILD_LIGHT"],
  ["low risk rename", { expectedSteps: 1 }, "BUILD_LIGHT"],
  ["one documentation fix", { lowRisk: true }, "BUILD_LIGHT"],
  ["two steps", { expectedSteps: 2 }, "TASK_SPEC"],
  ["file unknown", { filesKnown: false }, "TASK_SPEC"],
  ["acceptance unclear", { acceptanceClear: false }, "TASK_SPEC"],
  ["objective bounded ambiguity", { objectiveClear: false }, "TASK_SPEC"],
  ["medium risk", { lowRisk: false }, "TASK_SPEC"],
  ["three stage maintenance", { expectedSteps: 3 }, "TASK_SPEC"],
  ["cross module bounded", { crossModule: true, expectedSteps: 3 }, "TASK_SPEC"],
  ["product only bounded", { productOrUserFlow: true, expectedSteps: 2 }, "TASK_SPEC"],
  ["high rework only", { highRework: true, expectedSteps: 2 }, "TASK_SPEC"],
  ["one material unknown", { highImpactUnknowns: 1 }, "PRD"],
  ["many material unknowns", { highImpactUnknowns: 4 }, "PRD"],
  ["product cross module", { productOrUserFlow: true, crossModule: true }, "PRD"],
  ["product high rework", { productOrUserFlow: true, highRework: true }, "PRD"],
  ["cross module high rework", { crossModule: true, highRework: true }, "PRD"],
  ["all product signals", { productOrUserFlow: true, crossModule: true, highRework: true }, "PRD"],
  ["irreversible migration", { irreversibleOrSensitive: true }, "PRD"],
  ["privacy choice", { irreversibleOrSensitive: true, highImpactUnknowns: 1 }, "PRD"],
  ["new multi-role UI", { productOrUserFlow: true, crossModule: true, expectedSteps: 5 }, "PRD"],
  ["new service", { productOrUserFlow: true, highRework: true, lowRisk: false }, "PRD"],
  ["risky database migration", { crossModule: true, highRework: true, irreversibleOrSensitive: true }, "PRD"],
  ["unresolved structurally complex input", { semanticAssessment: "UNRESOLVED", structuralComplexity: 3 }, "PRD"],
  ["bounded refactor", { crossModule: true, expectedSteps: 5, filesKnown: true }, "TASK_SPEC"],
  ["single low-risk build despite long description", { expectedSteps: 1, objectiveClear: true }, "BUILD_LIGHT"],
];

describe("route classifier", () => {
  it.each(cases)("classifies %s", (_name, patch, expected) => {
    const result = classifySpecificationRoute({ ...base, ...patch });
    expect(result.route).toBe(expected);
    expect(result.reasonCodes.length).toBeGreaterThan(0);
    expect(result.additionalModelRequests).toBe(0);
  });
});
