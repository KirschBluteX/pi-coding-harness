import { canonicalJson, canonicalJsonSha256 } from "../authority/canonical-json.js";
import type { CacheProviderContract } from "../cache-v2/provider-contract.js";
import { idFromSha256 } from "../foundation/ids.js";
import type { ResolvedWorkerRuntime } from "../harness/worker/runtime-policy.js";

const sha256Pattern = /^[a-f0-9]{64}$/u;
const idPattern = /^[A-Z][A-Z0-9_:-]{0,255}$/u;

export const providerRequestClassesV1 = ["WORKER", "EVALUATOR", "EXPLORATORY"] as const;
export type ProviderRequestClassV1 = typeof providerRequestClassesV1[number];

// This allowlist is the admission decision. Local deterministic work has no
// representable purpose kind and therefore cannot be made provider-eligible by prose.
export const providerPurposeKindsV1 = [
  "TASK_EXECUTION",
  "UNCERTAINTY_REDUCTION",
  "INDEPENDENT_EVALUATION",
  "INDEPENDENT_CRITIQUE",
  "CANDIDATE_DIVERSIFICATION",
] as const;
export type ProviderPurposeKindV1 = typeof providerPurposeKindsV1[number];

export const providerAdmissionReasonsV1 = [
  "REDUCE_MATERIAL_UNCERTAINTY",
  "INDEPENDENT_RISK_COVERAGE",
  "PARALLEL_CRITICAL_PATH",
  "DIVERSE_CANDIDATES_WITH_EXPECTED_GAIN",
] as const;
export type ProviderAdmissionReasonV1 = typeof providerAdmissionReasonsV1[number];

export const providerPrivacyClassesV1 = ["PUBLIC", "INTERNAL", "SENSITIVE", "SECRET"] as const;
export type ProviderPrivacyClassV1 = typeof providerPrivacyClassesV1[number];

export const providerStopConditionsV1 = [
  "DEADLINE_REACHED",
  "EVIDENCE_SATURATION",
  "MAX_ATTEMPTS_REACHED",
  "NO_PROGRESS",
  "PRIVACY_VIOLATION",
  "SOFT_BUDGET_EXHAUSTED",
  "SUCCESS_EVIDENCE_OBSERVED",
] as const;
export type ProviderStopConditionV1 = typeof providerStopConditionsV1[number];

export type ProviderSuccessEvidenceKindV1 =
  | "TYPED_WORKER_PROPOSAL"
  | "TYPED_EVALUATION_PROPOSAL"
  | "TYPED_EXPLORATION_PROPOSAL";
export type ProviderFallbackKindV1 = "LOCAL_REPLAN" | "ASK_USER" | "DEFER" | "ABORT_BRANCH";

export interface ProviderAllowedFieldV1 {
  readonly field_path: string;
  readonly content_sha256: string;
  readonly classification: ProviderPrivacyClassV1;
}

export interface ProviderRuntimeProfileV1 {
  readonly schema_version: 1;
  readonly source: ResolvedWorkerRuntime["source"];
  readonly source_profile_id: string | null;
  readonly provider: string;
  readonly api: string;
  readonly base_url: string | null;
  readonly model: string;
  readonly thinking_level: string;
  readonly context_window: number;
  readonly current_pi_config_sha256: string;
  readonly runtime_fingerprint_sha256: string;
  readonly fallback_reason: ResolvedWorkerRuntime["fallback_reason"];
  readonly record_sha256: string;
}

export interface ProviderInformationValueV1 {
  readonly basis_points: number;
  readonly evidence_sha256: string;
}

export interface ProviderRequestBudgetV1 {
  readonly budget_envelope_sha256: string;
  readonly soft_max_requests: number;
  readonly soft_max_input_tokens: number;
  readonly soft_max_output_tokens: number;
  readonly soft_max_cost_microusd: number;
  readonly soft_max_latency_ms: number;
  readonly deadline_at_ms: number;
}

export interface ProviderCachePlanV1 {
  readonly mode: "C0" | "C1";
  readonly lineage_sha256: string | null;
  readonly adapter_integration_id: string | null;
  readonly adapter_security_epoch: string | null;
  readonly adapter_usage_semantics_id: string;
  readonly session_capability: "NONE" | "ADAPTER_DECLARED_AFFINITY";
  readonly session_capability_sha256: string | null;
}

export type ProviderCachePlanCaptureV1 =
  | {
    readonly mode: "C0";
    readonly adapterUsageSemanticsId: string;
  }
  | {
    readonly mode: "C1";
    readonly contract: CacheProviderContract;
    readonly lineageSha256: string;
    readonly sessionCapability: "NONE" | "ADAPTER_DECLARED_AFFINITY";
    readonly sessionCapabilitySha256: string | null;
  };

