import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ConfigReadError, ConfigValidationError } from "../foundation/errors.js";
import type { CodingHarnessConfig } from "./types.js";

const forbiddenKeys = new Set(["model", "provider", "thinking_level", "contextWindow"]);
const profiles = new Set(["AUTO", "TASK_SPEC", "PRD"]);
const intents = new Set(["AUTO", "PLAN_ONLY", "BUILD", "PLAN_THEN_BUILD"]);
const depths = new Set(["AUTO", "BYPASS", "LIGHT", "STANDARD", "FULL"]);
const fallbackValues = new Set(["BASELINE", "EMPTY_OPTIONAL_PROJECTION", "NATIVE_PI"]);
const cacheArms = new Set(["C0", "C1_PREFIX", "C2_PROVIDER", "C3_RETENTION", "C4_COMBINED", "AUTO"]);
const workerRoles = ["PLANNER", "EXPLORER", "IMPLEMENTER", "VERIFIER", "INTEGRATOR"] as const;
const workerThinkingLevels = new Set(["INHERIT_SUPERVISOR", "off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(
  value: unknown,
  path: string,
  allowed: ReadonlySet<string>,
  errors: string[],
): void {
  if (!isRecord(value)) return;
  for (const key of Object.keys(value)) {
    if (allowed.has(key)) continue;
    const reason = forbiddenKeys.has(key) ? "runtime settings come from Pi" : "unknown key";
    errors.push(`${path}.${key} is not allowed; ${reason}`);
  }
}

function requireRecord(value: unknown, path: string, errors: string[]): Record<string, unknown> {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return {};
  }
  return value;
}

function requireString(record: Record<string, unknown>, key: string, path: string, errors: string[]): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) errors.push(`${path}.${key} must be a non-empty string`);
  return typeof value === "string" ? value : "";
}

function requireBoolean(record: Record<string, unknown>, key: string, path: string, errors: string[]): boolean {
  const value = record[key];
  if (typeof value !== "boolean") errors.push(`${path}.${key} must be a boolean`);
  return value === true;
}

function requireInteger(record: Record<string, unknown>, key: string, path: string, min: number, max: number, errors: string[]): number {
  const value = record[key];
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    errors.push(`${path}.${key} must be an integer in [${min}, ${max}]`);
  }
  return typeof value === "number" ? value : min;
}

function requireNumber(record: Record<string, unknown>, key: string, path: string, min: number, max: number, errors: string[]): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    errors.push(`${path}.${key} must be a number in [${min}, ${max}]`);
  }
  return typeof value === "number" ? value : min;
}

function validateSoftBudget(record: Record<string, unknown>, key: string, path: string, errors: string[]): void {
  if (record[key] === null) return;
  requireInteger(record, key, path, 1, 32_768, errors);
}

function validateWorkerRuntime(value: unknown, path: string, errors: string[]): void {
  const policy = requireRecord(value, path, errors);
  rejectUnknownKeys(policy, path, new Set(["unavailable_policy", "roles"]), errors);
  if (policy.unavailable_policy !== "INHERIT_SUPERVISOR") {
    errors.push(`${path}.unavailable_policy must be INHERIT_SUPERVISOR`);
  }
  const roles = requireRecord(policy.roles, `${path}.roles`, errors);
  rejectUnknownKeys(roles, `${path}.roles`, new Set(workerRoles), errors);
  for (const role of workerRoles) {
    const rolePath = `${path}.roles.${role}`;
    const profile = requireRecord(roles[role], rolePath, errors);
    if (profile.source === "INHERIT_SUPERVISOR") {
      rejectUnknownKeys(profile, rolePath, new Set(["source"]), errors);
      continue;
    }
    if (profile.source !== "PI_CONFIG") {
      errors.push(`${rolePath}.source is invalid`);
      continue;
    }
    rejectUnknownKeys(profile, rolePath, new Set(["source", "provider_id", "model_id", "thinking_level"]), errors);
    const provider = requireString(profile, "provider_id", rolePath, errors);
    const model = requireString(profile, "model_id", rolePath, errors);
    if (provider.length > 256) errors.push(`${rolePath}.provider_id exceeds 256 characters`);
    if (model.length > 512) errors.push(`${rolePath}.model_id exceeds 512 characters`);
    if (typeof profile.thinking_level !== "string" || !workerThinkingLevels.has(profile.thinking_level)) {
      errors.push(`${rolePath}.thinking_level is invalid`);
    }
  }
}

