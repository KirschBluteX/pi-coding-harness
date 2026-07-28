import { issue, validationResult, type ValidationIssue, type ValidationResult } from "../foundation/validation.js";

export type PerformanceMode = "BASELINE_GUARD" | "AUTO_GUARDED" | "REQUIRED" | "OFF_BY_USER";
export type ActivationBasis = "BASELINE_DEFAULT" | "USER_REQUEST" | "REQUIREMENT_ACCEPTANCE" | "OBSERVED_REGRESSION" | "CONFIG_OPT_IN";

export interface PerformanceWorkload {
  readonly id: string;
  readonly role: "PRIMARY" | "REGRESSION" | "HOLDOUT";
  readonly scenario: string;
  readonly dataset_or_fixture: string;
  readonly scale: string;
  readonly temperature: "COLD" | "WARM" | "BOTH";
  readonly provenance: string;
  readonly representativeness: string;
  readonly acceptance_ids: readonly string[];
}

export interface PerformanceMetric {
  readonly id: string;
  readonly role: "PRIMARY_GATE" | "REGRESSION_GATE" | "OBSERVATION";
  readonly name: string;
  readonly unit: string;
  readonly direction: "LOWER" | "HIGHER" | "EXACT";
  readonly aggregation: "SINGLE" | "COUNT" | "RATE" | "P50" | "P95" | "P99" | "MEAN" | "PAIRED_DELTA";
  readonly target: {
    readonly kind: "ABSOLUTE" | "RELATIVE_IMPROVEMENT" | "BASELINE_NON_REGRESSION" | "MAXIMIZE_WITHIN_BUDGET";
    readonly value: number | null;
    readonly relative_improvement_pct: number | null;
    readonly tolerance: number;
  };
  readonly workload_ids: readonly string[];
  readonly measurement_protocol: string;
}

export interface PerformanceContract {
  readonly schema_version: 3;
  readonly contract_id: string;
  readonly mode: PerformanceMode;
  readonly activation_basis: ActivationBasis;
  readonly opportunity_policy: "ROUTE_ONLY" | "STATIC_EVIDENCE" | "PROFILE_WHEN_JUSTIFIED";
  readonly opportunity_admission: {
    readonly allowed_sources: readonly ("USER_REQUIREMENT" | "OBSERVED_REGRESSION" | "EXISTING_PROFILE" | "STATIC_EVIDENCE" | "REPRODUCIBLE_TOOL_EVIDENCE")[];
    readonly scan_scope: "FROZEN_INCLUDE_ONLY";
    readonly require_measured_or_bounded_hotspot: true;
    readonly minimum_hotspot_fraction: number;
    readonly minimum_theoretical_speedup_pct: number;
    readonly end_to_end_metric_required: true;
    readonly unknown_action: "ADVICE_ONLY";
  };
  readonly project_scope: {
    readonly include: readonly string[];
    readonly exclude: readonly string[];
    readonly sensitive_path_policy: "EXCLUDE_UNLESS_EXPLICITLY_AUTHORIZED";
  };
  readonly workloads: readonly PerformanceWorkload[];
  readonly metrics: readonly PerformanceMetric[];
  readonly correctness_acceptance_ids: readonly string[];
  readonly experiment_budget: {
    readonly max_trials: number;
    readonly max_wall_time_ms: number;
    readonly max_user_blocking_ms: number;
    readonly allow_background: boolean;
  };
  readonly trial_protocol: {
    readonly min_pairs: number;
    readonly max_pairs: number;
    readonly order_policy: "RANDOMIZED_INTERLEAVED" | "ALTERNATING" | "PROJECT_NATIVE";
    readonly warmup_policy: "PROJECT_NATIVE" | "FIXED_DISCARDED" | "NONE_JUSTIFIED";
    readonly confidence_method: "PROJECT_NATIVE" | "PAIRED_BOOTSTRAP" | "PAIRED_NONPARAMETRIC";
    readonly confidence_level: number;
    readonly confidence_bound_required: true;
    readonly bootstrap_resamples: number;
    readonly random_seed: number;
    readonly minimum_practical_improvement_pct: number;
    readonly max_coefficient_of_variation: number | null;
    readonly stopping_rule: "FIXED_PAIRS" | "SEQUENTIAL_ALPHA_SPENDING" | "PROJECT_NATIVE_PREDECLARED";
    readonly outlier_policy: "KEEP_AND_REPORT" | "PROJECT_NATIVE_PREDECLARED";
    readonly environment_drift_action: "NEW_EPOCH" | "REJECT";
    readonly multiple_candidate_policy: "ONE_AT_A_TIME" | "CORRECTED_COMPARISON" | "PROJECT_NATIVE";
    readonly candidate_family_size: number;
    readonly holdout_policy: "REQUIRED" | "NOT_APPLICABLE_WITH_JUSTIFICATION" | "PROJECT_NATIVE_PREDECLARED";
    readonly holdout_justification: string | null;
    readonly holdout_waiver_promotion: "USER_DECISION_ONLY";
    readonly analysis_population: "ALL_PREDECLARED_VALID_PAIRS";
    readonly pair_exclusion_policy: "PREDECLARED_ONLY";
    readonly environment_fingerprint_fields: readonly string[];
    readonly automatic_benefit_horizon: {
      readonly required: boolean;
      readonly payback_metric_id: string | null;
      readonly max_payback_executions: number | null;
      readonly estimated_payback_executions: number | null;
      readonly basis: string;
    };
  };
  readonly regression_policy: {
    readonly correctness_first: true;
    readonly baseline_required_for_performance_affecting_stage: true;
    readonly paired_benchmark_required_for_optimization: true;
    readonly confidence_bound_required_for_promotion: true;
    readonly max_relative_regression_pct: number;
    readonly noisy_result_action: "NEED_MORE_EVIDENCE" | "REJECT";
  };
  readonly user_decision_id?: string | null;
}

