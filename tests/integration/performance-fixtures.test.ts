import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runPairedBenchmark } from "../../src/performance/benchmark-harness.js";
import { validRequirement } from "../helpers/phase2.js";

const executeFile = promisify(execFile);

interface FixtureOutput {
  readonly value: number;
  readonly unit: string;
  readonly quality: "PASS";
}

async function runFixture(stack: "node" | "powershell", arm: "BASELINE" | "CANDIDATE"): Promise<FixtureOutput> {
  const command = stack === "node" ? process.execPath : "pwsh";
  const args = stack === "node"
    ? [resolve("fixtures", "performance", "node", "workload.mjs"), arm]
    : ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", resolve("fixtures", "performance", "powershell", "workload.ps1"), "-Arm", arm];
  const { stdout } = await executeFile(command, args, { timeout: 10_000, windowsHide: true });
  return JSON.parse(stdout.trim()) as FixtureOutput;
}

describe("cross-stack performance fixture workflow", () => {
  it.each(["node", "powershell"] as const)("runs the %s fixture through the same bounded pair contract", async (stack) => {
    const contract = structuredClone(validRequirement().requirements.performance_contract);
    (contract as unknown as { workloads: unknown[] }).workloads = [contract.workloads[0]];
    (contract as unknown as { metrics: Array<{ workload_ids: string[] }> }).metrics = [{ ...contract.metrics[0], workload_ids: [contract.workloads[0]?.id ?? ""] }];
    (contract.trial_protocol as { min_pairs: number; max_pairs: number }).min_pairs = 1;
    (contract.trial_protocol as { min_pairs: number; max_pairs: number }).max_pairs = 1;
    const result = await runPairedBenchmark({
      trialId: `TRIAL-FIXTURE-${stack.toUpperCase()}`, contract,
      environmentFingerprintSha256: "e".repeat(64),
      execute: async (_workload, metric, arm) => {
        const output = await runFixture(stack, arm);
        return { value: output.value, unit: metric.unit, qualityGate: output.quality, environmentFingerprintSha256: "e".repeat(64) };
      },
    });
    expect(result.status).toBe("COMPLETE");
    expect(result.samples).toHaveLength(2);
    expect(result.samples.find((sample) => sample.sampleRole === "CANDIDATE")?.value).toBeLessThan(
      result.samples.find((sample) => sample.sampleRole === "BASELINE")?.value ?? 0,
    );
  }, 30_000);
});