function validateOptionalModule(value: unknown, path: string, errors: string[]): void {
  const moduleConfig = requireRecord(value, path, errors);
  rejectUnknownKeys(moduleConfig, path, new Set(["enabled", "epoch", "fallback"]), errors);
  requireBoolean(moduleConfig, "enabled", path, errors);
  requireString(moduleConfig, "epoch", path, errors);
  const fallback = moduleConfig.fallback;
  if (typeof fallback !== "string" || !fallbackValues.has(fallback)) errors.push(`${path}.fallback is invalid`);
}

function validateInputContextModule(value: unknown, path: string, errors: string[]): void {
  const moduleConfig = requireRecord(value, path, errors);
  rejectUnknownKeys(moduleConfig, path, new Set([
    "enabled", "mode", "epoch", "fallback", "soft_evidence_tokens", "hard_evidence_tokens",
    "max_batch_items", "max_batch_bytes", "cursor_ttl_ms",
  ]), errors);
  requireBoolean(moduleConfig, "enabled", path, errors);
  if (!["OFF", "OBSERVE", "AUTO_GUARDED"].includes(String(moduleConfig.mode))) errors.push(`${path}.mode is invalid`);
  requireString(moduleConfig, "epoch", path, errors);
  if (moduleConfig.fallback !== "PI_BASELINE") errors.push(`${path}.fallback must be PI_BASELINE`);
  const soft = requireInteger(moduleConfig, "soft_evidence_tokens", path, 64, 32_768, errors);
  const hard = requireInteger(moduleConfig, "hard_evidence_tokens", path, 64, 32_768, errors);
  if (soft > hard) errors.push(`${path}.soft_evidence_tokens cannot exceed hard_evidence_tokens`);
  requireInteger(moduleConfig, "max_batch_items", path, 1, 10, errors);
  requireInteger(moduleConfig, "max_batch_bytes", path, 1_024, 1_048_576, errors);
  requireInteger(moduleConfig, "cursor_ttl_ms", path, 1_000, 3_600_000, errors);
  if (moduleConfig.enabled === false && moduleConfig.mode !== "OFF") errors.push(`${path} disabled mode must be OFF`);
  if (moduleConfig.enabled === true && moduleConfig.mode === "OFF") errors.push(`${path} enabled mode cannot be OFF`);
}

