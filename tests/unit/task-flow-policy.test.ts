import { describe, expect, it } from "vitest";
import { classifyTaskFlowInput, mayUseDirectCell } from "../../src/task-flow/admission.js";
import { assessRouteHealth } from "../../src/task-flow/health.js";

const config = { execution: { default_intent: "AUTO" as const } };

describe("Task Flow deterministic policy", () => {
  it("bypasses conversation and admits only the current plan/build markers", () => {
    expect(classifyTaskFlowInput("为什么需要 WAL？", config)).toMatchObject({ action: "BYPASS", intent: null });
    expect(classifyTaskFlowInput("plan: 设计功能", config)).toMatchObject({ action: "MANAGED", intent: "PLAN", marker: "plan" });
    expect(classifyTaskFlowInput("build: 修改 src/a.ts 并测试", config)).toMatchObject({ action: "MANAGED", intent: "BUILD", marker: "build" });
  });

  it("classifies Chinese durable work without turning explanatory questions into Goals", () => {
    const bypass = ["什么是缓存命中率？", "请介绍当前架构", "如何理解任务流？", "告诉我这个模块的作用"];
    for (const text of bypass) expect(classifyTaskFlowInput(text, config).action).toBe("BYPASS");
    expect(classifyTaskFlowInput("修改 src/a.ts 并运行测试", config)).toMatchObject({ action: "MANAGED", intent: "BUILD", lane: "DIRECT_CELL" });
    expect(classifyTaskFlowInput("全面重构整个项目架构", config)).toMatchObject({ action: "MANAGED", intent: "PLAN", lane: "ADAPTIVE_ROUTE" });
    expect(classifyTaskFlowInput("部署到生产环境", config)).toMatchObject({ action: "MANAGED", intent: "PLAN", lane: "ADAPTIVE_ROUTE" });
  });

  it("unwraps a Pi file task while keeping a bounded one-line authority objective", () => {
    const details = `build: Update src/example.ts and run tests.\n\nAcceptance:\n${"Preserve detailed task context. ".repeat(30)}`;
    const admission = classifyTaskFlowInput(`<file name="X:\\work\\TASK.md">\n${details}\n</file>`, config);
    expect(admission).toMatchObject({ action: "MANAGED", intent: "BUILD", marker: "build" });
    expect(admission.reasonCodes).toContain("PI_FILE_ENVELOPE_UNWRAPPED");
    expect(admission.reasonCodes).toContain("OBJECTIVE_PROJECTED");
    expect(admission.taskText).toContain("Acceptance:\n");
    expect(admission.taskText).not.toContain("<file name=");
    expect(admission.objective).not.toMatch(/[\r\n]/u);
    expect(admission.objective.length).toBeLessThanOrEqual(512);
  });

  it("rejects task text that cannot fit the source-bound AcceptanceLedger", () => {
    expect(() => classifyTaskFlowInput(`build: ${"x".repeat(32_769)}`, config))
      .toThrow(/at most 32768 characters/u);
  });

  it("admits DirectCell only when every bounded fast-path proof is present", () => {
    expect(mayUseDirectCell({ lane: "DIRECT_CELL", boundedScope: true, oracleKnown: true, reversible: true, materialDecisionOpen: false, migrationOrExternalEffect: false, workCellCount: 1 })).toBe(true);
    expect(mayUseDirectCell({ lane: "DIRECT_CELL", boundedScope: true, oracleKnown: false, reversible: true, materialDecisionOpen: false, migrationOrExternalEffect: false, workCellCount: 1 })).toBe(false);
  });

  it("escalates repeated signatures and unknown effects without an unbounded retry", () => {
    const base = { activeObligationCount: 100, currentRecordCount: 256, authorityIntegrityFailure: false, materialDecisionOpen: false, assumptionInvalidated: false, acceptanceUnreachable: false, failureSignatureSha256: "a".repeat(64), retryLimit: 2, transientFailure: true, localRepairAvailable: false, routeAlternativeAvailable: true, progressObserved: false };
    expect(assessRouteHealth({ ...base, unknownEffect: false, failureOccurrence: 1 })).toMatchObject({ level: "H1_RETRY", retryAllowed: true });
    expect(assessRouteHealth({ ...base, unknownEffect: false, failureOccurrence: 2 })).toMatchObject({ level: "H3_REFRAME", retryAllowed: false, invalidateAuthorization: true });
    expect(assessRouteHealth({ ...base, unknownEffect: true, failureOccurrence: 1 })).toMatchObject({ level: "H5_RECONCILE_OR_STOP", retryAllowed: false });
  });

});
