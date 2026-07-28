import { canonicalJsonSha256 } from "../authority/canonical-json.js";
import { idFromSha256 } from "../foundation/ids.js";
import { sha256Hex } from "../foundation/crypto.js";
import type { TargetPerformanceContract, TargetPerformancePhase } from "./task-flow-policy.js";

export const benchmarkResultMarker = "PCH_BENCHMARK_RESULT_V1=";

export interface TargetPerformanceMeasurementRecord {
  readonly schema_version: 1;
  readonly measurement_id: string;
  readonly goal_id: string;
  readonly work_cell_id: string;
  readonly performance_contract_sha256: string;
  readonly phase: TargetPerformancePhase;
  readonly operation_id: string;
  readonly command_sha256: string;
  readonly output_sha256: string;
  readonly workload_key: string;
  readonly metric_key: string;
  readonly value: number;
  readonly unit: string;
  readonly environment_sha256: string;
  readonly sample_count: number;
  readonly created_at_ms: number;
  readonly record_sha256: string;
}

export interface TargetPerformanceVerdictRecord {
  readonly schema_version: 1;
  readonly verdict_id: string;
  readonly goal_id: string;
  readonly work_cell_id: string;
  readonly performance_contract_sha256: string;
  readonly phase: TargetPerformancePhase;
  readonly measurement_root_sha256: string;
  readonly baseline_root_sha256: string | null;
  readonly verdict: "PASS" | "FAIL";
  readonly reasons: readonly string[];
  readonly created_at_ms: number;
  readonly record_sha256: string;
}

interface ParsedBenchmarkResult {
  readonly workloadKey: string;
  readonly environmentSha256: string;
  readonly sampleCount: number;
  readonly metrics: Readonly<Record<string, number>>;
}

function seal<T extends object>(domain: string, value: T): T & { readonly record_sha256: string } {
  return { ...value, record_sha256: canonicalJsonSha256({ domain, record: value }) };
}

function parseResult(text: string): ParsedBenchmarkResult {
  const start = text.indexOf(benchmarkResultMarker);
  if (start < 0) throw new TypeError(`benchmark output must include ${benchmarkResultMarker}<JSON>`);
  const line = text.slice(start + benchmarkResultMarker.length).split(/\r?\n/u, 1)[0] ?? "";
  if (!line || Buffer.byteLength(line, "utf8") > 65_536) throw new TypeError("benchmark result JSON is empty or oversized");
  const value = JSON.parse(line) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("benchmark result must be an object");
  const row = value as Record<string, unknown>;
  const expected = ["schema_version", "workload_key", "environment_sha256", "sample_count", "metrics"];
  if (Object.keys(row).sort().join("\0") !== expected.sort().join("\0") || row.schema_version !== 1
    || typeof row.workload_key !== "string" || !/^[\p{L}\p{N}][\p{L}\p{N}_.:-]*$/u.test(row.workload_key)
    || typeof row.environment_sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(row.environment_sha256)
    || !Number.isSafeInteger(row.sample_count) || Number(row.sample_count) < 1
    || typeof row.metrics !== "object" || row.metrics === null || Array.isArray(row.metrics)) {
    throw new TypeError("benchmark result fields are invalid");
  }
  const metrics = row.metrics as Record<string, unknown>;
  if (Object.keys(metrics).length === 0 || Object.keys(metrics).length > 32
    || Object.values(metrics).some((entry) => typeof entry !== "number" || !Number.isFinite(entry))) {
    throw new TypeError("benchmark metrics must contain bounded finite numbers");
  }
  return {
    workloadKey: row.workload_key,
    environmentSha256: row.environment_sha256,
    sampleCount: Number(row.sample_count),
    metrics: metrics as Record<string, number>,
  };
}

export function measurementsFromBenchmarkOutput(input: {
  readonly goalId: string;
  readonly workCellId: string;
  readonly contract: TargetPerformanceContract;
  readonly phase: TargetPerformancePhase;
  readonly operationId: string;
  readonly command: string;
  readonly outputSha256: string;
  readonly text: string;
  readonly createdAtMs: number;
}): readonly TargetPerformanceMeasurementRecord[] {
  const workload = input.contract.workloads.find((entry) => entry.command === input.command);
  if (!workload) return [];
  const parsed = parseResult(input.text);
  if (parsed.workloadKey !== workload.key) throw new TypeError("benchmark result workload does not match its frozen command");
  const metrics = input.contract.metrics.filter((metric) => metric.workload_keys.includes(workload.key));
  const expected = new Set(metrics.map((metric) => metric.key));
  if (expected.size === 0 || Object.keys(parsed.metrics).some((key) => !expected.has(key))
    || [...expected].some((key) => parsed.metrics[key] === undefined)) {
    throw new TypeError("benchmark result metric set does not match its frozen contract");
  }
  const contractSha256 = canonicalJsonSha256(input.contract);
  return metrics.map((metric) => {
    const body = {
      schema_version: 1 as const,
      measurement_id: idFromSha256("TPM", sha256Hex(`${input.operationId}\0${workload.key}\0${metric.key}`)),
      goal_id: input.goalId,
      work_cell_id: input.workCellId,
      performance_contract_sha256: contractSha256,
      phase: input.phase,
      operation_id: input.operationId,
      command_sha256: sha256Hex(input.command),
      output_sha256: input.outputSha256,
      workload_key: workload.key,
      metric_key: metric.key,
      value: parsed.metrics[metric.key]!,
      unit: metric.unit,
      environment_sha256: parsed.environmentSha256,
      sample_count: parsed.sampleCount,
      created_at_ms: input.createdAtMs,
    };
    return seal("PCH-TARGET-PERFORMANCE-MEASUREMENT-V1", body);
  });
}