export interface ProviderSuccessEvidenceV1 {
  readonly kind: ProviderSuccessEvidenceKindV1;
  readonly output_schema_sha256: string;
  readonly evidence_requirement_sha256: string;
}

export interface ProviderLocalOracleV1 {
  readonly owner: "HOST";
  readonly oracle_sha256: string;
  readonly covered_obligation_ids: readonly string[];
}

export interface ProviderFallbackV1 {
  readonly kind: ProviderFallbackKindV1;
  readonly evidence_sha256: string;
}

export interface ProviderCallPlanV1 {
  readonly schema_version: 1;
  readonly provider_call_plan_id: string;
  readonly goal_id: string;
  readonly run_id: string;
  readonly graph_revision_id: string;
  readonly graph_revision_sha256: string;
  readonly node_id: string;
  readonly node_spec_sha256: string;
  readonly packet_id: string;
  readonly attempt: number;
  readonly lease_generation: number;
  readonly fencing_token: number;
  readonly logical_request_id: string;
  readonly plan_nonce_sha256: string;
  readonly request_class: ProviderRequestClassV1;
  readonly purpose_kind: ProviderPurposeKindV1;
  readonly purpose: string;
  readonly uncertainty_id: string;
  readonly uncertainty_sha256: string;
  readonly expected_information_gain: ProviderInformationValueV1;
  readonly expected_loss_if_skipped: ProviderInformationValueV1;
  readonly minimum_input_closure_sha256: string;
  readonly privacy_class: ProviderPrivacyClassV1;
  readonly allowed_fields: readonly ProviderAllowedFieldV1[];
  readonly allowed_fields_root_sha256: string;
  readonly redaction_receipt_id: string;
  readonly redaction_receipt_sha256: string;
  readonly provider_profile: ProviderRuntimeProfileV1;
  readonly provider_profile_sha256: string;
  readonly request_budget: ProviderRequestBudgetV1;
  readonly admission_reason: ProviderAdmissionReasonV1;
  readonly cache: ProviderCachePlanV1;
  readonly success_evidence: ProviderSuccessEvidenceV1;
  readonly local_oracle: ProviderLocalOracleV1;
  readonly fallback: ProviderFallbackV1;
  readonly attempt_limit: number;
  readonly transport_request_limit: number;
  readonly fan_out_limit: number;
  readonly fan_out_independence_evidence_sha256: string | null;
  readonly fan_out_branch_information_sha256s: readonly string[];
  readonly no_progress_limit: number;
  readonly evidence_saturation_sha256: string;
  readonly stop_conditions: readonly ProviderStopConditionV1[];
  readonly provider_output_authority: "UNVERIFIED_PROPOSAL";
  readonly predecessor_authority_head_sha256: string;
  readonly created_at_ms: number;
  readonly record_sha256: string;
}

export interface ProviderCallPlanDraftV1 extends Omit<
  ProviderCallPlanV1,
  | "schema_version"
  | "provider_call_plan_id"
  | "allowed_fields_root_sha256"
  | "provider_profile_sha256"
  | "provider_output_authority"
  | "record_sha256"
  | "attempt_limit"
  | "fan_out_limit"
  | "fan_out_independence_evidence_sha256"
  | "fan_out_branch_information_sha256s"
  | "no_progress_limit"
  | "transport_request_limit"
> {
  readonly attempt_limit?: number;
  readonly fan_out_limit?: number;
  readonly fan_out_independence_evidence_sha256?: string | null;
  readonly fan_out_branch_information_sha256s?: readonly string[];
  readonly no_progress_limit?: number;
  readonly transport_request_limit?: number;
}

