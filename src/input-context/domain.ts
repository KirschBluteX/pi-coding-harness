import { assertInputContextRecordSha256, inputContextHashDomains } from "./canonical.js";
import { assertExecutionSubjectRef, type ExecutionSubjectRef } from "../task-flow/domain.js";

export const contextProfiles = [
  "PASS_THROUGH", "RETAINED_DELTA", "TARGETED_EVIDENCE", "STRUCTURAL_DISCOVERY", "RECOVERY",
] as const;
export type ContextProfile = typeof contextProfiles[number];

export const obligationRoles = [
  "CONTROL", "NEXT_ACTION", "WRITE_TARGET", "VALIDATION", "FAILURE", "ACCEPTANCE", "DISCOVERY",
] as const;
export type ObligationRole = typeof obligationRoles[number];

export const obligationConfidences = ["PROVEN_REQUIRED", "LIKELY_RELEVANT", "UNKNOWN_DISCOVERY"] as const;
export type ObligationConfidence = typeof obligationConfidences[number];

export const sourceKinds = [
  "AUTHORITY", "FILE_RANGE", "QUERY", "TOOL_RESULT", "ARTIFACT", "MEMORY", "STRUCTURAL_MAP", "OUTPUT_DIRECTIVE",
] as const;
export type ContextSourceKind = typeof sourceKinds[number];

export const contentFreshnessValues = ["HASH_CURRENT", "CHANGE_WITNESS_CURRENT", "STALE", "UNKNOWN", "NOT_APPLICABLE"] as const;
export type ContentFreshness = typeof contentFreshnessValues[number];
export const scopeAuthorizationValues = ["AUTHORIZED", "DENIED", "UNKNOWN"] as const;
export type ScopeAuthorization = typeof scopeAuthorizationValues[number];
export const semanticApplicabilityValues = ["CURRENT", "SUPERSEDED", "UNKNOWN", "NOT_APPLICABLE"] as const;
export type SemanticApplicability = typeof semanticApplicabilityValues[number];
export const representationFidelityValues = ["EXACT_RAW", "EXACT_DECODED", "TYPED_EXTRACT", "LOSSY_EXCERPT", "OPAQUE", "UNKNOWN"] as const;
export type RepresentationFidelity = typeof representationFidelityValues[number];
export const contextTrustValues = ["AUTHORITY", "VERIFIED_EVIDENCE", "UNTRUSTED_CONTEXT"] as const;
export type ContextTrust = typeof contextTrustValues[number];
export const classifications = ["PUBLIC", "INTERNAL", "SENSITIVE"] as const;
export type ContextClassification = typeof classifications[number];

export const contextDispositions = [
  "MANDATORY_INLINE", "ALREADY_RETAINED", "INLINE_EXACT", "INLINE_TYPED_EXTRACT", "ON_DEMAND",
  "REREAD_REQUIRED", "HISTORICAL_ONLY", "OMIT_CLOSED", "OMIT_UNAUTHORIZED", "OMIT_BUDGET_OPTIONAL",
] as const;
export type ContextDisposition = typeof contextDispositions[number];
export const ordinalClasses = ["STABLE_POLICY", "CONTROL", "EVIDENCE", "DIRECTIVE"] as const;
export type ContextOrdinalClass = typeof ordinalClasses[number];
export const contextFitDispositions = ["FIT", "FIT_WITH_ON_DEMAND", "BASELINE_FALLBACK", "RECOVERY_REQUIRED"] as const;
export type ContextFitDisposition = typeof contextFitDispositions[number];

export interface EvidenceObligationRecord {
  readonly obligation_id: string;
  readonly role: ObligationRole;
  readonly confidence: ObligationConfidence;
  readonly source_refs: readonly string[];
  readonly must_be_current: boolean;
  readonly must_be_exact: boolean;
  readonly authorization_scope_sha256: string;
  readonly semantic_scope_sha256: string;
}

export interface ContextDemandRecord {
  readonly schema_version: 1;
  readonly demand_id: string;
  readonly subject: ExecutionSubjectRef;
  readonly profile: ContextProfile;
  readonly next_action_sha256: string | null;
  readonly obligations: readonly EvidenceObligationRecord[];
  readonly source_closure_root_sha256: string | null;
  readonly acceptance_closure_root_sha256: string | null;
  readonly context_pressure: "LOW" | "MEDIUM" | "HIGH" | "UNKNOWN";
  readonly runtime_fingerprint_sha256: string;
  readonly record_sha256: string;
}

export interface ContextCandidateRecord {
  readonly schema_version: 1;
  readonly candidate_id: string;
  readonly source_kind: ContextSourceKind;
  readonly content_freshness: ContentFreshness;
  readonly scope_authorization: ScopeAuthorization;
  readonly semantic_applicability: SemanticApplicability;
  readonly representation_fidelity: RepresentationFidelity;
  readonly trust: ContextTrust;
  readonly obligation_ids: readonly string[];
  readonly evidence_sha256: string;
  readonly dependency_signature_sha256: string;
  readonly artifact_locator: string | null;
  readonly estimated_tokens: number | null;
  readonly classification: ContextClassification;
  readonly record_sha256: string;
}

export interface ContextIrItemRecord {
  readonly candidate_id: string;
  readonly obligation_ids: readonly string[];
  readonly evidence_sha256: string;
  readonly disposition: ContextDisposition;
  readonly reason_code: string;
  readonly ordinal_class: ContextOrdinalClass;
  readonly content_identity_hmac: string;
  readonly retained_entry_id: string | null;
  readonly source_version_handle_hmac: string | null;
  readonly projected_tokens: number;
}

export interface ContextWorkingSetRecord {
  readonly schema_version: 1;
  readonly working_set_id: string;
  readonly subject: ExecutionSubjectRef;
  readonly profile: ContextProfile;
  readonly context_demand_sha256: string;
  readonly retained_root_sha256: string;
  readonly source_closure_root_sha256: string | null;
  readonly acceptance_closure_root_sha256: string | null;
  readonly items: readonly ContextIrItemRecord[];
  readonly created_at_ms: number;
  readonly record_sha256: string;
}

export interface ContextEnvelopeRecord {
  readonly schema_version: 1;
  readonly envelope_id: string;
  readonly subject: ExecutionSubjectRef;
  readonly profile: ContextProfile;
  readonly prompt_generation_id: string | null;
  readonly retained_root_sha256: string;
  readonly source_closure_root_sha256: string | null;
  readonly acceptance_closure_root_sha256: string | null;
  readonly mandatory_coverage_root_sha256: string;
  readonly context_demand_root_sha256: string;
  readonly items: readonly ContextIrItemRecord[];
  readonly estimated_projected_tokens: number;
  readonly fit_disposition: ContextFitDisposition;
  readonly record_sha256: string;
}

export interface ContextCompileReceiptRecord {
  readonly schema_version: 1;
  readonly compile_receipt_id: string;
  readonly working_set_id: string;
  readonly envelope_sha256: string;
  readonly input_closure_sha256: string;
  readonly mandatory_obligation_count: number;
  readonly mandatory_covered_count: number;
  readonly discovery_debt_count: number;
  readonly omitted_optional_count: number;
  readonly fallback: "NONE" | "PI_BASELINE" | "FRESH_READ" | "NATIVE_RECOVERY";
  readonly duration_micros: number;
  readonly created_at_ms: number;
  readonly receipt_sha256: string;
}

export interface LayoutSegmentManifestEntryRecord {
  readonly segment_type: string;
  readonly ordinal: number;
  readonly lifecycle: "LINEAGE_STABLE" | "GENERATION_STABLE" | "APPEND_ONLY_DELTA";
  readonly source_binding_sha256: string;
  readonly semantic_version: string;
  readonly byte_length: number;
  readonly estimated_tokens: number;
  readonly content_identity_hmac: string;
  readonly predecessor_hmac: string | null;
  readonly contains_user_content: boolean;
}

export interface ContextLayoutManifestRecord {
  readonly schema_version: 1;
  readonly layout_manifest_id: string;
  readonly context_envelope_sha256: string;
  readonly prompt_generation_id: string | null;
  readonly ordered_segment_root_sha256: string;
  readonly segment_count: number;
  readonly entries: readonly LayoutSegmentManifestEntryRecord[];
  readonly canonical_encoder_version: string;
  readonly record_sha256: string;
}

export const toolSurfaceStrategies = [
  "PRESERVE_USER_FULL", "PCH_CORE_DEFERRED", "ADDITIVE_TASK_DISCOVERY", "TASK_SCOPED_REPLACEMENT",
] as const;
export type ToolSurfaceStrategy = typeof toolSurfaceStrategies[number];

export interface ToolSurfacePlanRecord {
  readonly schema_version: 1;
  readonly tool_surface_plan_id: string;
  readonly context_envelope_sha256: string;
  readonly strategy: ToolSurfaceStrategy;
  readonly user_tool_configuration_sha256: string;
  readonly active_tool_manifest_sha256: string;
  readonly deferred_tool_manifest_sha256: string | null;
  readonly capability_epoch_sha256: string;
  readonly record_sha256: string;
}

export const projectionStates = ["PREPARED", "APPLIED", "REQUEST_OBSERVED", "OUTCOME_UNKNOWN", "COMPLETED", "ABANDONED"] as const;
export type ProjectionState = typeof projectionStates[number];
export const providerPayloadFinalities = ["PCH_HOOK_INPUT", "PCH_HOOK_OUTPUT", "EXTENSION_CHAIN_FINAL", "WIRE_SERIALIZED"] as const;
export type ProviderPayloadFinality = typeof providerPayloadFinalities[number];

