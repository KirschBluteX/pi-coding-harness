import { describe, expect, it } from "vitest";
import { targetPerformanceContract, targetPerformanceDemand } from "../../src/performance/task-flow-policy.js";
import { finalizeGoalContract, finalizeRoute, type GoalContractProposal, type RouteProposal } from "../../src/task-flow/finalize.js";

const now = 1_800_000_000_000;

function performancePolicy() {
  return {
    all_must: true,
    performance_contract: {
      schema_version: 1,
      mode: "OPTIMIZE",
      activation_basis: "USER_REQUEST",
      scope: { include: ["src/**"], exclude: ["src/generated/**"] },
      workloads: [
        { key: "primary", role: "PRIMARY", command: "npm run bench:primary", fixture_ref: "fixtures/primary.json", representativeness: "Main parser workload" },
        { key: "regression", role: "REGRESSION", command: "npm run bench:regression", fixture_ref: "fixtures/regression.json", representativeness: "Small common parser workload" },
        { key: "holdout", role: "HOLDOUT", command: "npm run bench:holdout", fixture_ref: "fixtures/holdout.json", representativeness: "Frozen unseen parser workload" },
      ],
      metrics: [
        {
          key: "latency-p95", role: "PRIMARY_GATE", unit: "ms", direction: "LOWER", aggregation: "P95",
          workload_keys: ["primary", "regression", "holdout"], minimum_improvement_pct: 3, maximum_regression_pct: 1,
        },
      ],
      correctness_obligation_keys: ["correctness"],
      opportunity_gate: { minimum_hotspot_fraction: 0.05, minimum_practical_improvement_pct: 3, unknown_action: "ADVICE_ONLY" },
      budget: { max_candidates: 2, max_wall_time_ms: 300_000, max_user_blocking_ms: 1_000 },
      holdout_policy: "REQUIRED",
      rollback_required: true,
    },
  } as const;
}

function proposal(withPerformance = true): GoalContractProposal {
  return {
    user_outcomes: ["Parser is measurably faster without behavior changes"],
    scope: ["src/parser.ts", "fixtures"],
    non_goals: ["Public API changes"],
    constraints: ["No correctness regression"],
    obligations: [{ key: "correctness", priority: "MUST", statement: "Parser behavior remains correct", oracle: { command: "npm test" } }],
    ...(withPerformance ? { acceptance_policy: performancePolicy() } : {}),
    authorization_ceiling: "LOCAL_REVERSIBLE",
  };
}

function contract(withPerformance = true) {
  return finalizeGoalContract({
    goalId: "GOAL-PERFORMANCE-001", objective: "优化 src/parser.ts 的性能并降低 P95 延迟", intent: "BUILD",
    lane: "ADAPTIVE_ROUTE", sourceIntakeSha256: "a".repeat(64), version: 1, parentContractId: null,
    proposal: proposal(withPerformance), createdAtMs: now,
  });
}

function route(): RouteProposal {
  return {
    lane: "ADAPTIVE_ROUTE",
    outcomes: ["Baseline and hotspot proven", "Reversible candidate implemented", "Frozen holdout passed"],
    work_cells: [
      {
        key: "baseline", outcome: "Measure baseline and admit only a real hotspot", obligation_keys: ["correctness"],
        read_roots: ["src/parser.ts", "fixtures/primary.json", "fixtures/regression.json"], write_roots: [],
        effect_classes: ["READ_ONLY"], oracle: { commands: ["npm test", "npm run bench:primary", "npm run bench:regression", "npm run bench:holdout"] },
        risk: "LOW", reversible: true, budget: { max_attempts: 1, performance_phase: "BASELINE_PROFILE" },
      },
      {
        key: "candidate", outcome: "Implement and validate the best admitted candidate", obligation_keys: ["correctness"], dependencies: ["baseline"],
        read_roots: ["src/parser.ts", "fixtures"], write_roots: ["src/parser.ts"], effect_classes: ["LOCAL_REVERSIBLE"],
        oracle: { commands: ["npm test", "npm run bench:primary", "npm run bench:regression"] },
        risk: "LOW", reversible: true, budget: { max_attempts: 2, performance_phase: "CANDIDATE" },
      },
      {
        key: "holdout", outcome: "Validate the selected candidate on the frozen holdout", obligation_keys: ["correctness"], dependencies: ["candidate"],
        read_roots: ["src/parser.ts", "fixtures/holdout.json"], write_roots: [], effect_classes: ["READ_ONLY"],
        oracle: { commands: ["npm test", "npm run bench:holdout"] }, risk: "LOW", reversible: true,
        budget: { max_attempts: 1, performance_phase: "HOLDOUT" },
      },
    ],
  };
}