const runtimeProfileKeys = [
  "schema_version", "source", "source_profile_id", "provider", "api", "base_url", "model",
  "thinking_level", "context_window", "current_pi_config_sha256", "runtime_fingerprint_sha256",
  "fallback_reason", "record_sha256",
] as const;
const informationValueKeys = ["basis_points", "evidence_sha256"] as const;
const requestBudgetKeys = [
  "budget_envelope_sha256", "soft_max_requests", "soft_max_input_tokens", "soft_max_output_tokens",
  "soft_max_cost_microusd", "soft_max_latency_ms", "deadline_at_ms",
] as const;
const cachePlanKeys = [
  "mode", "lineage_sha256", "adapter_integration_id", "adapter_security_epoch",
  "adapter_usage_semantics_id", "session_capability", "session_capability_sha256",
] as const;
const successEvidenceKeys = ["kind", "output_schema_sha256", "evidence_requirement_sha256"] as const;
const localOracleKeys = ["owner", "oracle_sha256", "covered_obligation_ids"] as const;
const fallbackKeys = ["kind", "evidence_sha256"] as const;
const allowedFieldKeys = ["field_path", "content_sha256", "classification"] as const;
const planKeys = [
  "schema_version", "provider_call_plan_id", "goal_id", "run_id", "logical_request_id",
  "graph_revision_id", "graph_revision_sha256", "node_id", "node_spec_sha256", "packet_id",
  "attempt", "lease_generation", "fencing_token",
  "plan_nonce_sha256", "request_class", "purpose_kind", "purpose", "uncertainty_id",
  "uncertainty_sha256", "expected_information_gain", "expected_loss_if_skipped",
  "minimum_input_closure_sha256", "privacy_class", "allowed_fields", "allowed_fields_root_sha256",
  "redaction_receipt_id", "redaction_receipt_sha256", "provider_profile", "provider_profile_sha256",
  "request_budget", "admission_reason", "cache", "success_evidence", "local_oracle", "fallback",
  "attempt_limit", "transport_request_limit", "fan_out_limit", "fan_out_independence_evidence_sha256",
  "fan_out_branch_information_sha256s", "no_progress_limit", "evidence_saturation_sha256",
  "stop_conditions", "provider_output_authority", "predecessor_authority_head_sha256",
  "created_at_ms", "record_sha256",
] as const;

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).toSorted();
  const canonical = [...expected].toSorted();
  if (actual.length !== canonical.length || actual.some((key, index) => key !== canonical[index])) {
    throw new TypeError(`${label} has unknown or missing fields`);
  }
}

function member<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new TypeError(`${label} is invalid`);
  return value as T;
}

function boundedString(value: unknown, label: string, maximum = 32_768): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum
    || value !== value.normalize("NFC") || value.trim() !== value) {
    throw new TypeError(`${label} must be bounded normalized text`);
  }
  return value;
}

function boundedId(value: unknown, label: string): string {
  if (typeof value !== "string" || !idPattern.test(value)) throw new TypeError(`${label} is invalid`);
  return value;
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !sha256Pattern.test(value)) throw new TypeError(`${label} is not a lowercase SHA-256`);
  return value;
}

function integer(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new TypeError(`${label} is outside its bounded integer range`);
  }
  return Number(value);
}

function nullableString(value: unknown, label: string, maximum = 4_096): string | null {
  return value === null ? null : boundedString(value, label, maximum);
}

function nullableSha256(value: unknown, label: string): string | null {
  return value === null ? null : sha256(value, label);
}

function canonicalStringSet(
  value: unknown,
  label: string,
  options: { readonly allowEmpty?: boolean; readonly ids?: boolean; readonly sha256s?: boolean } = {},
): readonly string[] {
  if (!Array.isArray(value) || (!options.allowEmpty && value.length === 0) || value.length > 256) {
    throw new TypeError(`${label} must be a bounded array`);
  }
  const entries = value.map((entry, index) => options.ids
    ? boundedId(entry, `${label}[${index}]`)
    : options.sha256s
      ? sha256(entry, `${label}[${index}]`)
      : boundedString(entry, `${label}[${index}]`, 1_024));
  const sorted = entries.toSorted();
  if (new Set(entries).size !== entries.length || entries.some((entry, index) => entry !== sorted[index])) {
    throw new TypeError(`${label} must be unique and canonically sorted`);
  }
  return entries;
}

function sealedHash(domain: string, value: Record<string, unknown>, label: string): void {
  const actual = sha256(value.record_sha256, `${label}.record_sha256`);
  const body = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "record_sha256"));
  if (canonicalJsonSha256({ domain, ...body }) !== actual) throw new TypeError(`${label} record hash is invalid`);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const memberValue of Object.values(value as Record<string, unknown>)) deepFreeze(memberValue);
  }
  return value;
}

function profileBody(input: {
  readonly resolved: ResolvedWorkerRuntime;
  readonly sourceProfileId: string | null;
  readonly currentPiConfigSha256: string;
  readonly runtimeFingerprintSha256: string;
}): Omit<ProviderRuntimeProfileV1, "record_sha256"> {
  return {
    schema_version: 1,
    source: input.resolved.source,
    source_profile_id: input.sourceProfileId,
    provider: input.resolved.runtime.provider,
    api: input.resolved.runtime.api,
    base_url: input.resolved.runtime.base_url ?? null,
    model: input.resolved.runtime.model,
    thinking_level: input.resolved.runtime.thinking_level,
    context_window: input.resolved.runtime.context_window,
    current_pi_config_sha256: input.currentPiConfigSha256,
    runtime_fingerprint_sha256: input.runtimeFingerprintSha256,
    fallback_reason: input.resolved.fallback_reason,
  };
}

