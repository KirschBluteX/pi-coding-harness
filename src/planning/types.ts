import type { PerformanceContract } from "../performance/contract.js";

export type SpecificationRoute = "BYPASS" | "BUILD_LIGHT" | "TASK_SPEC" | "PRD";
export type GoalIntent = "PLAN_ONLY" | "BUILD" | "PLAN_THEN_BUILD";
export type Impact = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type AssumptionStatus = "UNVERIFIED" | "SUPPORTED" | "REFUTED";

export interface IntakeFacts {
  readonly requiresPersistentWork: boolean;
  readonly objectiveClear: boolean;
  readonly filesKnown: boolean;
  readonly acceptanceClear: boolean;
  readonly lowRisk: boolean;
  readonly expectedSteps: number;
  readonly productOrUserFlow: boolean;
  readonly crossModule: boolean;
  readonly highRework: boolean;
  readonly highImpactUnknowns: number;
  readonly irreversibleOrSensitive: boolean;
  readonly semanticAssessment: "UNRESOLVED" | "USER_CONFIRMED" | "CONTRACT_DERIVED";
  readonly structuralComplexity: 1 | 2 | 3 | 4;
}

export interface SpecificationClassification {
  readonly route: SpecificationRoute;
  readonly reasonCodes: readonly string[];
  readonly additionalModelRequests: 0;
}

export interface RequirementPackage {
  readonly $schema?: string;
  readonly schema_version: 1;
  readonly package: {
    readonly requirement_id: string;
    readonly goal_id: string;
    readonly goal_version: number;
    readonly revision: number;
    readonly parent_requirement_id?: string | null;
    readonly profile: "TASK_SPEC" | "PRD";
    readonly status: "DRAFT" | "VALIDATED" | "FROZEN" | "SUPERSEDED";
    readonly created_at: string;
    readonly source_intake_sha256: string;
  };
  readonly requirements: {
    readonly problem: string;
    readonly target_users: readonly string[];
    readonly desired_outcomes: readonly { readonly id: string; readonly statement: string; readonly measure: string }[];
    readonly scope: readonly string[];
    readonly non_goals: readonly string[];
    readonly functional_requirements: readonly { readonly id: string; readonly statement: string; readonly priority: "MUST" | "SHOULD" | "COULD"; readonly rationale: string; readonly acceptance_ids: readonly string[] }[];
    readonly quality_requirements: readonly { readonly id: string; readonly class: string; readonly statement: string; readonly threshold: { readonly metric: string; readonly operator: string; readonly target: number | string | boolean | null; readonly unit: string; readonly aggregation: string; readonly tolerance: number; readonly evidence_method: string }; readonly acceptance_ids: readonly string[] }[];
    readonly user_flows: readonly { readonly id: string; readonly actor: string; readonly trigger: string; readonly steps: readonly string[]; readonly success: string; readonly failure_paths: readonly string[] }[];
    readonly constraints: readonly { readonly id: string; readonly statement: string; readonly source: string; readonly hard: boolean }[];
    readonly assumptions: readonly { readonly id: string; readonly statement: string; readonly impact: Impact; readonly status: AssumptionStatus; readonly verification: string }[];
    readonly open_decisions: readonly { readonly id: string; readonly question: string; readonly materiality: "LOW" | "MEDIUM" | "HIGH"; readonly recommended_option: string; readonly blocking: boolean }[];
    readonly acceptance_criteria: readonly { readonly id: string; readonly statement: string; readonly evidence: string; readonly required: true }[];
    readonly performance_contract: PerformanceContract;
    readonly response_requirements: { readonly default_detail: "MINIMAL_SUFFICIENT" | "BALANCED" | "DETAILED"; readonly artifact_policy: "WHEN_LARGE" | "ARTIFACT_FIRST" | "USER_DECIDES"; readonly preserve_user_requested_format: true; readonly required_final_slots: readonly string[] };
    readonly change_policy: string;
  };
  readonly integrity: {
    readonly canonicalization: "PCH-CJ1";
    readonly requirements_payload_sha256: string;
    readonly artifact_sha256: string;
  };
}

export interface ResourceEstimate {
  readonly value: number | null;
  readonly unit: string;
  readonly confidence: "MEASURED" | "DERIVED" | "ESTIMATED" | "UNKNOWN";
  readonly basis: string;
}

export interface RouteCandidate {
  readonly id: string;
  readonly description: string;
  readonly hard_gate_pass: boolean;
  readonly acceptance_reachability: "PROVEN" | "LIKELY" | "UNKNOWN" | "UNREACHABLE";
  readonly evidence_strength: "MEASURED" | "DERIVED" | "DOCUMENTED" | "ESTIMATED" | "UNKNOWN";
  readonly risk: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  readonly reversibility: "REVERSIBLE" | "FORWARD_ONLY" | "IRREVERSIBLE";
  readonly performance_estimates: readonly { readonly metric_id: string; readonly value: number | null; readonly unit: string; readonly confidence: ResourceEstimate["confidence"]; readonly basis: string }[];
  readonly resource_estimates: {
    readonly provider_requests: ResourceEstimate;
    readonly uncached_input_tokens: ResourceEstimate;
    readonly generated_output_tokens: ResourceEstimate;
    readonly tool_context_tokens: ResourceEstimate;
    readonly user_wait_ms: ResourceEstimate;
    readonly interruption_cost: ResourceEstimate;
  };
  readonly disqualifiers: readonly string[];
}