function measurementRoot(records: readonly TargetPerformanceMeasurementRecord[]): string {
  return canonicalJsonSha256([...records].sort((a, b) => a.measurement_id.localeCompare(b.measurement_id))
    .map((entry) => entry.record_sha256));
}

export function evaluatePerformancePhase(input: {
  readonly goalId: string;
  readonly workCellId: string;
  readonly contract: TargetPerformanceContract;
  readonly phase: TargetPerformancePhase;
  readonly measurements: readonly TargetPerformanceMeasurementRecord[];
  readonly baseline: readonly TargetPerformanceMeasurementRecord[];
  readonly createdAtMs: number;
}): TargetPerformanceVerdictRecord {
  const baselinePhase = input.phase === "BASELINE" || input.phase === "BASELINE_PROFILE";
  const expectedRoles = baselinePhase ? new Set(["PRIMARY", "REGRESSION", "HOLDOUT"])
    : input.phase === "CANDIDATE" ? new Set(["PRIMARY", "REGRESSION"])
      : input.phase === "HOLDOUT" ? new Set(["HOLDOUT"]) : new Set(["REGRESSION"]);
  const expected = input.contract.metrics.flatMap((metric) => metric.workload_keys
    .map((key) => ({ metric, workload: input.contract.workloads.find((entry) => entry.key === key) }))
    .filter((entry) => entry.workload && expectedRoles.has(entry.workload.role)));
  const current = new Map(input.measurements.map((entry) => [`${entry.workload_key}\0${entry.metric_key}`, entry]));
  const baseline = new Map(input.baseline.map((entry) => [`${entry.workload_key}\0${entry.metric_key}`, entry]));
  const reasons: string[] = [];
  for (const pair of expected) {
    const key = `${pair.workload!.key}\0${pair.metric.key}`;
    const measurement = current.get(key);
    if (!measurement) { reasons.push(`MISSING:${pair.workload!.key}:${pair.metric.key}`); continue; }
    if (baselinePhase) continue;
    const prior = baseline.get(key);
    if (!prior) { reasons.push(`BASELINE_MISSING:${pair.workload!.key}:${pair.metric.key}`); continue; }
    if (prior.environment_sha256 !== measurement.environment_sha256) {
      reasons.push(`ENVIRONMENT_DRIFT:${pair.workload!.key}:${pair.metric.key}`); continue;
    }
    if (prior.value === 0) { reasons.push(`ZERO_BASELINE:${pair.workload!.key}:${pair.metric.key}`); continue; }
    const improvement = pair.metric.direction === "LOWER"
      ? ((prior.value - measurement.value) / Math.abs(prior.value)) * 100
      : ((measurement.value - prior.value) / Math.abs(prior.value)) * 100;
    if (improvement < -pair.metric.maximum_regression_pct) {
      reasons.push(`REGRESSION:${pair.workload!.key}:${pair.metric.key}:${improvement.toFixed(3)}`);
    }
    if (pair.metric.role === "PRIMARY_GATE" && pair.workload!.role !== "REGRESSION"
      && pair.metric.minimum_improvement_pct !== null
      && improvement < pair.metric.minimum_improvement_pct) {
      reasons.push(`IMPROVEMENT:${pair.workload!.key}:${pair.metric.key}:${improvement.toFixed(3)}`);
    }
  }
  const currentRoot = measurementRoot(input.measurements);
  const baselineRoot = baselinePhase ? null : measurementRoot(input.baseline);
  const body = {
    schema_version: 1 as const,
    verdict_id: idFromSha256("TPV", canonicalJsonSha256({
      workCellId: input.workCellId, phase: input.phase, currentRoot, baselineRoot, reasons,
    })),
    goal_id: input.goalId,
    work_cell_id: input.workCellId,
    performance_contract_sha256: canonicalJsonSha256(input.contract),
    phase: input.phase,
    measurement_root_sha256: currentRoot,
    baseline_root_sha256: baselineRoot,
    verdict: reasons.length === 0 ? "PASS" as const : "FAIL" as const,
    reasons,
    created_at_ms: input.createdAtMs,
  };
  return seal("PCH-TARGET-PERFORMANCE-VERDICT-V1", body);
}