export function captureProviderRuntimeProfileV1(input: {
  readonly resolved: ResolvedWorkerRuntime;
  readonly sourceProfileId: string | null;
  readonly currentPiConfigSha256: string;
  readonly runtimeFingerprintSha256: string;
}): ProviderRuntimeProfileV1 {
  const body = profileBody(input);
  const profile: ProviderRuntimeProfileV1 = {
    ...body,
    record_sha256: canonicalJsonSha256({ domain: "PCH-PROVIDER-RUNTIME-PROFILE-V1", ...body }),
  };
  assertProviderRuntimeProfileV1(profile);
  return deepFreeze(profile);
}

export function assertProviderRuntimeProfileV1(value: ProviderRuntimeProfileV1): void {
  const profile = record(value, "Provider runtime profile");
  exactKeys(profile, runtimeProfileKeys, "Provider runtime profile");
  if (profile.schema_version !== 1) throw new TypeError("Provider runtime profile schema version is invalid");
  const source = member(profile.source, ["SUPERVISOR_INHERITED", "PI_CONFIG", "SUPERVISOR_FALLBACK"], "Provider runtime profile source");
  const sourceProfileId = profile.source_profile_id === null
    ? null : boundedId(profile.source_profile_id, "Provider runtime source profile ID");
  boundedString(profile.provider, "Provider runtime provider", 256);
  boundedString(profile.api, "Provider runtime API", 256);
  const baseUrl = nullableString(profile.base_url, "Provider runtime base URL", 2_048);
  if (baseUrl !== null) {
    let parsed: URL;
    try { parsed = new URL(baseUrl); }
    catch (error) { throw new TypeError("Provider runtime base URL must be absolute", { cause: error }); }
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password
      || parsed.search || parsed.hash) {
      throw new TypeError("Provider runtime base URL cannot contain credentials, query, fragment, or a non-HTTP scheme");
    }
  }
  boundedString(profile.model, "Provider runtime model", 512);
  boundedString(profile.thinking_level, "Provider runtime thinking level", 128);
  integer(profile.context_window, 1, 10_000_000, "Provider runtime context window");
  sha256(profile.current_pi_config_sha256, "Provider runtime Pi config hash");
  sha256(profile.runtime_fingerprint_sha256, "Provider runtime fingerprint");
  const fallback = profile.fallback_reason === null
    ? null : member(profile.fallback_reason, ["MODEL_NOT_FOUND", "AUTH_NOT_CONFIGURED"], "Provider runtime fallback reason");
  if (source === "SUPERVISOR_INHERITED" && (sourceProfileId !== null || fallback !== null)) {
    throw new TypeError("Inherited Provider runtime cannot claim a role profile or fallback");
  }
  if (source === "PI_CONFIG" && (sourceProfileId === null || fallback !== null)) {
    throw new TypeError("Pi-config Provider runtime requires its exact source profile without fallback");
  }
  if (source === "SUPERVISOR_FALLBACK" && (sourceProfileId === null || fallback === null)) {
    throw new TypeError("Fallback Provider runtime requires the failed Pi profile and reason");
  }
  sealedHash("PCH-PROVIDER-RUNTIME-PROFILE-V1", profile, "Provider runtime profile");
}

function assertInformationValue(value: unknown, label: string): void {
  const information = record(value, label);
  exactKeys(information, informationValueKeys, label);
  integer(information.basis_points, 1, 10_000, `${label}.basis_points`);
  sha256(information.evidence_sha256, `${label}.evidence_sha256`);
}

function assertRequestBudget(
  value: unknown,
  createdAtMs: number,
  fanOutLimit: number,
  transportRequestLimit: number,
): void {
  const budget = record(value, "Provider request budget");
  exactKeys(budget, requestBudgetKeys, "Provider request budget");
  sha256(budget.budget_envelope_sha256, "Provider budget envelope hash");
  const maxRequests = integer(budget.soft_max_requests, 1, 256, "Provider soft request budget");
  integer(budget.soft_max_input_tokens, 1, 10_000_000, "Provider soft input-token budget");
  integer(budget.soft_max_output_tokens, 1, 10_000_000, "Provider soft output-token budget");
  integer(budget.soft_max_cost_microusd, 0, Number.MAX_SAFE_INTEGER, "Provider soft cost budget");
  const maxLatency = integer(budget.soft_max_latency_ms, 1, 86_400_000, "Provider soft latency budget");
  const deadline = integer(budget.deadline_at_ms, createdAtMs + 1, Number.MAX_SAFE_INTEGER, "Provider deadline");
  if (maxRequests < fanOutLimit || maxRequests > transportRequestLimit) {
    throw new TypeError("Provider soft request budget is inconsistent with transport and fan-out limits");
  }
  if (maxLatency > deadline - createdAtMs) throw new TypeError("Provider soft latency budget exceeds its deadline");
}

