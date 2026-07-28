import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/foundation/crypto.js";
import {
  benchmarkResultMarker, evaluatePerformancePhase, measurementsFromBenchmarkOutput,
} from "../../src/performance/task-flow-measurements.js";
import type { TargetPerformanceContract, TargetPerformancePhase } from "../../src/performance/task-flow-policy.js";

const contract: TargetPerformanceContract = {
  schema_version: 1, contract_id: "PERFORMANCE-TEST-001", mode: "OPTIMIZE", activation_basis: "USER_REQUEST",
  scope: { include: ["src/parser.ts"], exclude: [] },
  workloads: [
    { key: "primary", role: "PRIMARY", command: "npm run bench:primary", fixture_ref: "fixtures/primary.json", representativeness: "primary" },
    { key: "regression", role: "REGRESSION", command: "npm run bench:regression", fixture_ref: "fixtures/regression.json", representativeness: "regression" },
    { key: "holdout", role: "HOLDOUT", command: "npm run bench:holdout", fixture_ref: "fixtures/holdout.json", representativeness: "holdout" },
  ],
  metrics: [{
    key: "latency_p95", role: "PRIMARY_GATE", unit: "ms", direction: "LOWER", aggregation: "P95",
    workload_keys: ["primary", "regression", "holdout"], minimum_improvement_pct: 10, maximum_regression_pct: 1,
  }],
  correctness_obligation_keys: ["correctness"],
  opportunity_gate: { minimum_hotspot_fraction: 0.1, minimum_practical_improvement_pct: 3, unknown_action: "ADVICE_ONLY" },
  budget: { max_candidates: 2, max_wall_time_ms: 60_000, max_user_blocking_ms: 1_000 },
  holdout_policy: "REQUIRED", rollback_required: true,
};

function measurement(phase: TargetPerformancePhase, workloadKey: string, value: number, operationId: string) {
  const workload = contract.workloads.find((entry) => entry.key === workloadKey)!;
  const text = `${benchmarkResultMarker}${JSON.stringify({
    schema_version: 1, workload_key: workloadKey, environment_sha256: sha256Hex("environment"),
    sample_count: 30, metrics: { latency_p95: value },
  })}`;
  return measurementsFromBenchmarkOutput({
    goalId: "GOAL-PERFORMANCE-TEST", workCellId: `CELL-${phase}`, contract, phase,
    operationId, command: workload.command, outputSha256: sha256Hex(text), text, createdAtMs: 100,
  });
}

describe("target-performance measurement gate", () => {
  it("requires complete frozen baseline evidence and passes a threshold-compliant candidate", () => {
    const baseline = [
      ...measurement("BASELINE_PROFILE", "primary", 100, "ATTEMPT-BP"),
      ...measurement("BASELINE_PROFILE", "regression", 100, "ATTEMPT-BR"),
      ...measurement("BASELINE_PROFILE", "holdout", 100, "ATTEMPT-BH"),
    ];
    expect(evaluatePerformancePhase({
      goalId: "GOAL-PERFORMANCE-TEST", workCellId: "CELL-BASELINE", contract,
      phase: "BASELINE_PROFILE", measurements: baseline, baseline: [], createdAtMs: 100,
    }).verdict).toBe("PASS");
    const candidate = [
      ...measurement("CANDIDATE", "primary", 80, "ATTEMPT-CP"),
      ...measurement("CANDIDATE", "regression", 99.5, "ATTEMPT-CR"),
    ];
    expect(evaluatePerformancePhase({
      goalId: "GOAL-PERFORMANCE-TEST", workCellId: "CELL-CANDIDATE", contract,
      phase: "CANDIDATE", measurements: candidate, baseline, createdAtMs: 200,
    })).toMatchObject({ verdict: "PASS", reasons: [] });
  });

  it("fails closed for malformed output, insufficient improvement and regression", () => {
    expect(() => measurementsFromBenchmarkOutput({
      goalId: "GOAL-PERFORMANCE-TEST", workCellId: "CELL", contract, phase: "CANDIDATE",
      operationId: "ATTEMPT", command: "npm run bench:primary", outputSha256: sha256Hex("plain"),
      text: "plain benchmark output", createdAtMs: 100,
    })).toThrow(/PCH_BENCHMARK_RESULT_V1/u);
    const baseline = [
      ...measurement("BASELINE_PROFILE", "primary", 100, "ATTEMPT-BP"),
      ...measurement("BASELINE_PROFILE", "regression", 100, "ATTEMPT-BR"),
      ...measurement("BASELINE_PROFILE", "holdout", 100, "ATTEMPT-BH"),
    ];
    const weak = [
      ...measurement("CANDIDATE", "primary", 95, "ATTEMPT-CP"),
      ...measurement("CANDIDATE", "regression", 102, "ATTEMPT-CR"),
    ];
    const verdict = evaluatePerformancePhase({
      goalId: "GOAL-PERFORMANCE-TEST", workCellId: "CELL-CANDIDATE", contract,
      phase: "CANDIDATE", measurements: weak, baseline, createdAtMs: 200,
    });
    expect(verdict.verdict).toBe("FAIL");
    expect(verdict.reasons).toEqual(expect.arrayContaining([
      expect.stringMatching(/^IMPROVEMENT:primary/u),
      expect.stringMatching(/^REGRESSION:regression/u),
    ]));
  });
});