function validateMemoryModule(value: unknown, path: string, errors: string[]): void {
  const moduleConfig = requireRecord(value, path, errors);
  rejectUnknownKeys(moduleConfig, path, new Set([
    "enabled", "mode", "epoch", "fallback", "soft_projection_tokens", "hard_projection_tokens",
    "max_results", "max_policy_results", "max_evidence_results", "max_experience_results",
    "max_structured_scan_rows", "max_payload_bytes", "index_drain_batch", "index_drain_debounce_ms",
    "capture_mode", "capture_epoch",
  ]), errors);
  requireBoolean(moduleConfig, "enabled", path, errors);
  if (!["OFF", "EXPLICIT_ONLY", "VERIFIED_JIT", "EXPERIMENTAL"].includes(String(moduleConfig.mode))) errors.push(`${path}.mode is invalid`);
  requireString(moduleConfig, "epoch", path, errors);
  if (moduleConfig.fallback !== "EMPTY_OPTIONAL_PROJECTION") errors.push(`${path}.fallback must be EMPTY_OPTIONAL_PROJECTION`);
  const soft = requireInteger(moduleConfig, "soft_projection_tokens", path, 64, 32_768, errors);
  const hard = requireInteger(moduleConfig, "hard_projection_tokens", path, 64, 32_768, errors);
  if (soft > hard) errors.push(`${path}.soft_projection_tokens cannot exceed hard_projection_tokens`);
  requireInteger(moduleConfig, "max_results", path, 1, 100, errors);
  requireInteger(moduleConfig, "max_policy_results", path, 0, 100, errors);
  requireInteger(moduleConfig, "max_evidence_results", path, 0, 100, errors);
  requireInteger(moduleConfig, "max_experience_results", path, 0, 100, errors);
  requireInteger(moduleConfig, "max_structured_scan_rows", path, 100, 50_000, errors);
  requireInteger(moduleConfig, "max_payload_bytes", path, 1_024, 16_777_216, errors);
  requireInteger(moduleConfig, "index_drain_batch", path, 1, 10_000, errors);
  requireInteger(moduleConfig, "index_drain_debounce_ms", path, 50, 10_000, errors);
  if (moduleConfig.capture_mode !== "MANUAL_CAPTURE" && moduleConfig.capture_mode !== "GUARDED_AUTO") {
    errors.push(`${path}.capture_mode is invalid`);
  }
  requireString(moduleConfig, "capture_epoch", path, errors);
  if (moduleConfig.enabled === false && moduleConfig.mode !== "OFF") errors.push(`${path} disabled mode must be OFF`);
  if (moduleConfig.enabled === true && moduleConfig.mode === "OFF") errors.push(`${path} enabled mode cannot be OFF`);
}