function assertCachePlan(value: unknown): void {
  const cache = record(value, "Provider cache plan");
  exactKeys(cache, cachePlanKeys, "Provider cache plan");
  const mode = member(cache.mode, ["C0", "C1"], "Provider cache mode");
  const lineage = nullableSha256(cache.lineage_sha256, "Provider cache lineage");
  const integrationId = nullableString(cache.adapter_integration_id, "Provider cache Adapter integration ID", 256);
  const securityEpoch = nullableString(cache.adapter_security_epoch, "Provider cache Adapter security epoch", 256);
  boundedString(cache.adapter_usage_semantics_id, "Provider Adapter usage semantics ID", 256);
  const session = member(cache.session_capability, ["NONE", "ADAPTER_DECLARED_AFFINITY"], "Provider session capability");
  const sessionHash = nullableSha256(cache.session_capability_sha256, "Provider session capability hash");
  if (mode === "C0" && (lineage !== null || integrationId !== null || securityEpoch !== null || session !== "NONE" || sessionHash !== null)) {
    throw new TypeError("Provider cache C0 cannot claim cache lineage, integration, or affinity");
  }
  if (mode === "C1" && (lineage === null || integrationId === null || securityEpoch === null)) {
    throw new TypeError("Provider cache C1 requires Adapter-specific lineage and security epoch");
  }
  if ((session === "NONE") !== (sessionHash === null)) {
    throw new TypeError("Provider session capability identity is incomplete");
  }
  if (session === "ADAPTER_DECLARED_AFFINITY" && mode !== "C1") {
    throw new TypeError("Provider affinity requires an attributable C1 Adapter");
  }
}

export function captureProviderCachePlanV1(input: ProviderCachePlanCaptureV1): ProviderCachePlanV1 {
  const plan: ProviderCachePlanV1 = input.mode === "C0"
    ? {
      mode: "C0",
      lineage_sha256: null,
      adapter_integration_id: null,
      adapter_security_epoch: null,
      adapter_usage_semantics_id: input.adapterUsageSemanticsId,
      session_capability: "NONE",
      session_capability_sha256: null,
    }
    : {
      mode: "C1",
      lineage_sha256: input.lineageSha256,
      adapter_integration_id: input.contract.integrationId,
      adapter_security_epoch: input.contract.securityEpoch,
      adapter_usage_semantics_id: input.contract.usageSemanticsId,
      session_capability: input.sessionCapability,
      session_capability_sha256: input.sessionCapabilitySha256,
    };
  assertCachePlan(plan);
  return deepFreeze(plan);
}

function assertAllowedFields(value: unknown, privacyClass: ProviderPrivacyClassV1, expectedRoot: unknown): void {
  if (!Array.isArray(value) || value.length < 1 || value.length > 256) {
    throw new TypeError("Provider allowed fields must be a bounded non-empty array");
  }
  const privacyRank = new Map(providerPrivacyClassesV1.map((entry, index) => [entry, index]));
  const paths = value.map((entry, index) => {
    const field = record(entry, `Provider allowed field ${index}`);
    exactKeys(field, allowedFieldKeys, `Provider allowed field ${index}`);
    const path = boundedString(field.field_path, `Provider allowed field ${index} path`, 1_024);
    if (!path.startsWith("/") || /~(?:[^01]|$)/u.test(path)) {
      throw new TypeError("Provider allowed field path must be an RFC 6901 JSON pointer");
    }
    sha256(field.content_sha256, `Provider allowed field ${index} content hash`);
    const classification = member(field.classification, providerPrivacyClassesV1, `Provider allowed field ${index} classification`);
    if ((privacyRank.get(classification) ?? Number.MAX_SAFE_INTEGER) > (privacyRank.get(privacyClass) ?? -1)) {
      throw new TypeError("Provider allowed field exceeds the declared privacy closure");
    }
    return path;
  });
  if (new Set(paths).size !== paths.length || paths.some((path, index) => path !== paths.toSorted()[index])) {
    throw new TypeError("Provider allowed fields must be unique and canonically sorted");
  }
  const rootHash = canonicalJsonSha256({ domain: "PCH-PROVIDER-ALLOWED-FIELDS-V1", members: value });
  if (sha256(expectedRoot, "Provider allowed-fields root") !== rootHash) {
    throw new TypeError("Provider allowed-fields root is invalid");
  }
}