function uniqueIds(values: readonly { readonly id: string }[], path: string, issues: ValidationIssue[]): Set<string> {
  const ids = new Set<string>();
  for (const value of values) {
    if (ids.has(value.id)) issues.push(issue("DUPLICATE_ID", path, `Duplicate id ${value.id}`));
    ids.add(value.id);
  }
  return ids;
}

function finite(value: number | null, path: string, issues: ValidationIssue[]): void {
  if (value !== null && !Number.isFinite(value)) issues.push(issue("NON_FINITE_NUMBER", path, "Value must be a finite JSON number or null"));
}

function validatePerformanceContractSemantics(contract: PerformanceContract, acceptanceIds?: ReadonlySet<string>): ValidationResult {
  const issues: ValidationIssue[] = [];
  if (contract.schema_version !== 3) issues.push(issue("SCHEMA_VERSION", "schema_version", "Expected performance contract schema version 3"));
  const workloadIds = uniqueIds(contract.workloads, "workloads", issues);
  const metricIds = uniqueIds(contract.metrics, "metrics", issues);
  const roles = new Set(contract.workloads.map((workload) => workload.role));

  if (contract.mode === "BASELINE_GUARD") {
    if (contract.activation_basis !== "BASELINE_DEFAULT") issues.push(issue("BASELINE_ACTIVATION", "activation_basis", "BASELINE_GUARD requires BASELINE_DEFAULT"));
    if (contract.opportunity_policy !== "ROUTE_ONLY") issues.push(issue("BASELINE_ROUTE_ONLY", "opportunity_policy", "BASELINE_GUARD cannot scan or profile"));
    if (contract.experiment_budget.max_trials !== 0) issues.push(issue("BASELINE_TRIALS", "experiment_budget.max_trials", "BASELINE_GUARD trial budget must be zero"));
  } else if (contract.mode === "AUTO_GUARDED" || contract.mode === "REQUIRED") {
    if (contract.activation_basis === "BASELINE_DEFAULT") issues.push(issue("ACTIVATION_BASIS", "activation_basis", `${contract.mode} requires explicit activation evidence`));
    if (contract.experiment_budget.max_trials < 1) issues.push(issue("TRIAL_BUDGET", "experiment_budget.max_trials", `${contract.mode} requires a bounded positive trial budget`));
    if (!roles.has("PRIMARY") || !roles.has("REGRESSION")) issues.push(issue("WORKLOAD_ROLES", "workloads", "Activated performance work requires PRIMARY and REGRESSION workloads"));
    if (contract.trial_protocol.holdout_policy === "REQUIRED" && !roles.has("HOLDOUT")) issues.push(issue("HOLDOUT_REQUIRED", "workloads", "Automatic promotion requires a HOLDOUT frozen in the RequirementPackage"));
    if (contract.trial_protocol.automatic_benefit_horizon.required) {
      const horizon = contract.trial_protocol.automatic_benefit_horizon;
      if (horizon.payback_metric_id === null || !metricIds.has(horizon.payback_metric_id)) issues.push(issue("PAYBACK_METRIC", "trial_protocol.automatic_benefit_horizon.payback_metric_id", "Payback metric must reference a declared metric"));
      if (horizon.max_payback_executions === null || horizon.estimated_payback_executions === null || horizon.estimated_payback_executions > horizon.max_payback_executions) {
        issues.push(issue("PAYBACK_HORIZON", "trial_protocol.automatic_benefit_horizon", "Estimated payback must fit the declared bounded horizon"));
      }
    }
  }

  if (contract.mode === "OFF_BY_USER" && !contract.user_decision_id) issues.push(issue("USER_DECISION_REQUIRED", "user_decision_id", "OFF_BY_USER requires a user decision receipt id"));
  if (contract.trial_protocol.min_pairs > contract.trial_protocol.max_pairs) issues.push(issue("PAIR_BOUNDS", "trial_protocol", "min_pairs cannot exceed max_pairs"));
  if (!Number.isSafeInteger(contract.trial_protocol.bootstrap_resamples) || contract.trial_protocol.bootstrap_resamples < 1_000) {
    issues.push(issue("BOOTSTRAP_RESAMPLES", "trial_protocol.bootstrap_resamples", "At least 1000 preregistered bootstrap resamples are required"));
  }
  if (!Number.isSafeInteger(contract.trial_protocol.random_seed) || contract.trial_protocol.random_seed < 0) {
    issues.push(issue("RANDOM_SEED", "trial_protocol.random_seed", "A non-negative preregistered integer random seed is required"));
  }
  if (contract.trial_protocol.candidate_family_size > 3) issues.push(issue("CANDIDATE_BOUND", "trial_protocol.candidate_family_size", "At most three candidates are permitted"));
  if (contract.trial_protocol.holdout_policy !== "REQUIRED" && !contract.trial_protocol.holdout_justification) issues.push(issue("HOLDOUT_JUSTIFICATION", "trial_protocol.holdout_justification", "A holdout waiver requires a justification"));

  for (const [index, workload] of contract.workloads.entries()) {
    for (const acceptanceId of workload.acceptance_ids) {
      if (acceptanceIds && !acceptanceIds.has(acceptanceId)) issues.push(issue("UNKNOWN_ACCEPTANCE", `workloads[${index}].acceptance_ids`, `Unknown acceptance ${acceptanceId}`));
    }
  }
  for (const [index, metric] of contract.metrics.entries()) {
    finite(metric.target.value, `metrics[${index}].target.value`, issues);
    finite(metric.target.relative_improvement_pct, `metrics[${index}].target.relative_improvement_pct`, issues);
    finite(metric.target.tolerance, `metrics[${index}].target.tolerance`, issues);
    for (const workloadId of metric.workload_ids) if (!workloadIds.has(workloadId)) issues.push(issue("UNKNOWN_WORKLOAD", `metrics[${index}].workload_ids`, `Unknown workload ${workloadId}`));
    if (metric.target.kind === "ABSOLUTE" && metric.target.value === null) issues.push(issue("ABSOLUTE_TARGET", `metrics[${index}].target.value`, "ABSOLUTE target requires a value"));
    if (metric.target.kind === "RELATIVE_IMPROVEMENT" && !(typeof metric.target.relative_improvement_pct === "number" && metric.target.relative_improvement_pct > 0)) issues.push(issue("RELATIVE_TARGET", `metrics[${index}].target.relative_improvement_pct`, "RELATIVE_IMPROVEMENT requires a positive percentage"));
  }
  for (const acceptanceId of contract.correctness_acceptance_ids) {
    if (acceptanceIds && !acceptanceIds.has(acceptanceId)) issues.push(issue("UNKNOWN_CORRECTNESS_ACCEPTANCE", "correctness_acceptance_ids", `Unknown acceptance ${acceptanceId}`));
  }
  finite(contract.opportunity_admission.minimum_hotspot_fraction, "opportunity_admission.minimum_hotspot_fraction", issues);
  finite(contract.opportunity_admission.minimum_theoretical_speedup_pct, "opportunity_admission.minimum_theoretical_speedup_pct", issues);
  finite(contract.trial_protocol.confidence_level, "trial_protocol.confidence_level", issues);
  return validationResult(issues);
}

export function validatePerformanceContract(contract: PerformanceContract, acceptanceIds?: ReadonlySet<string>): ValidationResult {
  try {
    return validatePerformanceContractSemantics(contract, acceptanceIds);
  } catch (error) {
    return validationResult([issue("STRUCTURE_INVALID", "performance_contract", error instanceof Error ? error.message : "Malformed performance contract")]);
  }
}