export interface ContextProjectionReceiptRecord {
  readonly schema_version: 1;
  readonly projection_id: string;
  readonly transition_ordinal: number;
  readonly context_envelope_sha256: string;
  readonly tool_surface_plan_sha256: string;
  readonly layout_manifest_sha256: string;
  readonly retained_root_sha256: string;
  readonly runtime_fingerprint_sha256: string;
  readonly subject: ExecutionSubjectRef;
  readonly prompt_generation_id: string | null;
  readonly projection_state: ProjectionState;
  readonly idempotency_key_hmac: string;
  readonly finality: ProviderPayloadFinality;
  readonly created_at_ms: number;
  readonly receipt_sha256: string;
}

export const evidenceCaptureKinds = [
  "FULL_FILE", "BYTE_RANGE", "LINE_RANGE", "QUERY_SCOPE", "TOOL_OUTPUT", "IMMUTABLE_ARTIFACT", "STRUCTURAL_EXTRACT",
] as const;
export type EvidenceCaptureKind = typeof evidenceCaptureKinds[number];
export const queryCompletenessValues = ["COMPLETE", "PARTIAL", "NOT_APPLICABLE", "UNKNOWN"] as const;
export type QueryCompleteness = typeof queryCompletenessValues[number];

export interface ReadEvidenceReceiptRecord {
  readonly schema_version: 1;
  readonly receipt_id: string;
  readonly workspace_id: string;
  readonly subject: ExecutionSubjectRef;
  readonly source_kind: ContextSourceKind;
  readonly capture_kind: EvidenceCaptureKind;
  readonly evidence_sha256: string;
  readonly artifact_ref_hmac: string | null;
  readonly dependency_signature_sha256: string;
  readonly source_scope_hmac: string;
  readonly source_version_handle_hmac: string | null;
  readonly query_completeness: QueryCompleteness;
  readonly content_freshness: ContentFreshness;
  readonly scope_authorization: ScopeAuthorization;
  readonly semantic_applicability: SemanticApplicability;
  readonly representation_fidelity: RepresentationFidelity;
  readonly classification: ContextClassification;
  readonly adapter_version: string;
  readonly observed_at_ms: number;
  readonly receipt_sha256: string;
}

export type EvidenceValidityAxis = "CONTENT_FRESHNESS" | "SCOPE_AUTHORIZATION" | "SEMANTIC_APPLICABILITY" | "REPRESENTATION_FIDELITY";
export interface EvidenceValidityTransitionRecord {
  readonly transition_id: string;
  readonly receipt_id: string;
  readonly axis: EvidenceValidityAxis;
  readonly value: ContentFreshness | ScopeAuthorization | SemanticApplicability | RepresentationFidelity;
  readonly reason_code: string;
  readonly evidence_sha256: string;
  readonly created_at_ms: number;
  readonly transition_sha256: string;
}

export interface ContextRetentionRootRecord {
  readonly retention_root_id: string;
  readonly workspace_id: string;
  readonly subject: ExecutionSubjectRef;
  readonly artifact_sha256: string;
  readonly retention_class: "TURN" | "STAGE" | "GOAL" | "RECOVERY";
  readonly expires_at_ms: number | null;
  readonly created_at_ms: number;
  readonly root_sha256: string;
}

export const tokenEvidenceValues = ["PROVIDER_REPORTED", "SERIALIZER_PROVEN", "TOKENIZER_PROVEN", "LOCAL_ESTIMATE", "UNOBSERVABLE"] as const;
export type TokenEvidence = typeof tokenEvidenceValues[number];
export const inputSurfaces = [
  "PI_BASE_SYSTEM", "PCH_STABLE_POLICY", "PCH_WORKFLOW_CONTROL", "PCH_PROTECTED_AUTHORITY", "PCH_MEMORY",
  "PCH_EVIDENCE", "PCH_TOOL_RESULT", "PCH_RESPONSE_DIRECTIVE", "PCH_RECOVERY_CAPSULE",
  "PI_NATIVE_COMPACTION_SUMMARY", "USER_HISTORY", "ASSISTANT_HISTORY", "TOOL_SCHEMAS", "PROVIDER_FRAMING",
  "UNATTRIBUTED_INPUT",
] as const;
export type InputSurface = typeof inputSurfaces[number];
export const outputSurfaces = [
  "ASSISTANT_TEXT", "TOOL_CALL_ARGUMENTS", "REASONING", "NATIVE_COMPACTION_SUMMARY",
  "CUSTOM_COMPACTION_SUMMARY", "UNATTRIBUTED_OUTPUT",
] as const;
export type OutputSurface = typeof outputSurfaces[number];
export const contributionOwners = ["PI", "INPUT_CONTEXT", "MEMORY", "OUTPUT", "COMPACTION", "USER", "PROVIDER"] as const;
export type ContributionOwner = typeof contributionOwners[number];

export interface ProviderTurnRequestRecord {
  readonly schema_version: 1;
  readonly prompt_request_id: string;
  readonly prompt_generation_id: string;
  readonly previous_prompt_request_id: string | null;
  readonly request_sequence: number;
  readonly logical_request_hmac_sha256: string;
  readonly payload_shape_sha256: string;
  readonly message_descriptor_root_sha256: string;
  readonly message_count: number;
  readonly logical_message_bytes: number;
  readonly user_history_bytes: number;
  readonly assistant_history_bytes: number;
  readonly other_history_bytes: number;
  readonly tool_schema_bytes: number;
  readonly created_at_ms: number;
  readonly record_sha256: string;
}

export interface ProviderTurnContributionRecord {
  readonly contribution_id: string;
  readonly owner: ContributionOwner;
  readonly input_surface: InputSurface | null;
  readonly output_surface: OutputSurface | null;
  readonly segment_identity_hmac: string | null;
  readonly logical_bytes: number | null;
  readonly tokens: number | null;
  readonly evidence: TokenEvidence;
  readonly included: boolean;
  readonly duplicate_of: string | null;
}

export interface ProviderTurnLedgerRecord {
  readonly schema_version: 1;
  readonly prompt_request_id: string;
  readonly prompt_generation_id: string | null;
  readonly context_envelope_sha256: string | null;
  readonly layout_manifest_sha256: string | null;
  readonly contributions: readonly ProviderTurnContributionRecord[];
  readonly provider_uncached_input_tokens: number | null;
  readonly provider_cache_read_tokens: number | null;
  readonly provider_cache_write_tokens: number | null;
  readonly provider_generated_output_tokens: number | null;
  readonly provider_reasoning_tokens: number | null;
  readonly attributed_input_tokens: number | null;
  readonly unattributed_input_tokens: number | null;
  readonly attributed_output_tokens: number | null;
  readonly unattributed_output_tokens: number | null;
  readonly accounting_completeness: "COMPLETE" | "PARTIAL" | "UNOBSERVABLE";
  readonly additional_model_requests: 0;
  readonly additional_provider_requests: 0;
  readonly created_at_ms: number;
  readonly record_sha256: string;
}

export interface ProviderTurnGoalBindingRecord {
  readonly schema_version: 1;
  readonly prompt_request_id: string;
  readonly prompt_request_sha256: string;
  readonly goal_id: string;
  readonly run_id: string;
  readonly session_id: string;
  readonly created_at_ms: number;
  readonly record_sha256: string;
}

export interface ProviderTurnAttemptRecord {
  readonly schema_version: 1;
  readonly attempt_id: string;
  readonly prompt_request_id: string;
  readonly attempt_number: number;
  readonly transition_ordinal: number;
  readonly request_identity_hmac: string;
  readonly payload_identity_hmac: string | null;
  readonly payload_finality: ProviderPayloadFinality;
  readonly started_at_ms: number;
  readonly completed_at_ms: number | null;
  readonly response_status: number | null;
  readonly outcome: "STARTED" | "RESPONDED" | "FAILED" | "OUTCOME_UNKNOWN";
  readonly usage_contribution_sha256: string | null;
  readonly record_sha256: string;
}

export interface ContextEpisodeObservationRecord {
  readonly schema_version: 1;
  readonly observation_id: string;
  readonly epoch_id: string;
  readonly subject: ExecutionSubjectRef;
  readonly prompt_request_id: string | null;
  readonly arm: "BASELINE" | "OBSERVE" | "CANDIDATE";
  readonly quality_gate: "PASS" | "FAIL" | "UNOBSERVABLE";
  readonly acceptance_gate: "PASS" | "FAIL" | "UNOBSERVABLE";
  readonly accounting_completeness: "COMPLETE" | "PARTIAL" | "UNOBSERVABLE";
  readonly provider_requests: number;
  readonly physical_attempts: number | null;
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly ordinary_reads: number;
  readonly context_batch_reads: number;
  readonly rereads: number;
  readonly follow_ups: number;
  readonly reopens: number;
  readonly rework_events: number;
  readonly wall_time_ms: number;
  readonly contains_prompt_content: false;
  readonly record_sha256: string;
}

export const projectSourceKinds = ["PROJECT_GUIDE", "PROJECT_DOCUMENT", "USER_SELECTED_STRATEGY", "CONFIGURATION", "OTHER"] as const;
export type ProjectSourceKind = typeof projectSourceKinds[number];

