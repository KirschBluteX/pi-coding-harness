import { describe, expect, it } from "vitest";
import { runPairedBenchmark } from "../../src/performance/benchmark-harness.js";
import { validRequirement } from "../helpers/phase2.js";

describe("paired benchmark harness", () => {
  it("uses the frozen seed and fixed pair population without additional model requests", async () => {
    const contract = structuredClone(validRequirement().requirements.performance_contract);
    (contract.trial_protocol as { min_pairs: number; max_pairs: number; bootstrap_resamples: number }).min_pairs = 2;
    (contract.trial_protocol as { min_pairs: number; max_pairs: number; bootstrap_resamples: number }).max_pairs = 2;
    const calls: string[] = [];
    let now = 0;
    const result = await runPairedBenchmark({
      trialId: "TRIAL-HARNESS-001", contract, environmentFingerprintSha256: "e".repeat(64), now: () => now++,
      execute: (workload, metric, arm, pairIndex) => {
        calls.push(`${workload.id}:${metric.id}:${pairIndex}:${arm}`);
        return Promise.resolve({ value: arm === "BASELINE" ? 100 : 90, unit: metric.unit, qualityGate: "PASS" as const, environmentFingerprintSha256: "e".repeat(64) });
      },
    });
    expect(result.status).toBe("COMPLETE");
    expect(result.samples).toHaveLength(contract.workloads.length * 2 * 2);
    expect(result.additionalModelRequests).toBe(0);
    expect(calls).toEqual([...calls]);
  });

  it("stops immediately on environment drift", async () => {
    const contract = structuredClone(validRequirement().requirements.performance_contract);
    (contract.trial_protocol as { min_pairs: number; max_pairs: number }).min_pairs = 1;
    (contract.trial_protocol as { min_pairs: number; max_pairs: number }).max_pairs = 1;
    const result = await runPairedBenchmark({
      trialId: "TRIAL-HARNESS-DRIFT", contract, environmentFingerprintSha256: "e".repeat(64),
      execute: (_workload, metric) => Promise.resolve({ value: 1, unit: metric.unit, qualityGate: "PASS" as const, environmentFingerprintSha256: "f".repeat(64) }),
    });
    expect(result.status).toBe("ENVIRONMENT_DRIFT");
  });
});