function assertSuccessEvidence(value: unknown, requestClass: ProviderRequestClassV1): void {
  const success = record(value, "Provider success evidence");
  exactKeys(success, successEvidenceKeys, "Provider success evidence");
  const kind = member(success.kind, [
    "TYPED_WORKER_PROPOSAL", "TYPED_EVALUATION_PROPOSAL", "TYPED_EXPLORATION_PROPOSAL",
  ], "Provider success evidence kind");
  const expected = {
    WORKER: "TYPED_WORKER_PROPOSAL",
    EVALUATOR: "TYPED_EVALUATION_PROPOSAL",
    EXPLORATORY: "TYPED_EXPLORATION_PROPOSAL",
  } as const;
  if (kind !== expected[requestClass]) throw new TypeError("Provider success evidence does not match its request class");
  sha256(success.output_schema_sha256, "Provider output schema hash");
  sha256(success.evidence_requirement_sha256, "Provider success evidence requirement hash");
}

function assertLocalOracle(value: unknown): void {
  const oracle = record(value, "Provider local oracle");
  exactKeys(oracle, localOracleKeys, "Provider local oracle");
  if (oracle.owner !== "HOST") throw new TypeError("Provider local oracle must be Host-owned");
  sha256(oracle.oracle_sha256, "Provider local oracle hash");
  canonicalStringSet(oracle.covered_obligation_ids, "Provider local oracle obligation IDs", { ids: true });
}

function assertFallback(value: unknown): void {
  const fallback = record(value, "Provider fallback");
  exactKeys(fallback, fallbackKeys, "Provider fallback");
  member(fallback.kind, ["LOCAL_REPLAN", "ASK_USER", "DEFER", "ABORT_BRANCH"], "Provider fallback kind");
  sha256(fallback.evidence_sha256, "Provider fallback evidence hash");
}

function assertPurposeCompatibility(
  requestClass: ProviderRequestClassV1,
  purposeKind: ProviderPurposeKindV1,
  admissionReason: ProviderAdmissionReasonV1,
): void {
  const allowed: Readonly<Record<ProviderRequestClassV1, readonly ProviderPurposeKindV1[]>> = {
    WORKER: ["TASK_EXECUTION", "UNCERTAINTY_REDUCTION", "CANDIDATE_DIVERSIFICATION"],
    EVALUATOR: ["INDEPENDENT_EVALUATION", "INDEPENDENT_CRITIQUE"],
    EXPLORATORY: ["UNCERTAINTY_REDUCTION", "INDEPENDENT_CRITIQUE", "CANDIDATE_DIVERSIFICATION"],
  };
  if (!allowed[requestClass].includes(purposeKind)) throw new TypeError("Provider purpose does not match its request class");
  if (purposeKind === "CANDIDATE_DIVERSIFICATION" && admissionReason !== "DIVERSE_CANDIDATES_WITH_EXPECTED_GAIN") {
    throw new TypeError("Provider candidate diversification requires a measured diversity admission reason");
  }
  if ((purposeKind === "INDEPENDENT_EVALUATION" || purposeKind === "INDEPENDENT_CRITIQUE")
    && admissionReason !== "INDEPENDENT_RISK_COVERAGE") {
    throw new TypeError("Independent Provider work requires an independent-risk admission reason");
  }
  if (purposeKind === "UNCERTAINTY_REDUCTION" && admissionReason !== "REDUCE_MATERIAL_UNCERTAINTY") {
    throw new TypeError("Provider uncertainty reduction requires a material-uncertainty admission reason");
  }
  if (purposeKind === "TASK_EXECUTION"
    && !["REDUCE_MATERIAL_UNCERTAINTY", "PARALLEL_CRITICAL_PATH"].includes(admissionReason)) {
    throw new TypeError("Provider task execution lacks a compatible admission reason");
  }
}

