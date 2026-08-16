import { matchesGlob } from "node:path";
import { canonicalJsonSha256 } from "../authority/canonical-json.js";
import { idFromSha256 } from "../foundation/ids.js";
import type { GoalContractRecord, WorkCellRecord } from "../task-flow/domain.js";

export type TargetPerformanceDemand = "NONE" | "NON_REGRESSION" | "OPTIMIZE";
export type TargetPerformancePhase = "BASELINE" | "BASELINE_PROFILE" | "CANDIDATE" | "REGRESSION" | "HOLDOUT";

export interface TargetPerformanceWorkload {
  readonly key: string;
  readonly role: "PRIMARY" | "REGRESSION" | "HOLDOUT";
  readonly command: string;
  readonly fixture_ref: string;
  readonly representativeness: string;
}

export interface TargetPerformanceMetric {
  readonly key: string;
  readonly role: "PRIMARY_GATE" | "REGRESSION_GATE";
  readonly unit: string;
  readonly direction: "LOWER" | "HIGHER";
  readonly aggregation: "P50" | "P95" | "P99" | "MEAN" | "RATE";
  readonly workload_keys: readonly string[];
  readonly minimum_improvement_pct: number | null;
  readonly maximum_regression_pct: number;
}

export interface TargetPerformanceContract {
  readonly schema_version: 1;
  readonly contract_id: string;
  readonly mode: "NON_REGRESSION" | "OPTIMIZE";
  readonly activation_basis: "USER_REQUEST" | "ACCEPTANCE_CONTRACT";
  readonly scope: { readonly include: readonly string[]; readonly exclude: readonly string[] };
  readonly workloads: readonly TargetPerformanceWorkload[];
  readonly metrics: readonly TargetPerformanceMetric[];
  readonly correctness_obligation_keys: readonly string[];
  readonly opportunity_gate: {
    readonly minimum_hotspot_fraction: number;
    readonly minimum_practical_improvement_pct: number;
    readonly unknown_action: "ADVICE_ONLY";
  };
  readonly budget: {
    readonly max_candidates: number;
    readonly max_wall_time_ms: number;
    readonly max_user_blocking_ms: number;
  };
  readonly holdout_policy: "REQUIRED" | "OPTIONAL";
  readonly rollback_required: true;
}

