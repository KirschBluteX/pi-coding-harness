import type { PerformanceContract, PerformanceMetric, PerformanceWorkload } from "./contract.js";
import { canonicalJsonSha256 } from "../authority/canonical-json.js";

export interface BenchmarkObservation {
  readonly value: number;
  readonly unit: string;
  readonly qualityGate: "PASS" | "FAIL";
  readonly environmentFingerprintSha256: string;
}

export interface TrialPairSample extends BenchmarkObservation {
  readonly sampleId: string;
  readonly trialId: string;
  readonly pairId: string;
  readonly pairIndex: number;
  readonly workloadId: string;
  readonly workloadRole: PerformanceWorkload["role"];
  readonly metricId: string;
  readonly metricDirection: PerformanceMetric["direction"];
  readonly sampleRole: "BASELINE" | "CANDIDATE";
  readonly orderInPair: "BASELINE_FIRST" | "CANDIDATE_FIRST";
  readonly observedAtMs: number;
}

export interface BenchmarkRunInput {
  readonly trialId: string;
  readonly contract: PerformanceContract;
  readonly environmentFingerprintSha256: string;
  readonly pairCount?: number;
  readonly now?: () => number;
  readonly execute: (
    workload: PerformanceWorkload,
    metric: PerformanceMetric,
    arm: "BASELINE" | "CANDIDATE",
    pairIndex: number,
  ) => Promise<BenchmarkObservation>;
}

export interface BenchmarkRunResult {
  readonly status: "COMPLETE" | "BUDGET_EXHAUSTED" | "ENVIRONMENT_DRIFT" | "QUALITY_FAILED";
  readonly samples: readonly TrialPairSample[];
  readonly sampleSetSha256: string;
  readonly pairsCompleted: number;
  readonly elapsedMs: number;
  readonly additionalModelRequests: 0;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function assertObservation(value: BenchmarkObservation, metric: PerformanceMetric): void {
  if (!Number.isFinite(value.value)) throw new TypeError("Benchmark value must be finite");
  if (value.unit !== metric.unit) throw new TypeError(`Benchmark unit mismatch for ${metric.id}`);
  if (!/^[a-f0-9]{64}$/u.test(value.environmentFingerprintSha256)) throw new TypeError("Benchmark environment fingerprint is invalid");
}

export async function runPairedBenchmark(input: BenchmarkRunInput): Promise<BenchmarkRunResult> {
  const { contract } = input;
  const now = input.now ?? Date.now;
  const pairCount = input.pairCount ?? (contract.trial_protocol.stopping_rule === "FIXED_PAIRS"
    ? contract.trial_protocol.max_pairs : contract.trial_protocol.min_pairs);
  if (!Number.isSafeInteger(pairCount) || pairCount < contract.trial_protocol.min_pairs
    || pairCount > contract.trial_protocol.max_pairs) throw new TypeError("Pair count is outside the frozen trial protocol");
  const started = now();
  const random = seededRandom(contract.trial_protocol.random_seed);
  const samples: TrialPairSample[] = [];
  const result = (status: BenchmarkRunResult["status"], pairsCompleted: number): BenchmarkRunResult => ({
    status, samples, sampleSetSha256: canonicalJsonSha256(samples), pairsCompleted,
    elapsedMs: now() - started, additionalModelRequests: 0,
  });
  const groups = contract.metrics.flatMap((metric) => metric.workload_ids.map((workloadId) => {
    const workload = contract.workloads.find((entry) => entry.id === workloadId);
    if (!workload) throw new TypeError(`Metric ${metric.id} references missing workload ${workloadId}`);
    return { metric, workload };
  }));
  let pairsCompleted = 0;
  for (const { metric, workload } of groups) {
    for (let pairIndex = 0; pairIndex < pairCount; pairIndex += 1) {
      if (now() - started >= contract.experiment_budget.max_wall_time_ms) {
        return result("BUDGET_EXHAUSTED", pairsCompleted);
      }
      const baselineFirst = contract.trial_protocol.order_policy === "ALTERNATING" ? pairIndex % 2 === 0
        : contract.trial_protocol.order_policy === "RANDOMIZED_INTERLEAVED" ? random() < 0.5 : pairIndex % 2 === 0;
      const order = baselineFirst ? ["BASELINE", "CANDIDATE"] as const : ["CANDIDATE", "BASELINE"] as const;
      for (const arm of order) {
        const observation = await input.execute(workload, metric, arm, pairIndex);
        assertObservation(observation, metric);
        const common = {
          ...observation,
          trialId: input.trialId,
          pairId: `${input.trialId}:${workload.id}:${metric.id}:${pairIndex}`,
          pairIndex,
          workloadId: workload.id,
          workloadRole: workload.role,
          metricId: metric.id,
          metricDirection: metric.direction,
          orderInPair: baselineFirst ? "BASELINE_FIRST" as const : "CANDIDATE_FIRST" as const,
          observedAtMs: now(),
        };
        samples.push({ ...common, sampleId: `${common.pairId}:${arm}`, sampleRole: arm });
        if (observation.environmentFingerprintSha256 !== input.environmentFingerprintSha256) {
          return result("ENVIRONMENT_DRIFT", pairsCompleted);
        }
        if (observation.qualityGate !== "PASS") {
          return result("QUALITY_FAILED", pairsCompleted);
        }
      }
      pairsCompleted += 1;
    }
  }
  return result("COMPLETE", pairsCompleted);
}