export function assertProviderCallPlanV1(value: ProviderCallPlanV1): void {
  const plan = record(value, "ProviderCallPlan");
  exactKeys(plan, planKeys, "ProviderCallPlan");
  if (plan.schema_version !== 1) throw new TypeError("ProviderCallPlan schema version is invalid");
  boundedId(plan.provider_call_plan_id, "ProviderCallPlan ID");
  boundedId(plan.goal_id, "ProviderCallPlan Goal ID");
  boundedId(plan.run_id, "ProviderCallPlan run ID");
  boundedId(plan.graph_revision_id, "ProviderCallPlan graph revision ID");
  sha256(plan.graph_revision_sha256, "ProviderCallPlan graph revision hash");
  boundedId(plan.node_id, "ProviderCallPlan node ID");
  sha256(plan.node_spec_sha256, "ProviderCallPlan node spec hash");
  boundedId(plan.packet_id, "ProviderCallPlan TaskPacket ID");
  integer(plan.attempt, 1, 65_536, "ProviderCallPlan node attempt");
  integer(plan.lease_generation, 1, Number.MAX_SAFE_INTEGER, "ProviderCallPlan lease generation");
  integer(plan.fencing_token, 1, Number.MAX_SAFE_INTEGER, "ProviderCallPlan fencing token");
  boundedId(plan.logical_request_id, "ProviderCallPlan logical request ID");
  sha256(plan.plan_nonce_sha256, "ProviderCallPlan nonce");
  const requestClass = member(plan.request_class, providerRequestClassesV1, "ProviderCallPlan request class");
  const purposeKind = member(plan.purpose_kind, providerPurposeKindsV1, "ProviderCallPlan purpose kind");
  boundedString(plan.purpose, "ProviderCallPlan purpose", 4_096);
  boundedId(plan.uncertainty_id, "ProviderCallPlan uncertainty ID");
  sha256(plan.uncertainty_sha256, "ProviderCallPlan uncertainty hash");
  assertInformationValue(plan.expected_information_gain, "Provider expected information gain");
  assertInformationValue(plan.expected_loss_if_skipped, "Provider expected loss if skipped");
  sha256(plan.minimum_input_closure_sha256, "Provider minimum input closure");
  const privacyClass = member(plan.privacy_class, providerPrivacyClassesV1, "Provider privacy class");
  assertAllowedFields(plan.allowed_fields, privacyClass, plan.allowed_fields_root_sha256);
  boundedId(plan.redaction_receipt_id, "Provider redaction receipt ID");
  sha256(plan.redaction_receipt_sha256, "Provider redaction receipt hash");
  assertProviderRuntimeProfileV1(plan.provider_profile as ProviderRuntimeProfileV1);
  if (sha256(plan.provider_profile_sha256, "Provider profile hash")
    !== (plan.provider_profile as ProviderRuntimeProfileV1).record_sha256) {
    throw new TypeError("ProviderCallPlan profile binding is invalid");
  }
  const admissionReason = member(plan.admission_reason, providerAdmissionReasonsV1, "Provider admission reason");
  assertPurposeCompatibility(requestClass, purposeKind, admissionReason);
  assertCachePlan(plan.cache);
  assertSuccessEvidence(plan.success_evidence, requestClass);
  assertLocalOracle(plan.local_oracle);
  assertFallback(plan.fallback);
  const attemptLimit = integer(plan.attempt_limit, 1, 16, "Provider attempt limit");
  const transportRequestLimit = integer(
    plan.transport_request_limit,
    1,
    256,
    "Provider transport request limit",
  );
  const fanOutLimit = integer(plan.fan_out_limit, 1, 8, "Provider fan-out limit");
  if (attemptLimit * transportRequestLimit * fanOutLimit > 4_096) {
    throw new TypeError("Provider total request hard limit exceeds 4096");
  }
  const independence = nullableSha256(plan.fan_out_independence_evidence_sha256, "Provider fan-out independence evidence");
  const branches = canonicalStringSet(plan.fan_out_branch_information_sha256s, "Provider fan-out branch information", {
    allowEmpty: true,
    sha256s: true,
  });
  if (fanOutLimit === 1 && (independence !== null || branches.length !== 0)) {
    throw new TypeError("Single Provider call cannot claim fan-out evidence");
  }
  if (fanOutLimit > 1) {
    if (independence === null || branches.length !== fanOutLimit) {
      throw new TypeError("Provider fan-out requires independent information evidence for every branch");
    }
    if (!["CANDIDATE_DIVERSIFICATION", "INDEPENDENT_EVALUATION", "INDEPENDENT_CRITIQUE"].includes(purposeKind)) {
      throw new TypeError("Provider fan-out is not admissible for this purpose");
    }
  }
  const noProgressLimit = integer(plan.no_progress_limit, 1, 16, "Provider no-progress limit");
  if (noProgressLimit > transportRequestLimit) {
    throw new TypeError("Provider no-progress limit exceeds the transport request limit");
  }
  sha256(plan.evidence_saturation_sha256, "Provider evidence-saturation rule hash");
  const stops = canonicalStringSet(plan.stop_conditions, "Provider stop conditions") as readonly ProviderStopConditionV1[];
  if (stops.length !== providerStopConditionsV1.length
    || providerStopConditionsV1.some((stop) => !stops.includes(stop))) {
    throw new TypeError("ProviderCallPlan lacks a mandatory stop condition");
  }
  if (plan.provider_output_authority !== "UNVERIFIED_PROPOSAL") {
    throw new TypeError("Provider output must remain an unverified proposal");
  }
  sha256(plan.predecessor_authority_head_sha256, "ProviderCallPlan predecessor authority head");
  const createdAt = integer(plan.created_at_ms, 0, Number.MAX_SAFE_INTEGER, "ProviderCallPlan creation time");
  assertRequestBudget(plan.request_budget, createdAt, fanOutLimit, transportRequestLimit);
  sealedHash("PCH-PROVIDER-CALL-PLAN-V1", plan, "ProviderCallPlan");
}

