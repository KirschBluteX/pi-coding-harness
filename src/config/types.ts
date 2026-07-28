export type RequirementProfile = "AUTO" | "TASK_SPEC" | "PRD";
export type Intent = "AUTO" | "PLAN_ONLY" | "BUILD" | "PLAN_THEN_BUILD";
export type PlanningDepth = "AUTO" | "BYPASS" | "LIGHT" | "STANDARD" | "FULL";
export type SafeDefaultPolicy = "LOW_RISK_ONLY" | "NEVER";
export type OptionalFallback = "BASELINE" | "EMPTY_OPTIONAL_PROJECTION" | "NATIVE_PI";
export type CacheArm = "C0" | "C1_PREFIX" | "C2_PROVIDER" | "C3_RETENTION" | "C4_COMBINED" | "AUTO";
export type HarnessWorkerRole = "PLANNER" | "EXPLORER" | "IMPLEMENTER" | "VERIFIER" | "INTEGRATOR";
export type WorkerThinkingLevel = "INHERIT_SUPERVISOR" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type WorkerRoleRuntimeConfig =
  | { readonly source: "INHERIT_SUPERVISOR" }
  | {
    readonly source: "PI_CONFIG";
    readonly provider_id: string;
    readonly model_id: string;
    readonly thinking_level: WorkerThinkingLevel;
  };

export interface WorkerRuntimePolicyConfig {
  readonly unavailable_policy: "INHERIT_SUPERVISOR";
  readonly roles: Readonly<Record<HarnessWorkerRole, WorkerRoleRuntimeConfig>>;
}

export interface CodingHarnessConfig {
  readonly schema_version: 1;
  readonly data?: {
    readonly root?: string;
    readonly require_local_filesystem?: true;
    readonly sqlite_busy_timeout_ms?: number;
  };
  readonly requirements: {
    readonly profile: RequirementProfile;
    readonly batch_questions: true;
    readonly max_initial_questions: number;
    readonly safe_default_policy: SafeDefaultPolicy;
  };
  readonly execution: {
    readonly default_intent: Intent;
    readonly planning_depth: PlanningDepth;
    readonly same_failure_retry_limit: number;
    readonly lease_ttl_ms: number;
    readonly worker_timeout_ms?: number;
    readonly max_parallel_workers?: number;
    readonly worker_runtime?: WorkerRuntimePolicyConfig;
  };
  readonly modules: {
    readonly memory: MemoryModuleConfig;
    readonly input_context: InputContextModuleConfig;
    readonly compaction: OptionalModuleConfig;
    readonly cache: CacheModuleConfig;
    readonly output: OutputModuleConfig;
  };
  readonly ui: {
    readonly widget: boolean;
    readonly status: boolean;
    readonly debounce_ms: number;
    readonly max_widget_lines: number;
  };
  readonly retention?: {
    readonly telemetry_days?: number;
    readonly unreferenced_artifact_days?: number;
  };
  readonly performance: {
    readonly enforce_budgets: true;
    readonly optional_module_auto_bypass: boolean;
    readonly window_samples: number;
    readonly paired_min_samples: number;
    readonly target_project: {
      readonly enabled: boolean;
      readonly default_mode: "BASELINE_GUARD" | "AUTO_GUARDED";
      readonly auto_activation: "EVIDENCE_OR_EXPLICIT_REQUEST";
      readonly max_trials: number;
      readonly max_user_blocking_ms: number;
      readonly profile_only_when_justified: true;
    };
    readonly budgets_file?: string;
  };
}

export interface InputContextModuleConfig {
  readonly enabled: boolean;
  readonly mode: "OFF" | "OBSERVE" | "AUTO_GUARDED";
  readonly epoch: string;
  readonly fallback: "PI_BASELINE";
  readonly soft_evidence_tokens: number;
  readonly hard_evidence_tokens: number;
  readonly max_batch_items: number;
  readonly max_batch_bytes: number;
  readonly cursor_ttl_ms: number;
}

export interface OptionalModuleConfig {
  readonly enabled: boolean;
  readonly epoch: string;
  readonly fallback: OptionalFallback;
}

export interface MemoryModuleConfig {
  readonly enabled: boolean;
  readonly mode: "OFF" | "EXPLICIT_ONLY" | "VERIFIED_JIT" | "EXPERIMENTAL";
  readonly epoch: string;
  readonly fallback: "EMPTY_OPTIONAL_PROJECTION";
  readonly soft_projection_tokens: number;
  readonly hard_projection_tokens: number;
  readonly max_results: number;
  readonly max_policy_results: number;
  readonly max_evidence_results: number;
  readonly max_experience_results: number;
  readonly max_structured_scan_rows: number;
  readonly max_payload_bytes: number;
  readonly index_drain_batch: number;
  readonly index_drain_debounce_ms: number;
  readonly capture_mode: "MANUAL_CAPTURE" | "GUARDED_AUTO";
  readonly capture_epoch: string;
}

export interface CacheModuleConfig {
  readonly enabled: boolean;
  readonly epoch: string;
  readonly arm: CacheArm;
  readonly fallback: "C0";
  readonly provider_integration?: string | null;
  readonly allow_payload_mutation: boolean;
  readonly allow_live_canary: boolean;
  readonly observation_protocol: {
    readonly decision_authority: "LEGACY_DIAGNOSTIC_ONLY";
    readonly min_observable_requests: number;
    readonly fixed_natural_request_count: number;
    readonly max_calendar_window_ms: number;
    readonly confidence_level: number;
    readonly request_diagnostic_interval_method: "WILSON_SCORE_NATURAL_WINDOW";
    readonly token_diagnostic_interval_method: "REQUEST_CLUSTER_BOOTSTRAP_NATURAL_WINDOW";
    readonly bootstrap_resamples: number;
    readonly bootstrap_seed: number;
    readonly freeze_membership_before_epoch: true;
  };
}

export interface OutputModuleConfig {
  readonly enabled: boolean;
  readonly epoch: string;
  readonly mode: "AUTO" | "NORMAL" | "AUDIT";
  readonly fallback: "BASELINE_PI";
  readonly artifact_first: boolean;
  readonly suppress_duplicate_progress: boolean;
  readonly progress_delivery: "WIDGET_FIRST_CHAT_FALLBACK";
  readonly max_silent_wait_ms: number;
  readonly history_rewrite_policy: "GENERATION_BOUNDARY_ONLY";
  readonly stable_policy_in_prefix: true;
  readonly compact_suffix_only_when_beneficial: true;
  readonly goal_level_rebound_guard: true;
  readonly account_tool_call_arguments: true;
  readonly account_reasoning_tokens: true;
  readonly tool_result_projection: "EVIDENCE_LIVENESS_ROUTED";
  readonly max_response_directive_input_tokens: number;
  readonly soft_text_token_budgets: {
    readonly tool_action: 0;
    readonly ack: number | null;
    readonly question: number | null;
    readonly status: number | null;
    readonly result: number | null;
  };
}