describe("target-project performance Task Flow", () => {
  it("detects Chinese and English performance demand without affecting ordinary tasks", () => {
    expect(targetPerformanceDemand("优化解析器性能并降低延迟")).toBe("OPTIMIZE");
    expect(targetPerformanceDemand("Preserve current throughput while fixing the parser")).toBe("NON_REGRESSION");
    expect(targetPerformanceDemand("Fix one parser correctness regression")).toBe("NONE");
    expect(targetPerformanceDemand("Fix an SVG regression. Benchmark constraints: use only the local repository.")).toBe("NONE");
    expect(targetPerformanceDemand("Do not optimize performance; only fix correctness.")).toBe("NONE");
    expect(targetPerformanceDemand("TargetPerformance=NON_REGRESSION; fix the parser")).toBe("NON_REGRESSION");
    expect(targetPerformanceDemand("TargetPerformance=OPTIMIZE; fix the parser")).toBe("OPTIMIZE");
  });

  it("requires a frozen performance contract only for an explicit performance task", () => {
    expect(() => contract(false)).toThrow(/requires acceptance_policy\.performance_contract/u);
    const ordinary = finalizeGoalContract({
      goalId: "GOAL-ORDINARY-001", objective: "Fix src/parser.ts and run its test", intent: "BUILD", lane: "DIRECT_CELL",
      sourceIntakeSha256: "b".repeat(64), version: 1, parentContractId: null, proposal: proposal(false), createdAtMs: now,
    });
    expect(targetPerformanceContract(ordinary)).toBeNull();
  });

  it("locally drops a malformed performance contract from an ordinary task", () => {
    const malformed: GoalContractProposal = {
      ...proposal(false),
      acceptance_policy: {
        all_must: true,
        performance_contract: { target: "NON_REGRESSION", workloads: ["invented"] },
      },
    };
    const ordinary = finalizeGoalContract({
      goalId: "GOAL-ORDINARY-REPAIR", objective: "Fix src/parser.ts and run its test", intent: "BUILD", lane: "DIRECT_CELL",
      sourceIntakeSha256: "c".repeat(64), version: 1, parentContractId: null, proposal: malformed, createdAtMs: now,
    });
    expect(targetPerformanceContract(ordinary)).toBeNull();
    expect(ordinary.acceptance_policy).toEqual({
      all_must: true,
      performance_contract_disposition: "IGNORED_MALFORMED_WITHOUT_EXPLICIT_DEMAND",
    });
  });

  it("freezes a hash-bound three-phase optimization route", () => {
    const frozenContract = contract();
    const performance = targetPerformanceContract(frozenContract);
    expect(performance).toMatchObject({ mode: "OPTIMIZE", holdout_policy: "REQUIRED", rollback_required: true });
    const frozen = finalizeRoute({ contract: frozenContract, revision: 1, parentRouteId: null, proposal: route(), createdAtMs: now });
    expect(frozen.work_cells.map((cell) => cell.budget.performance_phase)).toEqual(["BASELINE_PROFILE", "CANDIDATE", "HOLDOUT"]);
    expect(new Set(frozen.work_cells.map((cell) => cell.budget.performance_contract_sha256)).size).toBe(1);
  });

  it("rejects a holdout mutation and a route that bypasses the baseline dependency", () => {
    const frozenContract = contract();
    const source = route();
    const holdoutWrite: RouteProposal = {
      ...source,
      work_cells: source.work_cells.map((cell, index) => index === 2 ? { ...cell, write_roots: ["src/parser.ts"] } : cell),
    };
    expect(() => finalizeRoute({ contract: frozenContract, revision: 1, parentRouteId: null, proposal: holdoutWrite, createdAtMs: now }))
      .toThrow(/cannot mutate target files/u);
    const bypass: RouteProposal = {
      ...source,
      work_cells: source.work_cells.map((cell, index) => index === 1 ? { ...cell, dependencies: [] } : cell),
    };
    expect(() => finalizeRoute({ contract: frozenContract, revision: 1, parentRouteId: null, proposal: bypass, createdAtMs: now }))
      .toThrow(/dependencies must preserve/u);
  });
});
