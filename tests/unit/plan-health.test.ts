import { describe, expect, it } from "vitest";
import { assessPlanHealth, type EvidenceDelta } from "../../src/planning/plan-health.js";
import { validPlanningSnapshot } from "../helpers/phase2.js";

const cases: readonly [string, EvidenceDelta, string][] = [
  ["L0", { evidenceId: "EV-L0" }, "L0"],
  ["L1", { evidenceId: "EV-L1", failureSignature: "FAIL-1", transientFailure: true, idempotentOperation: true }, "L1"],
  ["L2", { evidenceId: "EV-L2", failureSignature: "FAIL-2", localRepairAvailable: true }, "L2"],
  ["L3", { evidenceId: "EV-L3", refutedAssumptionIds: ["ASM-DEMO-001"], replanAvailable: true }, "L3"],
  ["L4", { evidenceId: "EV-L4", requiresUserDecision: true }, "L4"],
  ["L5", { evidenceId: "EV-L5", unknownSideEffect: true }, "L5"],
];

describe("PlanHealth", () => {
  it.each(cases)("routes %s deterministically", (_name, evidence, expected) => {
    const result = assessPlanHealth(evidence, validPlanningSnapshot());
    expect(result.level).toBe(expected);
    expect(result.additionalModelRequests).toBe(0);
  });

  it("escalates the same failure signature and never retries unknown effects", () => {
    const snapshot = { ...validPlanningSnapshot(), failureOccurrences: { "FAIL-X": 2, "FAIL-Y": 3 } };
    expect(assessPlanHealth({ evidenceId: "EV-X", failureSignature: "FAIL-X", transientFailure: true, idempotentOperation: true, localRepairAvailable: true }, snapshot).level).toBe("L2");
    expect(assessPlanHealth({ evidenceId: "EV-Y", failureSignature: "FAIL-Y", replanAvailable: true }, snapshot).level).toBe("L3");
    expect(assessPlanHealth({ evidenceId: "EV-U", unknownSideEffect: true, transientFailure: true, idempotentOperation: true }, snapshot).action).toBe("BLOCK_OR_RECONCILE");
  });
});