export interface ProjectSourceManifestEntryRecord {
  readonly source_id: string;
  readonly source_kind: ProjectSourceKind;
  readonly workspace_path_hmac: string;
  readonly content_sha256: string;
  readonly source_version_handle_hmac: string;
  readonly trust: ContextTrust;
  readonly content_freshness: ContentFreshness;
  readonly representation_fidelity: RepresentationFidelity;
  readonly classification: ContextClassification;
}

export interface ProjectSourceManifestRecord {
  readonly schema_version: 1;
  readonly manifest_id: string;
  readonly workspace_id: string;
  readonly subject: ExecutionSubjectRef;
  readonly entries: readonly ProjectSourceManifestEntryRecord[];
  readonly created_at_ms: number;
  readonly record_sha256: string;
}

export interface ProjectKnowledgeClaimRecord {
  readonly schema_version: 1;
  readonly claim_id: string;
  readonly manifest_id: string;
  readonly source_id: string;
  readonly subject: ExecutionSubjectRef;
  readonly semantic_key: string;
  readonly statement_sha256: string;
  readonly source_range_sha256: string;
  readonly evidence_sha256: string;
  readonly trust: ContextTrust;
  readonly content_freshness: ContentFreshness;
  readonly scope_authorization: ScopeAuthorization;
  readonly semantic_applicability: SemanticApplicability;
  readonly representation_fidelity: RepresentationFidelity;
  readonly authority_status: "EVIDENCE_ONLY" | "FROZEN_IN_GOAL_CONTRACT";
  readonly frozen_goal_contract_sha256: string | null;
  readonly created_at_ms: number;
  readonly record_sha256: string;
}

export interface InputContextActivationDependencyRecord {
  readonly source_id: string;
  readonly role: string;
  readonly sha256: string;
}

export interface InputContextActivationRecord {
  readonly schema_version: 1;
  readonly activation_id: string;
  readonly blueprint_revision: string;
  readonly mode: "OFF" | "OBSERVE" | "AUTO_GUARDED";
  readonly activation_basis: "NONE" | "MATCHED_PROMOTION" | "USER_EXPLICIT_UNVALIDATED";
  readonly effectiveness_verdict: "PASS" | "NOT_EVALUATED";
  readonly runtime_fingerprint_sha256: string;
  readonly dependencies: readonly InputContextActivationDependencyRecord[];
  readonly result: "PASS" | "FAIL" | "INCONCLUSIVE";
  readonly fallback: "PI_BASELINE";
  readonly additional_model_requests: 0;
  readonly additional_provider_requests: 0;
  readonly created_at_ms: number;
  readonly record_sha256: string;
}

type UnknownRecord = Record<string, unknown>;
const idPattern = /^[A-Z0-9][A-Z0-9._:-]{0,127}$/u;
const shaPattern = /^[a-f0-9]{64}$/u;
const versionPattern = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u;
const forbiddenCharacters = new Set(Array.from({ length: 32 }, (_, index) => String.fromCharCode(index)).concat(String.fromCharCode(127)));

function record(value: unknown, label: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value as UnknownRecord;
}

