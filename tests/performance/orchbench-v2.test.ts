import { describe, expect, it } from "vitest";
import {
  compareWorkerMarginalContributionV1,
  simulateOrchBenchV1,
  type OrchBenchConfigV1,
  type OrchBenchScenarioV1,
} from "../../src/benchmarks/orchbench/simulator.js";

const scenario: OrchBenchScenarioV1 = {
  scenario_id: "ORCHBENCH-CONTINUOUS-BACKFILL",
  nodes: [
    { node_id: "A", capability: "DISCOVER", dependency_ids: [], compute_ms: 8, integration_ms: 0 },
    { node_id: "B", capability: "DISCOVER", dependency_ids: [], compute_ms: 20, integration_ms: 0 },
    { node_id: "C", capability: "VERIFY", dependency_ids: ["A"], compute_ms: 8, integration_ms: 2 },
    { node_id: "D", capability: "VERIFY", dependency_ids: ["B", "C"], compute_ms: 5, integration_ms: 1 },
  ],
};

const base: OrchBenchConfigV1 = {
  workers: 2,
  scheduling: "CONTINUOUS",
  coordination: "VERIFIED_QUEUE",
  topology: "DYNAMIC_CAPABILITY",
  central_dispatch_ms: 2,
  verified_queue_claim_ms: 0,
  fixed_role_count: 5,
  fixed_role_startup_ms: 3,
  capability_startup_ms: 1,
};

describe("deterministic OrchBench V2", () => {
  it("measures continuous backfill without waiting for an unrelated branch", () => {
    const continuous = simulateOrchBenchV1(scenario, base);
    const barrier = simulateOrchBenchV1(scenario, { ...base, scheduling: "BARRIER" });
    expect(continuous.completed_nodes).toBe(4);
    expect(continuous.makespan_ms).toBeLessThan(barrier.makespan_ms);
    expect(simulateOrchBenchV1(scenario, base)).toEqual(continuous);
  });

  it("makes topology and coordination overhead explicit instead of hiding it in task work", () => {
    const dynamic = simulateOrchBenchV1(scenario, base);
    const fixed = simulateOrchBenchV1(scenario, {
      ...base, topology: "FIXED_ROLE", coordination: "CENTRAL",
    });
    expect(dynamic.startup_ms).toBe(2);
    expect(fixed.startup_ms).toBe(15);
    expect(fixed.critical_path_idle_ms).toBeGreaterThan(dynamic.critical_path_idle_ms);
    expect(fixed.coordination_events).toBe(dynamic.coordination_events);
  });

  it("accounts for failed attempts, stale work and durable invalidation", () => {
    const result = simulateOrchBenchV1({
      scenario_id: "ORCHBENCH-FAULTS",
      nodes: [
        { node_id: "RETRY", capability: "PATCH", dependency_ids: [], compute_ms: 5, integration_ms: 1,
          attempts_before_success: 2 },
        { node_id: "STALE", capability: "VERIFY", dependency_ids: [], compute_ms: 10, integration_ms: 0,
          invalidated_at_ms: 4 },
      ],
    }, { ...base, workers: 2 });
    expect(result).toMatchObject({ completed_nodes: 1, stopped_nodes: 1, retries: 1, total_compute_ms: 20 });
    expect(result.stale_work_ms).toBe(13);
    expect(result.unique_work_basis_points).toBe(2_500);
  });

  it("reports zero marginal gain once available parallelism is exhausted", () => {
    const independent: OrchBenchScenarioV1 = {
      scenario_id: "ORCHBENCH-MARGINAL",
      nodes: [
        { node_id: "A", capability: "READ", dependency_ids: [], compute_ms: 10, integration_ms: 0 },
        { node_id: "B", capability: "READ", dependency_ids: [], compute_ms: 10, integration_ms: 0 },
      ],
    };
    const result = compareWorkerMarginalContributionV1(independent, base);
    expect(result.map((entry) => entry.marginal_gain_ms)).toEqual([0, 10, 0, 0]);
  });

  it("rejects cycles before producing misleading benchmark output", () => {
    expect(() => simulateOrchBenchV1({
      scenario_id: "ORCHBENCH-CYCLE",
      nodes: [
        { node_id: "A", capability: "READ", dependency_ids: ["B"], compute_ms: 1, integration_ms: 0 },
        { node_id: "B", capability: "READ", dependency_ids: ["A"], compute_ms: 1, integration_ms: 0 },
      ],
    }, base)).toThrow(/cycle/u);
  });
});