function normalizedAllowedFields(fields: readonly ProviderAllowedFieldV1[]): readonly ProviderAllowedFieldV1[] {
  const result = fields.map((field) => ({ ...field })).toSorted((left, right) => {
    const path = left.field_path === right.field_path ? 0 : left.field_path < right.field_path ? -1 : 1;
    return path !== 0 ? path
      : left.content_sha256 === right.content_sha256 ? 0 : left.content_sha256 < right.content_sha256 ? -1 : 1;
  });
  return result;
}

function sortedStrings<T extends string>(values: readonly T[]): readonly T[] {
  return [...values].toSorted();
}

export function finalizeProviderCallPlanV1(input: ProviderCallPlanDraftV1): ProviderCallPlanV1 {
  assertProviderRuntimeProfileV1(input.provider_profile);
  const attemptLimit = input.attempt_limit ?? 1;
  const transportRequestLimit = input.transport_request_limit ?? 1;
  const fanOutLimit = input.fan_out_limit ?? 1;
  const noProgressLimit = input.no_progress_limit ?? 1;
  const allowedFields = normalizedAllowedFields(input.allowed_fields);
  const allowedFieldsRootSha256 = canonicalJsonSha256({
    domain: "PCH-PROVIDER-ALLOWED-FIELDS-V1",
    members: allowedFields,
  });
  const identitySha256 = canonicalJsonSha256({
    domain: "PCH-PROVIDER-CALL-PLAN-IDENTITY-V1",
    goal_id: input.goal_id,
    run_id: input.run_id,
    packet_id: input.packet_id,
    attempt: input.attempt,
    lease_generation: input.lease_generation,
    fencing_token: input.fencing_token,
    logical_request_id: input.logical_request_id,
    plan_nonce_sha256: input.plan_nonce_sha256,
  });
  const body: Omit<ProviderCallPlanV1, "record_sha256"> = {
    schema_version: 1,
    provider_call_plan_id: idFromSha256("PROVIDER_PLAN", identitySha256),
    goal_id: input.goal_id,
    run_id: input.run_id,
    graph_revision_id: input.graph_revision_id,
    graph_revision_sha256: input.graph_revision_sha256,
    node_id: input.node_id,
    node_spec_sha256: input.node_spec_sha256,
    packet_id: input.packet_id,
    attempt: input.attempt,
    lease_generation: input.lease_generation,
    fencing_token: input.fencing_token,
    logical_request_id: input.logical_request_id,
    plan_nonce_sha256: input.plan_nonce_sha256,
    request_class: input.request_class,
    purpose_kind: input.purpose_kind,
    purpose: input.purpose,
    uncertainty_id: input.uncertainty_id,
    uncertainty_sha256: input.uncertainty_sha256,
    expected_information_gain: { ...input.expected_information_gain },
    expected_loss_if_skipped: { ...input.expected_loss_if_skipped },
    minimum_input_closure_sha256: input.minimum_input_closure_sha256,
    privacy_class: input.privacy_class,
    allowed_fields: allowedFields,
    allowed_fields_root_sha256: allowedFieldsRootSha256,
    redaction_receipt_id: input.redaction_receipt_id,
    redaction_receipt_sha256: input.redaction_receipt_sha256,
    provider_profile: input.provider_profile,
    provider_profile_sha256: input.provider_profile.record_sha256,
    request_budget: { ...input.request_budget },
    admission_reason: input.admission_reason,
    cache: { ...input.cache },
    success_evidence: { ...input.success_evidence },
    local_oracle: {
      ...input.local_oracle,
      covered_obligation_ids: sortedStrings(input.local_oracle.covered_obligation_ids),
    },
    fallback: { ...input.fallback },
    attempt_limit: attemptLimit,
    transport_request_limit: transportRequestLimit,
    fan_out_limit: fanOutLimit,
    fan_out_independence_evidence_sha256: input.fan_out_independence_evidence_sha256 ?? null,
    fan_out_branch_information_sha256s: sortedStrings(input.fan_out_branch_information_sha256s ?? []),
    no_progress_limit: noProgressLimit,
    evidence_saturation_sha256: input.evidence_saturation_sha256,
    stop_conditions: sortedStrings(input.stop_conditions),
    provider_output_authority: "UNVERIFIED_PROPOSAL",
    predecessor_authority_head_sha256: input.predecessor_authority_head_sha256,
    created_at_ms: input.created_at_ms,
  };
  const plan: ProviderCallPlanV1 = {
    ...body,
    record_sha256: canonicalJsonSha256({ domain: "PCH-PROVIDER-CALL-PLAN-V1", ...body }),
  };
  assertProviderCallPlanV1(plan);
  return deepFreeze(plan);
}

export function providerCallPlanCanonicalJsonV1(plan: ProviderCallPlanV1): string {
  assertProviderCallPlanV1(plan);
  return canonicalJson(plan);
}