const targetPerformanceDirective = /\bTargetPerformance\s*=\s*(OPTIMIZE|NON_REGRESSION)\b/iu;

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, maximum = 8_192): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be text`);
  const normalized = value.normalize("NFC").trim();
  if (!normalized || normalized.length > maximum) throw new TypeError(`${label} must be bounded nonempty text`);
  return normalized;
}

function finite(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  const parsed = finite(value, label, minimum, maximum);
  if (!Number.isSafeInteger(parsed)) throw new TypeError(`${label} must be an integer`);
  return parsed;
}

function list(value: unknown, label: string, maximum: number): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum) throw new TypeError(`${label} must contain 1..${maximum} entries`);
  const result = value.map((entry, index) => text(entry, `${label}[${index}]`, 4_096));
  if (new Set(result).size !== result.length) throw new TypeError(`${label} contains duplicates`);
  return result;
}

function optionalList(value: unknown, label: string, maximum: number): string[] {
  if (!Array.isArray(value) || value.length > maximum) throw new TypeError(`${label} must contain at most ${maximum} entries`);
  const result = value.map((entry, index) => text(entry, `${label}[${index}]`, 4_096));
  if (new Set(result).size !== result.length) throw new TypeError(`${label} contains duplicates`);
  return result;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new TypeError(`${label} is invalid`);
  return value as T;
}

function semanticKey(value: unknown, label: string): string {
  const key = text(value, label, 160);
  if (!/^[\p{L}\p{N}][\p{L}\p{N}_.:-]*$/u.test(key)) throw new TypeError(`${label} is not a stable key`);
  return key;
}

function normalizedPattern(value: string, label: string): string {
  const pattern = value.replaceAll("\\", "/").replace(/^\.\//u, "");
  if (!pattern || pattern.startsWith("/") || /^[A-Za-z]:\//u.test(pattern)
    || pattern.split("/").some((part) => part === ".." || part === "")) {
    throw new TypeError(`${label} must be a workspace-relative path or glob`);
  }
  return pattern;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    const missing = wanted.filter((key) => !actual.includes(key));
    const extra = actual.filter((key) => !wanted.includes(key));
    throw new TypeError(`${label} fields are invalid; missing=[${missing.join(",")}] extra=[${extra.join(",")}]`);
  }
}

export function targetPerformanceDemand(textValue: string): TargetPerformanceDemand {
  const normalized = textValue.normalize("NFC");
  const directive = normalized.match(targetPerformanceDirective)?.[1]?.toUpperCase();
  if (directive === "OPTIMIZE" || directive === "NON_REGRESSION") return directive;
  return "NONE";
}

function parseWorkloads(value: unknown): TargetPerformanceWorkload[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 12) throw new TypeError("performance workloads require 2..12 entries");
  const workloads = value.map((entry, index) => {
    const row = object(entry, `performance workloads[${index}]`);
    exactKeys(row, ["key", "role", "command", "fixture_ref", "representativeness"], `performance workloads[${index}]`);
    return {
      key: semanticKey(row.key, `performance workloads[${index}].key`),
      role: oneOf(row.role, ["PRIMARY", "REGRESSION", "HOLDOUT"] as const, `performance workloads[${index}].role`),
      command: text(row.command, `performance workloads[${index}].command`, 8_192),
      fixture_ref: text(row.fixture_ref, `performance workloads[${index}].fixture_ref`, 4_096),
      representativeness: text(row.representativeness, `performance workloads[${index}].representativeness`, 4_096),
    };
  });
  if (new Set(workloads.map((entry) => entry.key)).size !== workloads.length) throw new TypeError("performance workload keys must be unique");
  if (new Set(workloads.map((entry) => `${entry.role}\0${entry.fixture_ref}`)).size !== workloads.length) {
    throw new TypeError("performance workload roles require distinct frozen fixtures");
  }
  return workloads;
}

function parseMetrics(value: unknown, workloadKeys: ReadonlySet<string>): TargetPerformanceMetric[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 12) throw new TypeError("performance metrics require 1..12 entries");
  const metrics = value.map((entry, index) => {
    const row = object(entry, `performance metrics[${index}]`);
    exactKeys(row, ["key", "role", "unit", "direction", "aggregation", "workload_keys", "minimum_improvement_pct", "maximum_regression_pct"], `performance metrics[${index}]`);
    const workload_keys = list(row.workload_keys, `performance metrics[${index}].workload_keys`, 12)
      .map((key) => semanticKey(key, `performance metrics[${index}].workload_keys`));
    if (workload_keys.some((key) => !workloadKeys.has(key))) throw new TypeError(`performance metric ${index} references an unknown workload`);
    return {
      key: semanticKey(row.key, `performance metrics[${index}].key`),
      role: oneOf(row.role, ["PRIMARY_GATE", "REGRESSION_GATE"] as const, `performance metrics[${index}].role`),
      unit: text(row.unit, `performance metrics[${index}].unit`, 64),
      direction: oneOf(row.direction, ["LOWER", "HIGHER"] as const, `performance metrics[${index}].direction`),
      aggregation: oneOf(row.aggregation, ["P50", "P95", "P99", "MEAN", "RATE"] as const, `performance metrics[${index}].aggregation`),
      workload_keys,
      minimum_improvement_pct: row.minimum_improvement_pct === null ? null
        : finite(row.minimum_improvement_pct, `performance metrics[${index}].minimum_improvement_pct`, 0, 100),
      maximum_regression_pct: finite(row.maximum_regression_pct, `performance metrics[${index}].maximum_regression_pct`, 0, 100),
    };
  });
  if (new Set(metrics.map((entry) => entry.key)).size !== metrics.length) throw new TypeError("performance metric keys must be unique");
  return metrics;
}

function parseContract(value: unknown, contractId: string, obligationKeys: ReadonlySet<string>): TargetPerformanceContract {
  const raw = object(value, "acceptance_policy.performance_contract");
  const expected = [
    "schema_version", "mode", "activation_basis", "scope", "workloads", "metrics",
    "correctness_obligation_keys", "opportunity_gate", "budget", "holdout_policy", "rollback_required",
  ];
  const withoutDerivedId = Object.fromEntries(Object.entries(raw).filter(([key]) => key !== "contract_id"));
  exactKeys(withoutDerivedId, expected, "performance contract");
  if (raw.schema_version !== 1) throw new TypeError("performance contract schema_version must be 1");
  const mode = oneOf(raw.mode, ["NON_REGRESSION", "OPTIMIZE"] as const, "performance contract mode");
  const scope = object(raw.scope, "performance contract scope");
  exactKeys(scope, ["include", "exclude"], "performance contract scope");
  const include = list(scope.include, "performance contract scope.include", 32).map((entry, index) => normalizedPattern(entry, `scope.include[${index}]`));
  const exclude = optionalList(scope.exclude, "performance contract scope.exclude", 32).map((entry, index) => normalizedPattern(entry, `scope.exclude[${index}]`));
  const workloads = parseWorkloads(raw.workloads);
  const workloadKeys = new Set(workloads.map((entry) => entry.key));
  const metrics = parseMetrics(raw.metrics, workloadKeys);
  const correctness = list(raw.correctness_obligation_keys, "performance correctness_obligation_keys", 256)
    .map((key) => semanticKey(key, "performance correctness obligation"));
  if (correctness.some((key) => !obligationKeys.has(key))) throw new TypeError("performance contract references an unknown correctness obligation");
  const gate = object(raw.opportunity_gate, "performance opportunity_gate");
  exactKeys(gate, ["minimum_hotspot_fraction", "minimum_practical_improvement_pct", "unknown_action"], "performance opportunity_gate");
  const budget = object(raw.budget, "performance budget");
  exactKeys(budget, ["max_candidates", "max_wall_time_ms", "max_user_blocking_ms"], "performance budget");
  const roles = new Set(workloads.map((entry) => entry.role));
  if (!roles.has("PRIMARY") || !roles.has("REGRESSION")) throw new TypeError("performance contract requires PRIMARY and REGRESSION workloads");
  if (mode === "OPTIMIZE" && !roles.has("HOLDOUT")) throw new TypeError("performance optimization requires a frozen HOLDOUT workload");
  if (mode === "OPTIMIZE" && !metrics.some((entry) => entry.role === "PRIMARY_GATE" && (entry.minimum_improvement_pct ?? 0) > 0)) {
    throw new TypeError("performance optimization requires a positive practical improvement gate");
  }
  const holdoutPolicy = oneOf(raw.holdout_policy, ["REQUIRED", "OPTIONAL"] as const, "performance holdout_policy");
  if (mode === "OPTIMIZE" && holdoutPolicy !== "REQUIRED") throw new TypeError("performance optimization requires HOLDOUT policy REQUIRED");
  if (raw.rollback_required !== true) throw new TypeError("performance candidate rollback must be required");
  return {
    schema_version: 1,
    contract_id: idFromSha256("PERFORMANCE", canonicalJsonSha256({ goalContractId: contractId, contract: raw })),
    mode,
    activation_basis: oneOf(raw.activation_basis, ["USER_REQUEST", "ACCEPTANCE_CONTRACT"] as const, "performance activation_basis"),
    scope: { include, exclude }, workloads, metrics, correctness_obligation_keys: correctness,
    opportunity_gate: {
      minimum_hotspot_fraction: finite(gate.minimum_hotspot_fraction, "performance minimum_hotspot_fraction", 0.001, 1),
      minimum_practical_improvement_pct: finite(gate.minimum_practical_improvement_pct, "performance minimum_practical_improvement_pct", 0.01, 100),
      unknown_action: oneOf(gate.unknown_action, ["ADVICE_ONLY"] as const, "performance unknown_action"),
    },
    budget: {
      max_candidates: integer(budget.max_candidates, "performance max_candidates", 1, 3),
      max_wall_time_ms: integer(budget.max_wall_time_ms, "performance max_wall_time_ms", 1_000, 3_600_000),
      max_user_blocking_ms: integer(budget.max_user_blocking_ms, "performance max_user_blocking_ms", 0, 600_000),
    },
    holdout_policy: holdoutPolicy, rollback_required: true,
  };
}

export function normalizeTargetPerformanceAcceptancePolicy(input: {
  readonly objective: string;
  readonly contractId: string;
  readonly obligationKeys: readonly string[];
  readonly acceptancePolicy: Readonly<Record<string, unknown>> | undefined;
}): Readonly<Record<string, unknown>> {
  const policy = input.acceptancePolicy === undefined ? { all_must: true } : object(input.acceptancePolicy, "acceptance_policy");
  const demand = targetPerformanceDemand(input.objective);
  const supplied = policy.performance_contract;
  if (supplied === undefined) {
    if (demand !== "NONE") throw new TypeError(`Explicit target-performance task requires acceptance_policy.performance_contract (${demand})`);
    return policy;
  }
  let contract: TargetPerformanceContract;
  try {
    contract = parseContract(supplied, input.contractId, new Set(input.obligationKeys));
  } catch (error) {
    if (demand !== "NONE") throw error;
    const ordinaryPolicy = Object.fromEntries(Object.entries(policy)
      .filter(([key]) => key !== "performance_contract"));
    return {
      ...ordinaryPolicy,
      performance_contract_disposition: "IGNORED_MALFORMED_WITHOUT_EXPLICIT_DEMAND",
    };
  }
  if (demand === "OPTIMIZE" && contract.mode !== "OPTIMIZE") throw new TypeError("Performance optimization objective requires mode OPTIMIZE");
  return { ...policy, performance_contract: contract };
}

export function targetPerformanceContract(contract: GoalContractRecord): TargetPerformanceContract | null {
  const value = contract.acceptance_policy.performance_contract;
  return value === undefined ? null : value as unknown as TargetPerformanceContract;
}

export function targetPerformancePhase(cell: WorkCellRecord): TargetPerformancePhase | null {
  const phase = cell.budget.performance_phase;
  return typeof phase === "string" && ["BASELINE", "BASELINE_PROFILE", "CANDIDATE", "REGRESSION", "HOLDOUT"].includes(phase)
    ? phase as TargetPerformancePhase : null;
}

function pathInScope(pathValue: string, contract: TargetPerformanceContract): boolean {
  const path = normalizedPattern(pathValue, "performance WorkCell scope");
  return contract.scope.include.some((pattern) => matchesGlob(path, pattern))
    && !contract.scope.exclude.some((pattern) => matchesGlob(path, pattern));
}

function oracleCommands(cell: WorkCellRecord): ReadonlySet<string> {
  const values = typeof cell.oracle.command === "string" ? [cell.oracle.command]
    : Array.isArray(cell.oracle.commands) ? cell.oracle.commands : [];
  return new Set(values.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.normalize("NFC").trim()));
}

function requireCommands(cell: WorkCellRecord, workloads: readonly TargetPerformanceWorkload[], label: string): void {
  const commands = oracleCommands(cell);
  if (commands.size === 0 || workloads.some((workload) => !commands.has(workload.command))) {
    throw new TypeError(`${label} oracle must execute every frozen workload command assigned to that phase`);
  }
}

export function assertTargetPerformanceRoute(contract: GoalContractRecord, cells: readonly WorkCellRecord[]): void {
  const performance = targetPerformanceContract(contract);
  const phases = cells.map(targetPerformancePhase);
  if (!performance) {
    if (phases.some((phase) => phase !== null)) throw new TypeError("Performance phases require a frozen target-performance contract");
    return;
  }
  const required: readonly TargetPerformancePhase[] = performance.mode === "OPTIMIZE"
    ? ["BASELINE_PROFILE", "CANDIDATE", "HOLDOUT"]
    : ["BASELINE", "CANDIDATE", "REGRESSION"];
  if (cells.length !== required.length || phases.some((phase, index) => phase !== required[index])) {
    throw new TypeError(`Target-performance route must use ${required.join(" -> ")} exactly`);
  }
  const [baseline, candidate, final] = cells as unknown as readonly [WorkCellRecord, WorkCellRecord, WorkCellRecord];
  if (baseline.write_roots.length > 0 || final.write_roots.length > 0) throw new TypeError("Baseline/profile and final regression/holdout phases cannot mutate target files");
  if (candidate.write_roots.length === 0 || !candidate.reversible) throw new TypeError("Performance candidate phase requires reversible bounded writes");
  if (candidate.write_roots.some((path) => !pathInScope(path, performance))) throw new TypeError("Performance candidate writes escape the frozen performance scope");
  if (candidate.dependencies.length !== 1 || candidate.dependencies[0] !== baseline.work_cell_id
    || final.dependencies.length !== 1 || final.dependencies[0] !== candidate.work_cell_id) {
    throw new TypeError("Target-performance phase dependencies must preserve baseline-before-candidate-before-final order");
  }
  const baselineWorkloads = performance.workloads;
  const nonHoldout = performance.workloads.filter((entry) => entry.role !== "HOLDOUT");
  const finalWorkloads = performance.mode === "OPTIMIZE"
    ? performance.workloads.filter((entry) => entry.role === "HOLDOUT")
    : performance.workloads.filter((entry) => entry.role === "REGRESSION");
  requireCommands(baseline, baselineWorkloads, "Baseline/profile");
  requireCommands(candidate, nonHoldout, "Candidate");
  requireCommands(final, finalWorkloads, performance.mode === "OPTIMIZE" ? "Holdout" : "Regression");
  const contractSha256 = canonicalJsonSha256(performance);
  for (const cell of cells) {
    if (cell.budget.performance_contract_sha256 !== contractSha256) throw new TypeError("Performance WorkCell contract binding is missing");
  }
}

export function bindTargetPerformanceBudget(
  budget: Readonly<Record<string, unknown>> | undefined,
  contract: GoalContractRecord,
): Readonly<Record<string, unknown>> {
  const normalized = budget ?? { max_attempts: 2 };
  const performance = targetPerformanceContract(contract);
  if (!performance) return normalized;
  if (typeof normalized.performance_phase !== "string") throw new TypeError("Every target-performance WorkCell requires budget.performance_phase");
  return { ...normalized, performance_contract_sha256: canonicalJsonSha256(performance) };
}

export function targetPerformancePrompt(contract: GoalContractRecord | null, objective: string): string | null {
  if (!contract) {
    const demand = targetPerformanceDemand(objective);
    return demand === "NONE" ? null
      : `TargetPerformance=${demand}; freeze a compact acceptance_policy.performance_contract with scoped workloads, metrics, budgets, correctness obligations and rollback.`;
  }
  const performance = targetPerformanceContract(contract);
  if (!performance) return null;
  const phases = performance.mode === "OPTIMIZE" ? "BASELINE_PROFILE -> CANDIDATE -> HOLDOUT" : "BASELINE -> CANDIDATE -> REGRESSION";
  return `TargetPerformance=${performance.mode}; route exactly ${phases}; commands must be project-local frozen oracles and add no model request. Every workload command must print one bounded line PCH_BENCHMARK_RESULT_V1={"schema_version":1,"workload_key":"<key>","environment_sha256":"<64 hex>","sample_count":<n>,"metrics":{"<metric key>":<finite number>}}.`;
}
