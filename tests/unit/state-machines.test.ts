import { describe, expect, it } from "vitest";
import { assertGoalTransition, assertStageTransition } from "../../src/authority/state-machines.js";

describe("authority state machines", () => {
  it("accepts declared recovery and execution transitions", () => {
    expect(() => assertGoalTransition("ACTIVE", "RECOVERING")).not.toThrow();
    expect(() => assertGoalTransition("RECOVERING", "NEEDS_RECONCILIATION")).not.toThrow();
    expect(() => assertStageTransition("READY", "RUNNING")).not.toThrow();
    expect(() => assertStageTransition("RUNNING", "SUCCEEDED")).not.toThrow();
  });

  it("rejects terminal resurrection and unauthorized Stage execution", () => {
    expect(() => assertGoalTransition("SUCCEEDED", "ACTIVE")).toThrow(/Invalid Goal transition/u);
    expect(() => assertStageTransition("PLANNED", "RUNNING")).toThrow(/Invalid Stage transition/u);
    expect(() => assertStageTransition("INVALIDATED", "READY")).toThrow(/Invalid Stage transition/u);
  });
});