function validateConfig(value: unknown): asserts value is CodingHarnessConfig {
  const errors: string[] = [];
  const root = requireRecord(value, "$", errors);
  rejectUnknownKeys(root, "$", new Set(["schema_version", "data", "requirements", "execution", "modules", "ui", "retention", "performance"]), errors);
  if (root.schema_version !== 1) errors.push("$.schema_version must be 1");

  if (root.data !== undefined) {
    const data = requireRecord(root.data, "$.data", errors);
    rejectUnknownKeys(data, "$.data", new Set(["root", "require_local_filesystem", "sqlite_busy_timeout_ms"]), errors);
    if (data.root !== undefined) requireString(data, "root", "$.data", errors);
    if (data.require_local_filesystem !== undefined && data.require_local_filesystem !== true) errors.push("$.data.require_local_filesystem must be true");
    if (data.sqlite_busy_timeout_ms !== undefined) requireInteger(data, "sqlite_busy_timeout_ms", "$.data", 100, 30_000, errors);
  }

  const requirements = requireRecord(root.requirements, "$.requirements", errors);
  rejectUnknownKeys(requirements, "$.requirements", new Set(["profile", "batch_questions", "max_initial_questions", "safe_default_policy"]), errors);
  if (typeof requirements.profile !== "string" || !profiles.has(requirements.profile)) errors.push("$.requirements.profile is invalid");
  if (requirements.batch_questions !== true) errors.push("$.requirements.batch_questions must be true");
  requireInteger(requirements, "max_initial_questions", "$.requirements", 1, 8, errors);
  if (requirements.safe_default_policy !== "LOW_RISK_ONLY" && requirements.safe_default_policy !== "NEVER") errors.push("$.requirements.safe_default_policy is invalid");

  const execution = requireRecord(root.execution, "$.execution", errors);
  rejectUnknownKeys(execution, "$.execution", new Set([
    "default_intent", "planning_depth", "same_failure_retry_limit", "lease_ttl_ms",
    "worker_timeout_ms", "max_parallel_workers", "worker_runtime",
  ]), errors);
  if (typeof execution.default_intent !== "string" || !intents.has(execution.default_intent)) errors.push("$.execution.default_intent is invalid");
  if (typeof execution.planning_depth !== "string" || !depths.has(execution.planning_depth)) errors.push("$.execution.planning_depth is invalid");
  requireInteger(execution, "same_failure_retry_limit", "$.execution", 0, 3, errors);
  requireInteger(execution, "lease_ttl_ms", "$.execution", 5_000, 300_000, errors);
  if (execution.worker_timeout_ms !== undefined) requireInteger(execution, "worker_timeout_ms", "$.execution", 10_000, 3_600_000, errors);
  if (execution.max_parallel_workers !== undefined) requireInteger(execution, "max_parallel_workers", "$.execution", 1, 8, errors);
  if (execution.worker_runtime !== undefined) validateWorkerRuntime(execution.worker_runtime, "$.execution.worker_runtime", errors);

  const modules = requireRecord(root.modules, "$.modules", errors);
  rejectUnknownKeys(modules, "$.modules", new Set(["memory", "input_context", "compaction", "cache", "output"]), errors);
  validateMemoryModule(modules.memory, "$.modules.memory", errors);
  validateInputContextModule(modules.input_context, "$.modules.input_context", errors);
  validateOptionalModule(modules.compaction, "$.modules.compaction", errors);
  const cache = requireRecord(modules.cache, "$.modules.cache", errors);
  rejectUnknownKeys(cache, "$.modules.cache", new Set(["enabled", "epoch", "arm", "fallback", "provider_integration", "allow_payload_mutation", "allow_live_canary", "observation_protocol"]), errors);
  requireBoolean(cache, "enabled", "$.modules.cache", errors);
  requireString(cache, "epoch", "$.modules.cache", errors);
  if (typeof cache.arm !== "string" || !cacheArms.has(cache.arm)) errors.push("$.modules.cache.arm is invalid");
  if (cache.fallback !== "C0") errors.push("$.modules.cache.fallback must be C0");
  if (cache.provider_integration !== undefined && cache.provider_integration !== null && typeof cache.provider_integration !== "string") errors.push("$.modules.cache.provider_integration must be string or null");
  requireBoolean(cache, "allow_payload_mutation", "$.modules.cache", errors);
  requireBoolean(cache, "allow_live_canary", "$.modules.cache", errors);
  if (cache.enabled === false && (cache.arm !== "C0" || cache.allow_payload_mutation === true || cache.allow_live_canary === true)) {
    errors.push("$.modules.cache disabled mode must remain C0 with mutation and live canary off");
  }
  if ((cache.arm === "C0" || cache.arm === "C1_PREFIX") && cache.allow_payload_mutation === true) {
    errors.push("$.modules.cache C0/C1 cannot mutate provider payloads");
  }
  if (["C2_PROVIDER", "C3_RETENTION", "C4_COMBINED"].includes(String(cache.arm)) &&
      (typeof cache.provider_integration !== "string" || cache.provider_integration.length === 0)) {
    errors.push("$.modules.cache provider mutation arms require a concrete provider_integration");
  }
  const cacheProtocol = requireRecord(cache.observation_protocol, "$.modules.cache.observation_protocol", errors);
  rejectUnknownKeys(cacheProtocol, "$.modules.cache.observation_protocol", new Set(["decision_authority", "min_observable_requests", "fixed_natural_request_count", "max_calendar_window_ms", "confidence_level", "request_diagnostic_interval_method", "token_diagnostic_interval_method", "bootstrap_resamples", "bootstrap_seed", "freeze_membership_before_epoch"]), errors);
  if (cacheProtocol.decision_authority !== "LEGACY_DIAGNOSTIC_ONLY") errors.push("$.modules.cache.observation_protocol.decision_authority must be LEGACY_DIAGNOSTIC_ONLY");
  requireInteger(cacheProtocol, "min_observable_requests", "$.modules.cache.observation_protocol", 1, 10_000, errors);
  requireInteger(cacheProtocol, "fixed_natural_request_count", "$.modules.cache.observation_protocol", 1, 10_000, errors);
  requireInteger(cacheProtocol, "max_calendar_window_ms", "$.modules.cache.observation_protocol", 60_000, 31_536_000_000, errors);
  requireNumber(cacheProtocol, "confidence_level", "$.modules.cache.observation_protocol", 0.9, 0.999, errors);
  if (cacheProtocol.request_diagnostic_interval_method !== "WILSON_SCORE_NATURAL_WINDOW") errors.push("$.modules.cache.observation_protocol.request_diagnostic_interval_method must be WILSON_SCORE_NATURAL_WINDOW");
  if (cacheProtocol.token_diagnostic_interval_method !== "REQUEST_CLUSTER_BOOTSTRAP_NATURAL_WINDOW") errors.push("$.modules.cache.observation_protocol.token_diagnostic_interval_method must be REQUEST_CLUSTER_BOOTSTRAP_NATURAL_WINDOW");
  requireInteger(cacheProtocol, "bootstrap_resamples", "$.modules.cache.observation_protocol", 1_000, 100_000, errors);
  requireInteger(cacheProtocol, "bootstrap_seed", "$.modules.cache.observation_protocol", 0, 2_147_483_647, errors);
  if (cacheProtocol.freeze_membership_before_epoch !== true) errors.push("$.modules.cache.observation_protocol.freeze_membership_before_epoch must be true");
  if (typeof cacheProtocol.min_observable_requests === "number" && typeof cacheProtocol.fixed_natural_request_count === "number" && cacheProtocol.min_observable_requests > cacheProtocol.fixed_natural_request_count) {
    errors.push("$.modules.cache.observation_protocol min_observable_requests cannot exceed fixed_natural_request_count");
  }

  const output = requireRecord(modules.output, "$.modules.output", errors);
  rejectUnknownKeys(output, "$.modules.output", new Set(["enabled", "epoch", "mode", "fallback", "artifact_first", "suppress_duplicate_progress", "progress_delivery", "max_silent_wait_ms", "history_rewrite_policy", "stable_policy_in_prefix", "compact_suffix_only_when_beneficial", "goal_level_rebound_guard", "account_tool_call_arguments", "account_reasoning_tokens", "tool_result_projection", "max_response_directive_input_tokens", "soft_text_token_budgets"]), errors);
  requireBoolean(output, "enabled", "$.modules.output", errors);
  requireString(output, "epoch", "$.modules.output", errors);
  if (output.mode !== "AUTO" && output.mode !== "NORMAL" && output.mode !== "AUDIT") errors.push("$.modules.output.mode is invalid");
  if (output.fallback !== "BASELINE_PI") errors.push("$.modules.output.fallback must be BASELINE_PI");
  requireBoolean(output, "artifact_first", "$.modules.output", errors);
  requireBoolean(output, "suppress_duplicate_progress", "$.modules.output", errors);
  if (output.progress_delivery !== "WIDGET_FIRST_CHAT_FALLBACK") errors.push("$.modules.output.progress_delivery must be WIDGET_FIRST_CHAT_FALLBACK");
  requireInteger(output, "max_silent_wait_ms", "$.modules.output", 5_000, 300_000, errors);
  if (output.history_rewrite_policy !== "GENERATION_BOUNDARY_ONLY") errors.push("$.modules.output.history_rewrite_policy must be GENERATION_BOUNDARY_ONLY");
  if (output.stable_policy_in_prefix !== true) errors.push("$.modules.output.stable_policy_in_prefix must be true");
  if (output.compact_suffix_only_when_beneficial !== true) errors.push("$.modules.output.compact_suffix_only_when_beneficial must be true");
  if (output.goal_level_rebound_guard !== true) errors.push("$.modules.output.goal_level_rebound_guard must be true");
  if (output.account_tool_call_arguments !== true) errors.push("$.modules.output.account_tool_call_arguments must be true");
  if (output.account_reasoning_tokens !== true) errors.push("$.modules.output.account_reasoning_tokens must be true");
  if (output.tool_result_projection !== "EVIDENCE_LIVENESS_ROUTED") errors.push("$.modules.output.tool_result_projection must be EVIDENCE_LIVENESS_ROUTED");
  requireInteger(output, "max_response_directive_input_tokens", "$.modules.output", 1, 256, errors);
  const softBudgets = requireRecord(output.soft_text_token_budgets, "$.modules.output.soft_text_token_budgets", errors);
  rejectUnknownKeys(softBudgets, "$.modules.output.soft_text_token_budgets", new Set(["tool_action", "ack", "question", "status", "result"]), errors);
  if (softBudgets.tool_action !== 0) errors.push("$.modules.output.soft_text_token_budgets.tool_action must be 0");
  for (const key of ["ack", "question", "status", "result"]) validateSoftBudget(softBudgets, key, "$.modules.output.soft_text_token_budgets", errors);

  const ui = requireRecord(root.ui, "$.ui", errors);
  rejectUnknownKeys(ui, "$.ui", new Set(["widget", "status", "debounce_ms", "max_widget_lines"]), errors);
  requireBoolean(ui, "widget", "$.ui", errors);
  requireBoolean(ui, "status", "$.ui", errors);
  requireInteger(ui, "debounce_ms", "$.ui", 50, 2_000, errors);
  requireInteger(ui, "max_widget_lines", "$.ui", 1, 6, errors);

  if (root.retention !== undefined) {
    const retention = requireRecord(root.retention, "$.retention", errors);
    rejectUnknownKeys(retention, "$.retention", new Set(["telemetry_days", "unreferenced_artifact_days"]), errors);
    if (retention.telemetry_days !== undefined) requireInteger(retention, "telemetry_days", "$.retention", 1, 3_650, errors);
    if (retention.unreferenced_artifact_days !== undefined) requireInteger(retention, "unreferenced_artifact_days", "$.retention", 1, 3_650, errors);
  }

  const performance = requireRecord(root.performance, "$.performance", errors);
  rejectUnknownKeys(performance, "$.performance", new Set(["enforce_budgets", "optional_module_auto_bypass", "window_samples", "paired_min_samples", "target_project", "budgets_file"]), errors);
  if (performance.enforce_budgets !== true) errors.push("$.performance.enforce_budgets must be true");
  if (typeof performance.optional_module_auto_bypass !== "boolean") errors.push("$.performance.optional_module_auto_bypass must be boolean");
  requireInteger(performance, "window_samples", "$.performance", 10, 1_000, errors);
  requireInteger(performance, "paired_min_samples", "$.performance", 5, 1_000, errors);
  const targetProject = requireRecord(performance.target_project, "$.performance.target_project", errors);
  rejectUnknownKeys(targetProject, "$.performance.target_project", new Set(["enabled", "default_mode", "auto_activation", "max_trials", "max_user_blocking_ms", "profile_only_when_justified"]), errors);
  requireBoolean(targetProject, "enabled", "$.performance.target_project", errors);
  if (targetProject.default_mode !== "BASELINE_GUARD" && targetProject.default_mode !== "AUTO_GUARDED") errors.push("$.performance.target_project.default_mode is invalid");
  if (targetProject.auto_activation !== "EVIDENCE_OR_EXPLICIT_REQUEST") errors.push("$.performance.target_project.auto_activation must be EVIDENCE_OR_EXPLICIT_REQUEST");
  requireInteger(targetProject, "max_trials", "$.performance.target_project", 0, 20, errors);
  requireInteger(targetProject, "max_user_blocking_ms", "$.performance.target_project", 0, 600_000, errors);
  if (targetProject.profile_only_when_justified !== true) errors.push("$.performance.target_project.profile_only_when_justified must be true");
  if (performance.budgets_file !== undefined) requireString(performance, "budgets_file", "$.performance", errors);

  if (errors.length > 0) throw new ConfigValidationError("config", errors);
}

export function loadConfig(path: string): CodingHarnessConfig {
  const absolutePath = resolve(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absolutePath, "utf8")) as unknown;
  } catch (error) {
    throw new ConfigReadError(absolutePath, error);
  }
  try {
    validateConfig(parsed);
  } catch (error) {
    if (error instanceof ConfigValidationError) throw new ConfigValidationError(absolutePath, error.details, error);
    throw error;
  }
  return parsed;
}