export interface PlanStage {
  readonly id: string;
  readonly logical_key: string;
  readonly title: string;
  readonly detail_horizon: "CURRENT" | "NEAR" | "LATER";
  readonly dependencies: readonly string[];
  readonly entry_criteria: readonly string[];
  readonly outputs: readonly string[];
  readonly files: readonly { readonly path: string; readonly action: "CREATE" | "MODIFY" | "DELETE" | "VERIFY"; readonly purpose: string }[];
  readonly interfaces: readonly string[];
  readonly data_migrations: readonly string[];
  readonly failure_routes: readonly string[];
  readonly tests: readonly string[];
  readonly performance_contract: {
    readonly mode: "BYPASS" | "GUARDRAIL" | "OPTIMIZE";
    readonly requirement_metric_ids: readonly string[];
    readonly budgets: readonly { readonly metric: string; readonly operator: string; readonly threshold: number | null; readonly unit: string; readonly aggregation: string; readonly scope: "RUNTIME_OVERHEAD" | "TARGET_PROJECT" | "CACHE" | "OUTPUT"; readonly evidence: string }[];
    readonly opportunity_scan: "NONE" | "STATIC_ONLY" | "PROFILE_WHEN_JUSTIFIED";
    readonly baseline_receipt_required: boolean;
    readonly paired_benchmark_required: boolean;
    readonly max_trials: number;
    readonly exit_policy: "NON_REGRESSION" | "MEET_TARGET" | "BEST_WITHIN_BUDGET";
  };
  readonly review_gates: readonly string[];
  readonly exit_criteria: readonly string[];
  readonly next_stage_ids: readonly string[];
}

export interface PlanPackage {
  readonly $schema?: string;
  readonly schema_version: 2;
  readonly package: {
    readonly plan_id: string;
    readonly goal_id: string;
    readonly goal_version: number;
    readonly revision: number;
    readonly parent_plan_id?: string | null;
    readonly intent: GoalIntent;
    readonly status: "DRAFT" | "VALIDATED" | "FROZEN" | "SUPERSEDED";
    readonly created_at: string;
    readonly source_intake_sha256: string;
    readonly requirement_id: string;
    readonly requirement_payload_sha256: string;
    readonly supersedes_plan_id?: string | null;
  };
  readonly plan: {
    readonly objective: string;
    readonly planning_depth: "LIGHT" | "STANDARD" | "FULL";
    readonly constraints: readonly { readonly id: string; readonly text: string; readonly source: string; readonly hard: boolean }[];
    readonly assumptions: readonly { readonly id: string; readonly statement: string; readonly status: AssumptionStatus; readonly impact: Impact; readonly verification: string; readonly evidence_sha256?: string | null }[];
    readonly acceptance_coverage: readonly { readonly criterion_id: string; readonly stage_ids: readonly string[]; readonly proof: string }[];
    readonly stages: readonly PlanStage[];
    readonly route_selection: { readonly mode: "FAST_SINGLE" | "BOUNDED_COMPARE" | "MEASURED_REPLAN"; readonly objective_order: readonly string[]; readonly candidates: readonly RouteCandidate[]; readonly selected_candidate_id: string; readonly selection_reason: string; readonly fallback_candidate_id: string | null };
    readonly response_policy: { readonly default_class: "ACK" | "QUESTION" | "STATUS" | "RESULT" | "AUDIT" | "USER_FORMAT"; readonly artifact_first: boolean; readonly ui_first_progress: boolean; readonly suppress_duplicate_progress: boolean; readonly stable_policy_in_prefix: true; readonly directive_placement: "STABLE_POLICY_ONLY" | "DYNAMIC_SUFFIX"; readonly adaptive_text_budget: true; readonly history_rewrite_policy: "GENERATION_BOUNDARY_ONLY"; readonly goal_level_rebound_guard: true; readonly generated_content_accounting: "PROVIDER_OUTPUT_WITH_REASONING_AND_TOOL_ARGUMENT_ATTRIBUTION"; readonly tool_result_projection_policy: "EVIDENCE_LIVENESS_ROUTED"; readonly preserve_user_requested_format: true; readonly hard_truncation_allowed: false; readonly rewrite_request_allowed: false };
    readonly risk_summary: readonly { readonly id: string; readonly description: string; readonly severity: Impact; readonly mitigation: string; readonly owner_stage_id: string }[];
    readonly build_entry_gate: { readonly required_receipt_types: readonly string[]; readonly required_review_gates: readonly string[]; readonly all_acceptance_covered: true; readonly user_decision_required?: boolean };
  };
  readonly integrity: { readonly canonicalization: "PCH-CJ1"; readonly requirement_payload_sha256: string; readonly plan_payload_sha256: string; readonly artifact_sha256: string };
}

export type StageRuntimeStatus = "PLANNED" | "READY" | "RUNNING" | "WAITING_USER" | "BLOCKED" | "RECOVERING" | "NEEDS_RECONCILIATION" | "SUCCEEDED" | "FAILED" | "SKIPPED" | "INVALIDATED";

export interface PlanningSnapshot {
  readonly goalId: string;
  readonly goalVersion: number;
  readonly requirement: RequirementPackage;
  readonly plan: PlanPackage;
  readonly stageStatuses: Readonly<Record<string, StageRuntimeStatus>>;
  readonly invalidatedIds: ReadonlySet<string>;
  readonly blockingDecisionIds: readonly string[];
  readonly unknownEffectIds: readonly string[];
  readonly environmentMatches: boolean;
  readonly leaseValid: boolean;
  readonly failureOccurrences: Readonly<Record<string, number>>;
}