function exactKeys(value: UnknownRecord, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} fields are not the frozen contract`);
  }
}

function id(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !idPattern.test(value)) throw new TypeError(`${label} must be a bounded PCH ID`);
}

function nullableId(value: unknown, label: string): void {
  if (value !== null) id(value, label);
}

function sha(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !shaPattern.test(value)) throw new TypeError(`${label} must be lowercase SHA-256`);
}

function nullableSha(value: unknown, label: string): void {
  if (value !== null) sha(value, label);
}

function boundedString(value: unknown, label: string, maxLength = 128): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || [...value].some((entry) => forbiddenCharacters.has(entry))) {
    throw new TypeError(`${label} must be bounded printable text`);
  }
}

function integer(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new TypeError(`${label} must be a bounded non-negative integer`);
  }
}

function nullableInteger(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): asserts value is number | null {
  if (value !== null) integer(value, label, maximum);
}

function booleanValue(value: unknown, label: string): asserts value is boolean {
  if (typeof value !== "boolean") throw new TypeError(`${label} must be boolean`);
}

function enumValue<T extends string>(value: unknown, values: readonly T[], label: string): asserts value is T {
  if (typeof value !== "string" || !values.includes(value as T)) throw new TypeError(`${label} is outside the frozen enum`);
}

function boundedIds(value: unknown, label: string, maximum: number): asserts value is string[] {
  if (!Array.isArray(value) || value.length > maximum) throw new TypeError(`${label} must be a bounded array`);
  const seen = new Set<string>();
  for (const entry of value) {
    id(entry, `${label} item`);
    if (seen.has(entry)) throw new TypeError(`${label} contains a duplicate`);
    seen.add(entry);
  }
}

function schemaVersion(value: unknown, label: string): void {
  if (value !== 1) throw new TypeError(`${label} schema_version must be 1`);
}

function assertObligation(value: unknown): asserts value is EvidenceObligationRecord {
  const item = record(value, "EvidenceObligation");
  exactKeys(item, ["obligation_id", "role", "confidence", "source_refs", "must_be_current", "must_be_exact", "authorization_scope_sha256", "semantic_scope_sha256"], "EvidenceObligation");
  id(item.obligation_id, "EvidenceObligation.obligation_id");
  enumValue(item.role, obligationRoles, "EvidenceObligation.role");
  enumValue(item.confidence, obligationConfidences, "EvidenceObligation.confidence");
  boundedIds(item.source_refs, "EvidenceObligation.source_refs", 64);
  booleanValue(item.must_be_current, "EvidenceObligation.must_be_current");
  booleanValue(item.must_be_exact, "EvidenceObligation.must_be_exact");
  sha(item.authorization_scope_sha256, "EvidenceObligation.authorization_scope_sha256");
  sha(item.semantic_scope_sha256, "EvidenceObligation.semantic_scope_sha256");
}

function assertIrItem(value: unknown): asserts value is ContextIrItemRecord {
  const item = record(value, "ContextIrItem");
  exactKeys(item, ["candidate_id", "obligation_ids", "evidence_sha256", "disposition", "reason_code", "ordinal_class", "content_identity_hmac", "retained_entry_id", "source_version_handle_hmac", "projected_tokens"], "ContextIrItem");
  id(item.candidate_id, "ContextIrItem.candidate_id");
  boundedIds(item.obligation_ids, "ContextIrItem.obligation_ids", 128);
  sha(item.evidence_sha256, "ContextIrItem.evidence_sha256");
  enumValue(item.disposition, contextDispositions, "ContextIrItem.disposition");
  boundedString(item.reason_code, "ContextIrItem.reason_code", 96);
  enumValue(item.ordinal_class, ordinalClasses, "ContextIrItem.ordinal_class");
  sha(item.content_identity_hmac, "ContextIrItem.content_identity_hmac");
  nullableId(item.retained_entry_id, "ContextIrItem.retained_entry_id");
  nullableSha(item.source_version_handle_hmac, "ContextIrItem.source_version_handle_hmac");
  integer(item.projected_tokens, "ContextIrItem.projected_tokens", 10_000_000);
  if (item.disposition === "ALREADY_RETAINED" && item.retained_entry_id === null) {
    throw new TypeError("ALREADY_RETAINED requires retained_entry_id");
  }
  if (["MANDATORY_INLINE", "INLINE_EXACT", "INLINE_TYPED_EXTRACT"].includes(String(item.disposition))
    && (item.disposition !== "MANDATORY_INLINE" || item.source_version_handle_hmac !== null)
    && item.source_version_handle_hmac === null) {
    throw new TypeError("current-source inline evidence requires source_version_handle_hmac");
  }
}

function assertIrItems(value: unknown, label: string): asserts value is ContextIrItemRecord[] {
  if (!Array.isArray(value) || value.length > 4096) throw new TypeError(`${label} must be a bounded array`);
  const candidates = new Set<string>();
  for (const item of value) {
    assertIrItem(item);
    if (candidates.has(item.candidate_id)) throw new TypeError(`${label} contains duplicate candidate_id`);
    candidates.add(item.candidate_id);
  }
}

export function assertContextDemand(value: unknown): asserts value is ContextDemandRecord {
  const item = record(value, "ContextDemand");
  exactKeys(item, ["schema_version", "demand_id", "subject", "profile", "next_action_sha256", "obligations", "source_closure_root_sha256", "acceptance_closure_root_sha256", "context_pressure", "runtime_fingerprint_sha256", "record_sha256"], "ContextDemand");
  schemaVersion(item.schema_version, "ContextDemand"); id(item.demand_id, "ContextDemand.demand_id");
  assertExecutionSubjectRef(item.subject);
  enumValue(item.profile, contextProfiles, "ContextDemand.profile"); nullableSha(item.next_action_sha256, "ContextDemand.next_action_sha256");
  if (!Array.isArray(item.obligations) || item.obligations.length > 128) throw new TypeError("ContextDemand.obligations must be bounded");
  const obligations = new Set<string>();
  for (const obligation of item.obligations) { assertObligation(obligation); if (obligations.has(obligation.obligation_id)) throw new TypeError("ContextDemand obligation IDs must be unique"); obligations.add(obligation.obligation_id); }
  nullableSha(item.source_closure_root_sha256, "ContextDemand.source_closure_root_sha256");
  nullableSha(item.acceptance_closure_root_sha256, "ContextDemand.acceptance_closure_root_sha256");
  enumValue(item.context_pressure, ["LOW", "MEDIUM", "HIGH", "UNKNOWN"] as const, "ContextDemand.context_pressure");
  sha(item.runtime_fingerprint_sha256, "ContextDemand.runtime_fingerprint_sha256"); sha(item.record_sha256, "ContextDemand.record_sha256");
  if (item.profile === "PASS_THROUGH" && (item.subject.kind !== "NONE" || item.obligations.length !== 0)) {
    throw new TypeError("PASS_THROUGH demand cannot claim managed Goal obligations");
  }
  if (item.profile !== "PASS_THROUGH" && item.subject.kind === "NONE") throw new TypeError("managed context demand requires an execution subject");
  assertInputContextRecordSha256(inputContextHashDomains.contextDemand, item, "record_sha256");
}

export function assertContextCandidate(value: unknown): asserts value is ContextCandidateRecord {
  const item = record(value, "ContextCandidate");
  exactKeys(item, ["schema_version", "candidate_id", "source_kind", "content_freshness", "scope_authorization", "semantic_applicability", "representation_fidelity", "trust", "obligation_ids", "evidence_sha256", "dependency_signature_sha256", "artifact_locator", "estimated_tokens", "classification", "record_sha256"], "ContextCandidate");
  schemaVersion(item.schema_version, "ContextCandidate"); id(item.candidate_id, "ContextCandidate.candidate_id");
  enumValue(item.source_kind, sourceKinds, "ContextCandidate.source_kind"); enumValue(item.content_freshness, contentFreshnessValues, "ContextCandidate.content_freshness");
  enumValue(item.scope_authorization, scopeAuthorizationValues, "ContextCandidate.scope_authorization"); enumValue(item.semantic_applicability, semanticApplicabilityValues, "ContextCandidate.semantic_applicability");
  enumValue(item.representation_fidelity, representationFidelityValues, "ContextCandidate.representation_fidelity"); enumValue(item.trust, contextTrustValues, "ContextCandidate.trust");
  boundedIds(item.obligation_ids, "ContextCandidate.obligation_ids", 128); sha(item.evidence_sha256, "ContextCandidate.evidence_sha256"); sha(item.dependency_signature_sha256, "ContextCandidate.dependency_signature_sha256");
  if (item.artifact_locator !== null) { boundedString(item.artifact_locator, "ContextCandidate.artifact_locator", 512); if (/^(?:[A-Za-z]:[\\/]|\\\\|\/)/u.test(item.artifact_locator)) throw new TypeError("ContextCandidate artifact locator cannot be an absolute path"); }
  nullableInteger(item.estimated_tokens, "ContextCandidate.estimated_tokens", 10_000_000); enumValue(item.classification, classifications, "ContextCandidate.classification"); sha(item.record_sha256, "ContextCandidate.record_sha256");
  assertInputContextRecordSha256(inputContextHashDomains.contextCandidate, item, "record_sha256");
}

export function assertContextWorkingSet(value: unknown): asserts value is ContextWorkingSetRecord {
  const item = record(value, "ContextWorkingSet");
  exactKeys(item, ["schema_version", "working_set_id", "subject", "profile", "context_demand_sha256", "retained_root_sha256", "source_closure_root_sha256", "acceptance_closure_root_sha256", "items", "created_at_ms", "record_sha256"], "ContextWorkingSet");
  schemaVersion(item.schema_version, "ContextWorkingSet"); id(item.working_set_id, "ContextWorkingSet.working_set_id"); assertExecutionSubjectRef(item.subject);
  enumValue(item.profile, contextProfiles, "ContextWorkingSet.profile"); sha(item.context_demand_sha256, "ContextWorkingSet.context_demand_sha256"); sha(item.retained_root_sha256, "ContextWorkingSet.retained_root_sha256");
  nullableSha(item.source_closure_root_sha256, "ContextWorkingSet.source_closure_root_sha256"); nullableSha(item.acceptance_closure_root_sha256, "ContextWorkingSet.acceptance_closure_root_sha256");
  assertIrItems(item.items, "ContextWorkingSet.items"); integer(item.created_at_ms, "ContextWorkingSet.created_at_ms"); sha(item.record_sha256, "ContextWorkingSet.record_sha256");
  assertInputContextRecordSha256(inputContextHashDomains.contextWorkingSet, item, "record_sha256");
}

export function assertContextEnvelope(value: unknown): asserts value is ContextEnvelopeRecord {
  const item = record(value, "ContextEnvelope");
  exactKeys(item, ["schema_version", "envelope_id", "subject", "profile", "prompt_generation_id", "retained_root_sha256", "source_closure_root_sha256", "acceptance_closure_root_sha256", "mandatory_coverage_root_sha256", "context_demand_root_sha256", "items", "estimated_projected_tokens", "fit_disposition", "record_sha256"], "ContextEnvelope");
  schemaVersion(item.schema_version, "ContextEnvelope"); id(item.envelope_id, "ContextEnvelope.envelope_id"); assertExecutionSubjectRef(item.subject); enumValue(item.profile, contextProfiles, "ContextEnvelope.profile"); nullableId(item.prompt_generation_id, "ContextEnvelope.prompt_generation_id");
  sha(item.retained_root_sha256, "ContextEnvelope.retained_root_sha256"); nullableSha(item.source_closure_root_sha256, "ContextEnvelope.source_closure_root_sha256"); nullableSha(item.acceptance_closure_root_sha256, "ContextEnvelope.acceptance_closure_root_sha256"); sha(item.mandatory_coverage_root_sha256, "ContextEnvelope.mandatory_coverage_root_sha256"); sha(item.context_demand_root_sha256, "ContextEnvelope.context_demand_root_sha256");
  assertIrItems(item.items, "ContextEnvelope.items"); integer(item.estimated_projected_tokens, "ContextEnvelope.estimated_projected_tokens", 10_000_000); enumValue(item.fit_disposition, contextFitDispositions, "ContextEnvelope.fit_disposition"); sha(item.record_sha256, "ContextEnvelope.record_sha256");
  const projected = item.items.reduce((total, entry) => total + entry.projected_tokens, 0);
  if (projected !== item.estimated_projected_tokens) throw new TypeError("ContextEnvelope projected token total does not close");
  assertInputContextRecordSha256(inputContextHashDomains.contextEnvelope, item, "record_sha256");
}

export function assertContextCompileReceipt(value: unknown): asserts value is ContextCompileReceiptRecord {
  const item = record(value, "ContextCompileReceipt");
  exactKeys(item, ["schema_version", "compile_receipt_id", "working_set_id", "envelope_sha256", "input_closure_sha256", "mandatory_obligation_count", "mandatory_covered_count", "discovery_debt_count", "omitted_optional_count", "fallback", "duration_micros", "created_at_ms", "receipt_sha256"], "ContextCompileReceipt");
  schemaVersion(item.schema_version, "ContextCompileReceipt"); id(item.compile_receipt_id, "ContextCompileReceipt.compile_receipt_id"); id(item.working_set_id, "ContextCompileReceipt.working_set_id"); sha(item.envelope_sha256, "ContextCompileReceipt.envelope_sha256"); sha(item.input_closure_sha256, "ContextCompileReceipt.input_closure_sha256");
  integer(item.mandatory_obligation_count, "ContextCompileReceipt.mandatory_obligation_count", 128); integer(item.mandatory_covered_count, "ContextCompileReceipt.mandatory_covered_count", 128); integer(item.discovery_debt_count, "ContextCompileReceipt.discovery_debt_count", 128); integer(item.omitted_optional_count, "ContextCompileReceipt.omitted_optional_count", 4096);
  enumValue(item.fallback, ["NONE", "PI_BASELINE", "FRESH_READ", "NATIVE_RECOVERY"] as const, "ContextCompileReceipt.fallback"); integer(item.duration_micros, "ContextCompileReceipt.duration_micros", 60_000_000); integer(item.created_at_ms, "ContextCompileReceipt.created_at_ms"); sha(item.receipt_sha256, "ContextCompileReceipt.receipt_sha256");
  if (item.mandatory_covered_count > item.mandatory_obligation_count) throw new TypeError("ContextCompileReceipt covered count exceeds obligations");
  if (item.fallback === "NONE" && item.mandatory_covered_count !== item.mandatory_obligation_count) throw new TypeError("ContextCompileReceipt without fallback must cover every mandatory obligation");
  assertInputContextRecordSha256(inputContextHashDomains.contextCompileReceipt, item, "receipt_sha256");
}

function assertLayoutEntry(value: unknown, expectedOrdinal: number, predecessor: string | null): asserts value is LayoutSegmentManifestEntryRecord {
  const item = record(value, "LayoutManifest entry");
  exactKeys(item, ["segment_type", "ordinal", "lifecycle", "source_binding_sha256", "semantic_version", "byte_length", "estimated_tokens", "content_identity_hmac", "predecessor_hmac", "contains_user_content"], "LayoutManifest entry");
  boundedString(item.segment_type, "LayoutManifest.segment_type", 96); integer(item.ordinal, "LayoutManifest.ordinal", 255); if (item.ordinal !== expectedOrdinal) throw new TypeError("LayoutManifest ordinals must be contiguous");
  enumValue(item.lifecycle, ["LINEAGE_STABLE", "GENERATION_STABLE", "APPEND_ONLY_DELTA"] as const, "LayoutManifest.lifecycle"); sha(item.source_binding_sha256, "LayoutManifest.source_binding_sha256"); boundedString(item.semantic_version, "LayoutManifest.semantic_version", 64); if (!versionPattern.test(item.semantic_version)) throw new TypeError("LayoutManifest semantic_version is invalid");
  integer(item.byte_length, "LayoutManifest.byte_length", 100_000_000); integer(item.estimated_tokens, "LayoutManifest.estimated_tokens", 10_000_000); sha(item.content_identity_hmac, "LayoutManifest.content_identity_hmac"); nullableSha(item.predecessor_hmac, "LayoutManifest.predecessor_hmac"); booleanValue(item.contains_user_content, "LayoutManifest.contains_user_content");
  if (item.predecessor_hmac !== predecessor) throw new TypeError("LayoutManifest predecessor chain is invalid");
}

export function assertContextLayoutManifest(value: unknown): asserts value is ContextLayoutManifestRecord {
  const item = record(value, "ContextLayoutManifest");
  exactKeys(item, ["schema_version", "layout_manifest_id", "context_envelope_sha256", "prompt_generation_id", "ordered_segment_root_sha256", "segment_count", "entries", "canonical_encoder_version", "record_sha256"], "ContextLayoutManifest");
  schemaVersion(item.schema_version, "ContextLayoutManifest"); id(item.layout_manifest_id, "ContextLayoutManifest.layout_manifest_id"); sha(item.context_envelope_sha256, "ContextLayoutManifest.context_envelope_sha256"); nullableId(item.prompt_generation_id, "ContextLayoutManifest.prompt_generation_id"); sha(item.ordered_segment_root_sha256, "ContextLayoutManifest.ordered_segment_root_sha256"); integer(item.segment_count, "ContextLayoutManifest.segment_count", 256);
  if (!Array.isArray(item.entries) || item.entries.length > 256 || item.entries.length !== item.segment_count) throw new TypeError("ContextLayoutManifest entries do not match segment_count");
  const entries = item.entries as unknown[];
  let predecessor: string | null = null; for (let index = 0; index < entries.length; index += 1) { const entry = entries[index]; assertLayoutEntry(entry, index, predecessor); predecessor = entry.content_identity_hmac; }
  boundedString(item.canonical_encoder_version, "ContextLayoutManifest.canonical_encoder_version", 64); if (!versionPattern.test(item.canonical_encoder_version)) throw new TypeError("ContextLayoutManifest canonical encoder version is invalid"); sha(item.record_sha256, "ContextLayoutManifest.record_sha256");
  assertInputContextRecordSha256(inputContextHashDomains.contextLayoutManifest, item, "record_sha256");
}

export function assertToolSurfacePlan(value: unknown): asserts value is ToolSurfacePlanRecord {
  const item = record(value, "ToolSurfacePlan");
  exactKeys(item, ["schema_version", "tool_surface_plan_id", "context_envelope_sha256", "strategy", "user_tool_configuration_sha256", "active_tool_manifest_sha256", "deferred_tool_manifest_sha256", "capability_epoch_sha256", "record_sha256"], "ToolSurfacePlan");
  schemaVersion(item.schema_version, "ToolSurfacePlan"); id(item.tool_surface_plan_id, "ToolSurfacePlan.tool_surface_plan_id"); sha(item.context_envelope_sha256, "ToolSurfacePlan.context_envelope_sha256"); enumValue(item.strategy, toolSurfaceStrategies, "ToolSurfacePlan.strategy"); sha(item.user_tool_configuration_sha256, "ToolSurfacePlan.user_tool_configuration_sha256"); sha(item.active_tool_manifest_sha256, "ToolSurfacePlan.active_tool_manifest_sha256"); nullableSha(item.deferred_tool_manifest_sha256, "ToolSurfacePlan.deferred_tool_manifest_sha256"); sha(item.capability_epoch_sha256, "ToolSurfacePlan.capability_epoch_sha256"); sha(item.record_sha256, "ToolSurfacePlan.record_sha256");
  if (item.strategy === "PRESERVE_USER_FULL" && item.deferred_tool_manifest_sha256 !== null) throw new TypeError("PRESERVE_USER_FULL cannot claim deferred tools");
  assertInputContextRecordSha256(inputContextHashDomains.toolSurfacePlan, item, "record_sha256");
}

export function assertContextProjectionReceipt(value: unknown): asserts value is ContextProjectionReceiptRecord {
  const item = record(value, "ContextProjectionReceipt");
  exactKeys(item, ["schema_version", "projection_id", "transition_ordinal", "context_envelope_sha256", "tool_surface_plan_sha256", "layout_manifest_sha256", "retained_root_sha256", "runtime_fingerprint_sha256", "subject", "prompt_generation_id", "projection_state", "idempotency_key_hmac", "finality", "created_at_ms", "receipt_sha256"], "ContextProjectionReceipt");
  schemaVersion(item.schema_version, "ContextProjectionReceipt"); id(item.projection_id, "ContextProjectionReceipt.projection_id"); integer(item.transition_ordinal, "ContextProjectionReceipt.transition_ordinal", 32); sha(item.context_envelope_sha256, "ContextProjectionReceipt.context_envelope_sha256"); sha(item.tool_surface_plan_sha256, "ContextProjectionReceipt.tool_surface_plan_sha256"); sha(item.layout_manifest_sha256, "ContextProjectionReceipt.layout_manifest_sha256"); sha(item.retained_root_sha256, "ContextProjectionReceipt.retained_root_sha256"); sha(item.runtime_fingerprint_sha256, "ContextProjectionReceipt.runtime_fingerprint_sha256"); assertExecutionSubjectRef(item.subject); nullableId(item.prompt_generation_id, "ContextProjectionReceipt.prompt_generation_id"); enumValue(item.projection_state, projectionStates, "ContextProjectionReceipt.projection_state"); sha(item.idempotency_key_hmac, "ContextProjectionReceipt.idempotency_key_hmac"); enumValue(item.finality, providerPayloadFinalities, "ContextProjectionReceipt.finality"); integer(item.created_at_ms, "ContextProjectionReceipt.created_at_ms"); sha(item.receipt_sha256, "ContextProjectionReceipt.receipt_sha256");
  if (item.transition_ordinal === 0 && item.projection_state !== "PREPARED") throw new TypeError("ContextProjectionReceipt transition zero must be PREPARED");
  assertInputContextRecordSha256(inputContextHashDomains.contextProjectionReceipt, item, "receipt_sha256");
}

export function assertReadEvidenceReceipt(value: unknown): asserts value is ReadEvidenceReceiptRecord {
  const item = record(value, "ReadEvidenceReceipt");
  exactKeys(item, ["schema_version", "receipt_id", "workspace_id", "subject", "source_kind", "capture_kind", "evidence_sha256", "artifact_ref_hmac", "dependency_signature_sha256", "source_scope_hmac", "source_version_handle_hmac", "query_completeness", "content_freshness", "scope_authorization", "semantic_applicability", "representation_fidelity", "classification", "adapter_version", "observed_at_ms", "receipt_sha256"], "ReadEvidenceReceipt");
  schemaVersion(item.schema_version, "ReadEvidenceReceipt"); id(item.receipt_id, "ReadEvidenceReceipt.receipt_id"); id(item.workspace_id, "ReadEvidenceReceipt.workspace_id"); assertExecutionSubjectRef(item.subject); enumValue(item.source_kind, sourceKinds, "ReadEvidenceReceipt.source_kind"); enumValue(item.capture_kind, evidenceCaptureKinds, "ReadEvidenceReceipt.capture_kind"); sha(item.evidence_sha256, "ReadEvidenceReceipt.evidence_sha256"); nullableSha(item.artifact_ref_hmac, "ReadEvidenceReceipt.artifact_ref_hmac"); sha(item.dependency_signature_sha256, "ReadEvidenceReceipt.dependency_signature_sha256"); sha(item.source_scope_hmac, "ReadEvidenceReceipt.source_scope_hmac"); nullableSha(item.source_version_handle_hmac, "ReadEvidenceReceipt.source_version_handle_hmac"); enumValue(item.query_completeness, queryCompletenessValues, "ReadEvidenceReceipt.query_completeness"); enumValue(item.content_freshness, contentFreshnessValues, "ReadEvidenceReceipt.content_freshness"); enumValue(item.scope_authorization, scopeAuthorizationValues, "ReadEvidenceReceipt.scope_authorization"); enumValue(item.semantic_applicability, semanticApplicabilityValues, "ReadEvidenceReceipt.semantic_applicability"); enumValue(item.representation_fidelity, representationFidelityValues, "ReadEvidenceReceipt.representation_fidelity"); enumValue(item.classification, classifications, "ReadEvidenceReceipt.classification"); boundedString(item.adapter_version, "ReadEvidenceReceipt.adapter_version", 64); if (!versionPattern.test(item.adapter_version)) throw new TypeError("ReadEvidenceReceipt adapter_version is invalid"); integer(item.observed_at_ms, "ReadEvidenceReceipt.observed_at_ms"); sha(item.receipt_sha256, "ReadEvidenceReceipt.receipt_sha256");
  if ((item.source_kind === "QUERY") !== (item.capture_kind === "QUERY_SCOPE")) throw new TypeError("QUERY source and QUERY_SCOPE capture must agree");
  if (item.source_kind !== "QUERY" && item.query_completeness !== "NOT_APPLICABLE") throw new TypeError("non-query evidence must use NOT_APPLICABLE completeness");
  if (["HASH_CURRENT", "CHANGE_WITNESS_CURRENT"].includes(String(item.content_freshness)) && item.source_version_handle_hmac === null && item.source_kind !== "AUTHORITY" && item.source_kind !== "ARTIFACT") throw new TypeError("current mutable evidence requires a source version handle");
  assertInputContextRecordSha256(inputContextHashDomains.readEvidenceReceipt, item, "receipt_sha256");
}

export function assertEvidenceValidityTransition(value: unknown): asserts value is EvidenceValidityTransitionRecord {
  const item = record(value, "EvidenceValidityTransition");
  exactKeys(item, ["transition_id", "receipt_id", "axis", "value", "reason_code", "evidence_sha256", "created_at_ms", "transition_sha256"], "EvidenceValidityTransition");
  id(item.transition_id, "EvidenceValidityTransition.transition_id"); id(item.receipt_id, "EvidenceValidityTransition.receipt_id"); enumValue(item.axis, ["CONTENT_FRESHNESS", "SCOPE_AUTHORIZATION", "SEMANTIC_APPLICABILITY", "REPRESENTATION_FIDELITY"] as const, "EvidenceValidityTransition.axis");
  const allowed = item.axis === "CONTENT_FRESHNESS" ? contentFreshnessValues : item.axis === "SCOPE_AUTHORIZATION" ? scopeAuthorizationValues : item.axis === "SEMANTIC_APPLICABILITY" ? semanticApplicabilityValues : representationFidelityValues;
  if (typeof item.value !== "string" || !(allowed as readonly string[]).includes(item.value)) throw new TypeError("EvidenceValidityTransition value does not match axis");
  boundedString(item.reason_code, "EvidenceValidityTransition.reason_code", 96); sha(item.evidence_sha256, "EvidenceValidityTransition.evidence_sha256"); integer(item.created_at_ms, "EvidenceValidityTransition.created_at_ms"); sha(item.transition_sha256, "EvidenceValidityTransition.transition_sha256");
  assertInputContextRecordSha256(inputContextHashDomains.evidenceValidityTransition, item, "transition_sha256");
}

export function assertContextRetentionRoot(value: unknown): asserts value is ContextRetentionRootRecord {
  const item = record(value, "ContextRetentionRoot");
  exactKeys(item, ["retention_root_id", "workspace_id", "subject", "artifact_sha256", "retention_class", "expires_at_ms", "created_at_ms", "root_sha256"], "ContextRetentionRoot");
  id(item.retention_root_id, "ContextRetentionRoot.retention_root_id"); id(item.workspace_id, "ContextRetentionRoot.workspace_id"); assertExecutionSubjectRef(item.subject); sha(item.artifact_sha256, "ContextRetentionRoot.artifact_sha256"); enumValue(item.retention_class, ["TURN", "STAGE", "GOAL", "RECOVERY"] as const, "ContextRetentionRoot.retention_class"); nullableInteger(item.expires_at_ms, "ContextRetentionRoot.expires_at_ms"); integer(item.created_at_ms, "ContextRetentionRoot.created_at_ms"); sha(item.root_sha256, "ContextRetentionRoot.root_sha256"); if (item.expires_at_ms !== null && item.expires_at_ms <= item.created_at_ms) throw new TypeError("ContextRetentionRoot expiry must follow creation");
  assertInputContextRecordSha256(inputContextHashDomains.contextRetentionRoot, item, "root_sha256");
}

function assertContribution(value: unknown): asserts value is ProviderTurnContributionRecord {
  const item = record(value, "ProviderTurnContribution");
  exactKeys(item, ["contribution_id", "owner", "input_surface", "output_surface", "segment_identity_hmac", "logical_bytes", "tokens", "evidence", "included", "duplicate_of"], "ProviderTurnContribution");
  id(item.contribution_id, "ProviderTurnContribution.contribution_id"); enumValue(item.owner, contributionOwners, "ProviderTurnContribution.owner");
  if (item.input_surface !== null) enumValue(item.input_surface, inputSurfaces, "ProviderTurnContribution.input_surface"); if (item.output_surface !== null) enumValue(item.output_surface, outputSurfaces, "ProviderTurnContribution.output_surface");
  if ((item.input_surface === null) === (item.output_surface === null)) throw new TypeError("ProviderTurnContribution must claim exactly one surface direction");
  nullableSha(item.segment_identity_hmac, "ProviderTurnContribution.segment_identity_hmac"); nullableInteger(item.logical_bytes, "ProviderTurnContribution.logical_bytes", 1_000_000_000); nullableInteger(item.tokens, "ProviderTurnContribution.tokens", 100_000_000); enumValue(item.evidence, tokenEvidenceValues, "ProviderTurnContribution.evidence"); booleanValue(item.included, "ProviderTurnContribution.included"); nullableId(item.duplicate_of, "ProviderTurnContribution.duplicate_of");
  if (item.duplicate_of !== null && item.included) throw new TypeError("duplicate ProviderTurnContribution cannot be included twice");
  if (item.evidence === "UNOBSERVABLE" && item.tokens !== null) throw new TypeError("UNOBSERVABLE contribution cannot claim token count");
}

export function assertProviderTurnRequest(value: unknown): asserts value is ProviderTurnRequestRecord {
  const item = record(value, "ProviderTurnRequest");
  exactKeys(item, [
    "schema_version", "prompt_request_id", "prompt_generation_id", "previous_prompt_request_id",
    "request_sequence", "logical_request_hmac_sha256", "payload_shape_sha256",
    "message_descriptor_root_sha256", "message_count", "logical_message_bytes",
    "user_history_bytes", "assistant_history_bytes", "other_history_bytes", "tool_schema_bytes",
    "created_at_ms", "record_sha256",
  ], "ProviderTurnRequest");
  schemaVersion(item.schema_version, "ProviderTurnRequest");
  id(item.prompt_request_id, "ProviderTurnRequest.prompt_request_id");
  id(item.prompt_generation_id, "ProviderTurnRequest.prompt_generation_id");
  nullableId(item.previous_prompt_request_id, "ProviderTurnRequest.previous_prompt_request_id");
  integer(item.request_sequence, "ProviderTurnRequest.request_sequence", 1_000_000_000);
  sha(item.logical_request_hmac_sha256, "ProviderTurnRequest.logical_request_hmac_sha256");
  sha(item.payload_shape_sha256, "ProviderTurnRequest.payload_shape_sha256");
  sha(item.message_descriptor_root_sha256, "ProviderTurnRequest.message_descriptor_root_sha256");
  integer(item.message_count, "ProviderTurnRequest.message_count", 1_000_000);
  for (const key of [
    "logical_message_bytes", "user_history_bytes", "assistant_history_bytes", "other_history_bytes", "tool_schema_bytes",
  ] as const) integer(item[key], `ProviderTurnRequest.${key}`, 1_000_000_000);
  const request = item as unknown as ProviderTurnRequestRecord;
  if (request.user_history_bytes + request.assistant_history_bytes + request.other_history_bytes !== request.logical_message_bytes) {
    throw new TypeError("ProviderTurnRequest history byte attribution does not close");
  }
  if ((item.request_sequence === 0) !== (item.previous_prompt_request_id === null)) {
    throw new TypeError("ProviderTurnRequest predecessor does not match sequence");
  }
  integer(item.created_at_ms, "ProviderTurnRequest.created_at_ms");
  sha(item.record_sha256, "ProviderTurnRequest.record_sha256");
  assertInputContextRecordSha256(inputContextHashDomains.providerTurnRequest, item, "record_sha256");
}

export function assertProviderTurnLedger(value: unknown): asserts value is ProviderTurnLedgerRecord {
  const item = record(value, "ProviderTurnLedger");
  exactKeys(item, ["schema_version", "prompt_request_id", "prompt_generation_id", "context_envelope_sha256", "layout_manifest_sha256", "contributions", "provider_uncached_input_tokens", "provider_cache_read_tokens", "provider_cache_write_tokens", "provider_generated_output_tokens", "provider_reasoning_tokens", "attributed_input_tokens", "unattributed_input_tokens", "attributed_output_tokens", "unattributed_output_tokens", "accounting_completeness", "additional_model_requests", "additional_provider_requests", "created_at_ms", "record_sha256"], "ProviderTurnLedger");
  schemaVersion(item.schema_version, "ProviderTurnLedger"); id(item.prompt_request_id, "ProviderTurnLedger.prompt_request_id"); nullableId(item.prompt_generation_id, "ProviderTurnLedger.prompt_generation_id"); nullableSha(item.context_envelope_sha256, "ProviderTurnLedger.context_envelope_sha256"); nullableSha(item.layout_manifest_sha256, "ProviderTurnLedger.layout_manifest_sha256");
  if (!Array.isArray(item.contributions) || item.contributions.length > 256) throw new TypeError("ProviderTurnLedger.contributions must be bounded");
  const contributions = item.contributions as unknown[];
  const contributionIds = new Set<string>(); const includedSegments = new Map<string, ContributionOwner>();
  for (const contribution of contributions) { assertContribution(contribution); if (contributionIds.has(contribution.contribution_id)) throw new TypeError("ProviderTurnLedger contribution IDs must be unique"); contributionIds.add(contribution.contribution_id); if (contribution.included && contribution.segment_identity_hmac !== null) { const owner = includedSegments.get(contribution.segment_identity_hmac); if (owner !== undefined) throw new TypeError("ProviderTurnLedger included segment has multiple owners"); includedSegments.set(contribution.segment_identity_hmac, contribution.owner); } }
  for (const contribution of contributions) { assertContribution(contribution); if (contribution.duplicate_of !== null && !contributionIds.has(contribution.duplicate_of)) throw new TypeError("ProviderTurnLedger duplicate reference is unknown"); }
  for (const key of ["provider_uncached_input_tokens", "provider_cache_read_tokens", "provider_cache_write_tokens", "provider_generated_output_tokens", "provider_reasoning_tokens", "attributed_input_tokens", "unattributed_input_tokens", "attributed_output_tokens", "unattributed_output_tokens"] as const) nullableInteger(item[key], `ProviderTurnLedger.${key}`, 100_000_000);
  enumValue(item.accounting_completeness, ["COMPLETE", "PARTIAL", "UNOBSERVABLE"] as const, "ProviderTurnLedger.accounting_completeness"); if (item.additional_model_requests !== 0 || item.additional_provider_requests !== 0) throw new TypeError("ProviderTurnLedger default accounting adds no requests"); integer(item.created_at_ms, "ProviderTurnLedger.created_at_ms"); sha(item.record_sha256, "ProviderTurnLedger.record_sha256");
  const totals = item as unknown as ProviderTurnLedgerRecord;
  if (totals.provider_reasoning_tokens !== null && totals.provider_generated_output_tokens !== null && totals.provider_reasoning_tokens > totals.provider_generated_output_tokens) throw new TypeError("Provider reasoning tokens must be a subset of generated output");
  if (totals.accounting_completeness === "COMPLETE") {
    const required = [totals.provider_uncached_input_tokens, totals.provider_cache_read_tokens, totals.provider_cache_write_tokens, totals.provider_generated_output_tokens, totals.attributed_input_tokens, totals.unattributed_input_tokens, totals.attributed_output_tokens, totals.unattributed_output_tokens];
    if (required.some((entry) => entry === null)) throw new TypeError("COMPLETE ProviderTurnLedger cannot contain unknown core totals");
    const inputTotal = totals.provider_uncached_input_tokens! + totals.provider_cache_read_tokens! + totals.provider_cache_write_tokens!;
    if (totals.attributed_input_tokens! + totals.unattributed_input_tokens! !== inputTotal) throw new TypeError("ProviderTurnLedger input attribution does not close");
    if (totals.attributed_output_tokens! + totals.unattributed_output_tokens! !== totals.provider_generated_output_tokens!) throw new TypeError("ProviderTurnLedger output attribution does not close");
  }
  assertInputContextRecordSha256(inputContextHashDomains.providerTurnLedger, item, "record_sha256");
}

export function assertProviderTurnGoalBinding(value: unknown): asserts value is ProviderTurnGoalBindingRecord {
  const item = record(value, "ProviderTurnGoalBinding");
  exactKeys(item, [
    "schema_version", "prompt_request_id", "prompt_request_sha256", "goal_id", "run_id", "session_id",
    "created_at_ms", "record_sha256",
  ], "ProviderTurnGoalBinding");
  schemaVersion(item.schema_version, "ProviderTurnGoalBinding");
  id(item.prompt_request_id, "ProviderTurnGoalBinding.prompt_request_id");
  sha(item.prompt_request_sha256, "ProviderTurnGoalBinding.prompt_request_sha256");
  id(item.goal_id, "ProviderTurnGoalBinding.goal_id");
  id(item.run_id, "ProviderTurnGoalBinding.run_id");
  boundedString(item.session_id, "ProviderTurnGoalBinding.session_id", 256);
  integer(item.created_at_ms, "ProviderTurnGoalBinding.created_at_ms");
  sha(item.record_sha256, "ProviderTurnGoalBinding.record_sha256");
  assertInputContextRecordSha256(inputContextHashDomains.providerTurnGoalBinding, item, "record_sha256");
}

export function assertProviderTurnAttempt(value: unknown): asserts value is ProviderTurnAttemptRecord {
  const item = record(value, "ProviderTurnAttempt");
  exactKeys(item, ["schema_version", "attempt_id", "prompt_request_id", "attempt_number", "transition_ordinal", "request_identity_hmac", "payload_identity_hmac", "payload_finality", "started_at_ms", "completed_at_ms", "response_status", "outcome", "usage_contribution_sha256", "record_sha256"], "ProviderTurnAttempt");
  schemaVersion(item.schema_version, "ProviderTurnAttempt"); id(item.attempt_id, "ProviderTurnAttempt.attempt_id"); id(item.prompt_request_id, "ProviderTurnAttempt.prompt_request_id"); integer(item.attempt_number, "ProviderTurnAttempt.attempt_number", 1024); if (item.attempt_number < 1) throw new TypeError("ProviderTurnAttempt attempt_number starts at 1"); integer(item.transition_ordinal, "ProviderTurnAttempt.transition_ordinal", 1); sha(item.request_identity_hmac, "ProviderTurnAttempt.request_identity_hmac"); nullableSha(item.payload_identity_hmac, "ProviderTurnAttempt.payload_identity_hmac"); enumValue(item.payload_finality, providerPayloadFinalities, "ProviderTurnAttempt.payload_finality"); integer(item.started_at_ms, "ProviderTurnAttempt.started_at_ms"); nullableInteger(item.completed_at_ms, "ProviderTurnAttempt.completed_at_ms"); nullableInteger(item.response_status, "ProviderTurnAttempt.response_status", 999); enumValue(item.outcome, ["STARTED", "RESPONDED", "FAILED", "OUTCOME_UNKNOWN"] as const, "ProviderTurnAttempt.outcome"); nullableSha(item.usage_contribution_sha256, "ProviderTurnAttempt.usage_contribution_sha256"); sha(item.record_sha256, "ProviderTurnAttempt.record_sha256");
  if ((item.transition_ordinal === 0) !== (item.outcome === "STARTED")) throw new TypeError("ProviderTurnAttempt transition zero is STARTED and transition one is terminal");
  if (item.outcome === "STARTED" && item.completed_at_ms !== null) throw new TypeError("STARTED ProviderTurnAttempt cannot be completed");
  if (item.outcome === "STARTED" && (item.response_status !== null || item.usage_contribution_sha256 !== null)) throw new TypeError("STARTED ProviderTurnAttempt cannot claim response or usage");
  if (item.outcome !== "STARTED" && (item.completed_at_ms === null || item.completed_at_ms < item.started_at_ms)) throw new TypeError("terminal ProviderTurnAttempt requires a valid completion time");
  if (item.outcome !== "STARTED" && item.usage_contribution_sha256 === null) throw new TypeError("terminal ProviderTurnAttempt must bind a ledger usage contribution");
  if (item.outcome === "RESPONDED" && item.response_status === null) throw new TypeError("RESPONDED ProviderTurnAttempt requires response status");
  assertInputContextRecordSha256(inputContextHashDomains.providerTurnAttempt, item, "record_sha256");
}

export function assertContextEpisodeObservation(value: unknown): asserts value is ContextEpisodeObservationRecord {
  const item = record(value, "ContextEpisodeObservation");
  exactKeys(item, ["schema_version", "observation_id", "epoch_id", "subject", "prompt_request_id", "arm", "quality_gate", "acceptance_gate", "accounting_completeness", "provider_requests", "physical_attempts", "input_tokens", "output_tokens", "ordinary_reads", "context_batch_reads", "rereads", "follow_ups", "reopens", "rework_events", "wall_time_ms", "contains_prompt_content", "record_sha256"], "ContextEpisodeObservation");
  schemaVersion(item.schema_version, "ContextEpisodeObservation"); id(item.observation_id, "ContextEpisodeObservation.observation_id"); id(item.epoch_id, "ContextEpisodeObservation.epoch_id"); assertExecutionSubjectRef(item.subject); nullableId(item.prompt_request_id, "ContextEpisodeObservation.prompt_request_id"); enumValue(item.arm, ["BASELINE", "OBSERVE", "CANDIDATE"] as const, "ContextEpisodeObservation.arm"); enumValue(item.quality_gate, ["PASS", "FAIL", "UNOBSERVABLE"] as const, "ContextEpisodeObservation.quality_gate"); enumValue(item.acceptance_gate, ["PASS", "FAIL", "UNOBSERVABLE"] as const, "ContextEpisodeObservation.acceptance_gate"); enumValue(item.accounting_completeness, ["COMPLETE", "PARTIAL", "UNOBSERVABLE"] as const, "ContextEpisodeObservation.accounting_completeness");
  for (const key of ["provider_requests", "ordinary_reads", "context_batch_reads", "rereads", "follow_ups", "reopens", "rework_events", "wall_time_ms"] as const) integer(item[key], `ContextEpisodeObservation.${key}`, 1_000_000_000); nullableInteger(item.physical_attempts, "ContextEpisodeObservation.physical_attempts", 1_000_000); nullableInteger(item.input_tokens, "ContextEpisodeObservation.input_tokens", 100_000_000); nullableInteger(item.output_tokens, "ContextEpisodeObservation.output_tokens", 100_000_000); if (item.contains_prompt_content !== false) throw new TypeError("ContextEpisodeObservation cannot contain prompt content"); sha(item.record_sha256, "ContextEpisodeObservation.record_sha256");
  assertInputContextRecordSha256(inputContextHashDomains.contextEpisodeObservation, item, "record_sha256");
}

function assertProjectSourceEntry(value: unknown): asserts value is ProjectSourceManifestEntryRecord {
  const item = record(value, "ProjectSourceManifest entry");
  exactKeys(item, ["source_id", "source_kind", "workspace_path_hmac", "content_sha256", "source_version_handle_hmac", "trust", "content_freshness", "representation_fidelity", "classification"], "ProjectSourceManifest entry");
  id(item.source_id, "ProjectSourceManifest.source_id"); enumValue(item.source_kind, projectSourceKinds, "ProjectSourceManifest.source_kind");
  sha(item.workspace_path_hmac, "ProjectSourceManifest.workspace_path_hmac"); sha(item.content_sha256, "ProjectSourceManifest.content_sha256"); sha(item.source_version_handle_hmac, "ProjectSourceManifest.source_version_handle_hmac");
  enumValue(item.trust, contextTrustValues, "ProjectSourceManifest.trust"); enumValue(item.content_freshness, contentFreshnessValues, "ProjectSourceManifest.content_freshness"); enumValue(item.representation_fidelity, representationFidelityValues, "ProjectSourceManifest.representation_fidelity"); enumValue(item.classification, classifications, "ProjectSourceManifest.classification");
  if (!["HASH_CURRENT", "CHANGE_WITNESS_CURRENT"].includes(String(item.content_freshness))) throw new TypeError("ProjectSourceManifest only admits current sources");
  if (!["EXACT_RAW", "EXACT_DECODED", "TYPED_EXTRACT"].includes(String(item.representation_fidelity))) throw new TypeError("ProjectSourceManifest source representation is not reusable");
}

export function assertProjectSourceManifest(value: unknown): asserts value is ProjectSourceManifestRecord {
  const item = record(value, "ProjectSourceManifest");
  exactKeys(item, ["schema_version", "manifest_id", "workspace_id", "subject", "entries", "created_at_ms", "record_sha256"], "ProjectSourceManifest");
  schemaVersion(item.schema_version, "ProjectSourceManifest"); id(item.manifest_id, "ProjectSourceManifest.manifest_id"); id(item.workspace_id, "ProjectSourceManifest.workspace_id"); assertExecutionSubjectRef(item.subject);
  if (!Array.isArray(item.entries) || item.entries.length > 256) throw new TypeError("ProjectSourceManifest.entries must be bounded");
  const sourceIds = new Set<string>();
  for (const entry of item.entries) { assertProjectSourceEntry(entry); if (sourceIds.has(entry.source_id)) throw new TypeError("ProjectSourceManifest source IDs must be unique"); sourceIds.add(entry.source_id); }
  integer(item.created_at_ms, "ProjectSourceManifest.created_at_ms"); sha(item.record_sha256, "ProjectSourceManifest.record_sha256");
  assertInputContextRecordSha256(inputContextHashDomains.projectSourceManifest, item, "record_sha256");
}

export function assertProjectKnowledgeClaim(value: unknown): asserts value is ProjectKnowledgeClaimRecord {
  const item = record(value, "ProjectKnowledgeClaim");
  exactKeys(item, ["schema_version", "claim_id", "manifest_id", "source_id", "subject", "semantic_key", "statement_sha256", "source_range_sha256", "evidence_sha256", "trust", "content_freshness", "scope_authorization", "semantic_applicability", "representation_fidelity", "authority_status", "frozen_goal_contract_sha256", "created_at_ms", "record_sha256"], "ProjectKnowledgeClaim");
  schemaVersion(item.schema_version, "ProjectKnowledgeClaim"); id(item.claim_id, "ProjectKnowledgeClaim.claim_id"); id(item.manifest_id, "ProjectKnowledgeClaim.manifest_id"); id(item.source_id, "ProjectKnowledgeClaim.source_id"); assertExecutionSubjectRef(item.subject); boundedString(item.semantic_key, "ProjectKnowledgeClaim.semantic_key", 160);
  sha(item.statement_sha256, "ProjectKnowledgeClaim.statement_sha256"); sha(item.source_range_sha256, "ProjectKnowledgeClaim.source_range_sha256"); sha(item.evidence_sha256, "ProjectKnowledgeClaim.evidence_sha256"); enumValue(item.trust, contextTrustValues, "ProjectKnowledgeClaim.trust"); enumValue(item.content_freshness, contentFreshnessValues, "ProjectKnowledgeClaim.content_freshness"); enumValue(item.scope_authorization, scopeAuthorizationValues, "ProjectKnowledgeClaim.scope_authorization"); enumValue(item.semantic_applicability, semanticApplicabilityValues, "ProjectKnowledgeClaim.semantic_applicability"); enumValue(item.representation_fidelity, representationFidelityValues, "ProjectKnowledgeClaim.representation_fidelity"); enumValue(item.authority_status, ["EVIDENCE_ONLY", "FROZEN_IN_GOAL_CONTRACT"] as const, "ProjectKnowledgeClaim.authority_status"); nullableSha(item.frozen_goal_contract_sha256, "ProjectKnowledgeClaim.frozen_goal_contract_sha256"); integer(item.created_at_ms, "ProjectKnowledgeClaim.created_at_ms"); sha(item.record_sha256, "ProjectKnowledgeClaim.record_sha256");
  if ((item.authority_status === "FROZEN_IN_GOAL_CONTRACT") !== (item.frozen_goal_contract_sha256 !== null)) throw new TypeError("ProjectKnowledgeClaim authority binding is inconsistent");
  if (item.authority_status === "FROZEN_IN_GOAL_CONTRACT" && item.subject.goalContractSha256 !== item.frozen_goal_contract_sha256) throw new TypeError("ProjectKnowledgeClaim frozen contract does not match its subject");
  assertInputContextRecordSha256(inputContextHashDomains.projectKnowledgeClaim, item, "record_sha256");
}

export function assertInputContextActivation(value: unknown): asserts value is InputContextActivationRecord {
  const item = record(value, "InputContextActivation");
  exactKeys(item, ["schema_version", "activation_id", "blueprint_revision", "mode", "activation_basis", "effectiveness_verdict", "runtime_fingerprint_sha256", "dependencies", "result", "fallback", "additional_model_requests", "additional_provider_requests", "created_at_ms", "record_sha256"], "InputContextActivation");
  schemaVersion(item.schema_version, "InputContextActivation"); id(item.activation_id, "InputContextActivation.activation_id"); boundedString(item.blueprint_revision, "InputContextActivation.blueprint_revision", 64); if (!versionPattern.test(item.blueprint_revision)) throw new TypeError("InputContextActivation blueprint revision is invalid"); enumValue(item.mode, ["OFF", "OBSERVE", "AUTO_GUARDED"] as const, "InputContextActivation.mode"); enumValue(item.activation_basis, ["NONE", "MATCHED_PROMOTION", "USER_EXPLICIT_UNVALIDATED"] as const, "InputContextActivation.activation_basis"); enumValue(item.effectiveness_verdict, ["PASS", "NOT_EVALUATED"] as const, "InputContextActivation.effectiveness_verdict"); sha(item.runtime_fingerprint_sha256, "InputContextActivation.runtime_fingerprint_sha256");
  if (!Array.isArray(item.dependencies) || item.dependencies.length === 0 || item.dependencies.length > 256) throw new TypeError("InputContextActivation dependencies must be bounded and nonempty"); const sourceIds = new Set<string>(); for (const dependencyValue of item.dependencies) { const dependency = record(dependencyValue, "InputContextActivation dependency"); exactKeys(dependency, ["source_id", "role", "sha256"], "InputContextActivation dependency"); id(dependency.source_id, "InputContextActivation dependency source_id"); boundedString(dependency.role, "InputContextActivation dependency role", 96); sha(dependency.sha256, "InputContextActivation dependency sha256"); if (sourceIds.has(dependency.source_id)) throw new TypeError("InputContextActivation dependency IDs must be unique"); sourceIds.add(dependency.source_id); }
  enumValue(item.result, ["PASS", "FAIL", "INCONCLUSIVE"] as const, "InputContextActivation.result"); if (item.fallback !== "PI_BASELINE" || item.additional_model_requests !== 0 || item.additional_provider_requests !== 0) throw new TypeError("InputContextActivation fallback/request contract is invalid"); integer(item.created_at_ms, "InputContextActivation.created_at_ms"); sha(item.record_sha256, "InputContextActivation.record_sha256"); if (item.mode === "AUTO_GUARDED" && item.result !== "PASS") throw new TypeError("AUTO_GUARDED activation requires PASS"); if (item.activation_basis === "MATCHED_PROMOTION" && item.effectiveness_verdict !== "PASS") throw new TypeError("matched promotion requires a PASS effectiveness verdict"); if (item.activation_basis === "USER_EXPLICIT_UNVALIDATED" && item.effectiveness_verdict !== "NOT_EVALUATED") throw new TypeError("user-explicit activation cannot claim evaluated effectiveness");
  assertInputContextRecordSha256(inputContextHashDomains.inputContextActivation, item, "record_sha256");
}
