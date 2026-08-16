import { canonicalJson, canonicalJsonSha256 } from "../../authority/canonical-json.js";
import { hmacSha256Hex, sha256Hex } from "../../foundation/crypto.js";
import { idFromSha256 } from "../../foundation/ids.js";
import { scopeContains, scopePathKey } from "../scope-path.js";

const sha256Pattern = /^[a-f0-9]{64}$/u;
const idPattern = /^[A-Z][A-Z0-9_:-]{0,255}$/u;

export type ExecutionCapabilityV2 =
  | "SOURCE_DISCOVERY"
  | "REQUIREMENT_ANALYSIS"
  | "PATCH_PROPOSE"
  | "CONFLICT_PROPOSE"
  | "ORACLE_REQUEST";

export type ExecutionEdgeConditionV2 = "EVIDENCE_ACCEPTED" | "PATCH_INTEGRATED" | "ORACLE_PASSED";
export type ExecutionEffectCeilingV2 = "READ_ONLY" | "PATCH_PROPOSAL";
export type ExecutionPrivacyClassV2 = "PUBLIC" | "INTERNAL" | "SENSITIVE" | "SECRET";

export interface ExecutionNodeSpecV2 {
  readonly schema_version: 2;
  readonly node_id: string;
  readonly logical_key: string;
  readonly task: string;
  readonly capabilities: readonly ExecutionCapabilityV2[];
  readonly effect_ceiling: ExecutionEffectCeilingV2;
  readonly requirement_ids: readonly string[];
  readonly obligation_ids: readonly string[];
  readonly read_roots: readonly string[];
  readonly write_roots: readonly string[];
  readonly exact_input_refs: readonly TaskPacketArtifactRefV2[];
  readonly decision_refs: readonly TaskPacketDecisionRefV2[];
  readonly provider_call_plan_id: string | null;
  readonly provider_call_plan_sha256: string | null;
  readonly input_closure_sha256: string;
  readonly output_schema_sha256: string;
  readonly oracle_sha256: string;
  readonly provider_profile_sha256: string;
  readonly privacy_class: ExecutionPrivacyClassV2;
  readonly taint_classes: readonly string[];
  readonly max_turns: number;
  readonly max_tool_calls: number;
  readonly max_input_tokens: number;
  readonly max_output_tokens: number;
  readonly max_retries: number;
  readonly no_progress_limit: number;
  readonly deadline_ms: number;
  readonly record_sha256: string;
}

export interface ExecutionEdgeV2 {
  readonly from_node_id: string;
  readonly to_node_id: string;
  readonly condition: ExecutionEdgeConditionV2;
  readonly record_sha256: string;
}

export interface ExecutionGraphRevisionV2 {
  readonly schema_version: 2;
  readonly execution_graph_revision_id: string;
  readonly goal_id: string;
  readonly run_id: string;
  readonly work_cell_id: string;
  readonly plan_revision_id: string;
  readonly plan_revision_sha256: string;
  readonly topology_gate_receipt_id: string;
  readonly topology_gate_receipt_sha256: string;
  readonly authorization_id: string;
  readonly authorization_sha256: string;
  readonly baseline_sha256: string;
  readonly baseline_content_root_sha256: string;
  readonly environment_sha256: string;
  readonly input_closure_sha256: string;
  readonly oracle_set_sha256: string;
  readonly config_sha256: string;
  readonly runtime_fingerprint_sha256: string;
  readonly predecessor_authority_head_sha256: string;
  readonly graph_revision: number;
  readonly stop_generation: number;
  readonly node_root_sha256: string;
  readonly edge_root_sha256: string;
  readonly graph_sha256: string;
  readonly nodes: readonly ExecutionNodeSpecV2[];
  readonly edges: readonly ExecutionEdgeV2[];
  readonly created_at_ms: number;
  readonly record_sha256: string;
}

export interface TaskPacketArtifactRefV2 {
  readonly path: string;
  readonly sha256: string;
  readonly classification: ExecutionPrivacyClassV2;
}

export interface TaskPacketDecisionRefV2 {
  readonly decision_id: string;
  readonly sha256: string;
}

export interface TaskPacketV2 {
  readonly schema_version: 2;
  readonly packet_id: string;
  readonly goal_id: string;
  readonly run_id: string;
  readonly work_cell_id: string;
  readonly graph_revision_id: string;
  readonly graph_revision_sha256: string;
  readonly node_id: string;
  readonly node_spec_sha256: string;
  readonly task: string;
  readonly requirement_ids: readonly string[];
  readonly obligation_ids: readonly string[];
  readonly output_schema_sha256: string;
  readonly oracle_sha256: string;
  readonly provider_profile_sha256: string;
  readonly plan_revision_sha256: string;
  readonly topology_gate_receipt_sha256: string;
  readonly authorization_sha256: string;
  readonly baseline_sha256: string;
  readonly baseline_content_root_sha256: string;
  readonly environment_sha256: string;
  readonly input_closure_sha256: string;
  readonly oracle_set_sha256: string;
  readonly config_sha256: string;
  readonly runtime_fingerprint_sha256: string;
  readonly attempt: number;
  readonly lease_generation: number;
  readonly fencing_token: number;
  readonly stop_generation: number;
  readonly capabilities: readonly ExecutionCapabilityV2[];
  readonly effect_ceiling: ExecutionEffectCeilingV2;
  readonly read_roots: readonly string[];
  readonly write_roots: readonly string[];
  readonly privacy_class: ExecutionPrivacyClassV2;
  readonly taint_classes: readonly string[];
  readonly max_turns: number;
  readonly max_tool_calls: number;
  readonly max_input_tokens: number;
  readonly max_output_tokens: number;
  readonly max_retries: number;
  readonly no_progress_limit: number;
  readonly exact_input_refs: readonly TaskPacketArtifactRefV2[];
  readonly decision_refs: readonly TaskPacketDecisionRefV2[];
  readonly provider_call_plan_id: string | null;
  readonly provider_call_plan_sha256: string | null;
  readonly deadline_ms: number;
  readonly created_at_ms: number;
  readonly packet_sha256: string;
  readonly capability_hmac: string;
}

interface EvidenceProposalPayloadV2 {
  readonly artifact_refs: readonly { readonly sha256: string; readonly classification: ExecutionPrivacyClassV2 }[];
}

interface PatchProposalPayloadV2 {
  readonly patch_set_id: string;
  readonly patch_set_sha256: string;
  readonly affected_paths: readonly string[];
  readonly preimage_root_sha256: string;
  readonly proposed_postimage_root_sha256: string;
}

export interface WorkerPatchInputV2 {
  readonly operation: "CREATE" | "MODIFY" | "DELETE";
  readonly path: string;
  readonly beforeSha256: string | null;
  readonly content: Uint8Array | null;
}

export interface WorkerPatchEntryV2 {
  readonly operation: "CREATE" | "MODIFY" | "DELETE";
  readonly path: string;
  readonly before_sha256: string | null;
  readonly after_sha256: string | null;
  readonly byte_length: number;
  readonly record_sha256: string;
}

export interface WorkerPatchSetV2 {
  readonly schema_version: 2;
  readonly patch_set_id: string;
  readonly goal_id: string;
  readonly run_id: string;
  readonly graph_revision_id: string;
  readonly graph_revision_sha256: string;
  readonly node_id: string;
  readonly node_spec_sha256: string;
  readonly packet_id: string;
  readonly packet_sha256: string;
  readonly baseline_sha256: string;
  readonly affected_paths: readonly string[];
  readonly entries: readonly WorkerPatchEntryV2[];
  readonly proposed_postimage_root_sha256: string;
  readonly created_at_ms: number;
  readonly record_sha256: string;
}

interface DecisionRequestPayloadV2 {
  readonly decision_schema_sha256: string;
  readonly blocking: boolean;
  readonly question_hmac: string;
}

interface ConflictProposalPayloadV2 {
  readonly conflict_sha256: string;
  readonly candidate_patch_sha256: string | null;
}

interface BlockedPayloadV2 {
  readonly reason_code: string;
  readonly evidence_refs: readonly string[];
}

interface StoppedPayloadV2 {
  readonly reason_code: string;
  readonly observed_stop_generation: number;
}

export type WorkerProposalPayloadV2 =
  | EvidenceProposalPayloadV2
  | PatchProposalPayloadV2
  | DecisionRequestPayloadV2
  | ConflictProposalPayloadV2
  | BlockedPayloadV2
  | StoppedPayloadV2;

export type WorkerProposalKindV2 =
  | "EVIDENCE_PROPOSAL"
  | "PATCH_PROPOSAL"
  | "DECISION_REQUEST"
  | "CONFLICT_PROPOSAL"
  | "BLOCKED"
  | "STOPPED";

export interface WorkerProposalV2 {
  readonly schema_version: 2;
  readonly proposal_id: string;
  readonly goal_id: string;
  readonly run_id: string;
  readonly graph_revision_id: string;
  readonly graph_revision_sha256: string;
  readonly node_id: string;
  readonly packet_id: string;
  readonly packet_sha256: string;
  readonly lease_generation: number;
  readonly fencing_token: number;
  readonly stop_generation: number;
  readonly kind: WorkerProposalKindV2;
  readonly payload: WorkerProposalPayloadV2;
  readonly trust: "UNVERIFIED_PROPOSAL";
  readonly created_at_ms: number;
  readonly record_sha256: string;
}

export interface ExecutionNodeLeaseV2 {
  readonly schema_version: 2;
  readonly execution_node_lease_id: string;
  readonly goal_id: string;
  readonly run_id: string;
  readonly graph_revision_id: string;
  readonly graph_revision_sha256: string;
  readonly node_id: string;
  readonly node_spec_sha256: string;
  readonly packet_id: string;
  readonly packet_sha256: string;
  readonly generation: number;
  readonly fencing_token: number;
  readonly stop_generation: number;
  readonly owner_hmac: string;
  readonly expires_at_ms: number;
  readonly created_at_ms: number;
  readonly record_sha256: string;
}

export type ExecutionNodeAttemptDispositionV2 = "REQUEUED" | "FAILED" | "FENCED";
export type ExecutionNodeAttemptBasisV2 = "WORKER_FAILURE" | "LEASE_EXPIRED" | "HOST_EPOCH_FENCED" | "ABORT_CONFIRMED";

export interface ExecutionNodeAttemptOutcomeV2 {
  readonly schema_version: 2;
  readonly execution_node_attempt_outcome_id: string;
  readonly goal_id: string;
  readonly run_id: string;
  readonly graph_revision_id: string;
  readonly graph_revision_sha256: string;
  readonly node_id: string;
  readonly node_spec_sha256: string;
  readonly packet_id: string;
  readonly packet_sha256: string;
  readonly execution_node_lease_id: string;
  readonly execution_node_lease_sha256: string;
  readonly attempt: number;
  readonly lease_generation: number;
  readonly fencing_token: number;
  readonly stop_generation: number;
  readonly basis: ExecutionNodeAttemptBasisV2;
  readonly disposition: ExecutionNodeAttemptDispositionV2;
  readonly reason_code: string;
  readonly failure_sha256: string;
  readonly predecessor_authority_head_sha256: string;
  readonly trust: "HOST_DERIVED";
  readonly created_at_ms: number;
  readonly record_sha256: string;
}

export interface ExecutionIntegrationAttemptV2 {
  readonly schema_version: 2;
  readonly integration_attempt_id: string;
  readonly goal_id: string;
  readonly run_id: string;
  readonly graph_revision_id: string;
  readonly graph_revision_sha256: string;
  readonly node_id: string;
  readonly node_spec_sha256: string;
  readonly proposal_id: string;
  readonly proposal_sha256: string;
  readonly authorization_sha256: string;
  readonly expected_preimage_root_sha256: string;
  readonly patch_set_id: string;
  readonly patch_set_sha256: string;
  readonly lease_generation: number;
  readonly fencing_token: number;
  readonly owner_hmac: string;
  readonly expires_at_ms: number;
  readonly created_at_ms: number;
  readonly record_sha256: string;
}

export type ExecutionIntegrationStateV2 = "PREPARED" | "OBSERVED" | "COMMITTED" | "REJECTED" | "FENCED";

export interface ExecutionIntegrationTransitionV2 {
  readonly schema_version: 2;
  readonly integration_transition_id: string;
  readonly integration_attempt_id: string;
  readonly ordinal: number;
  readonly state: ExecutionIntegrationStateV2;
  readonly predecessor_transition_sha256: string | null;
  readonly postimage_root_sha256: string | null;
  readonly failure_sha256: string | null;
  readonly created_at_ms: number;
  readonly record_sha256: string;
}

export type HostNodeReceiptKindV2 =
  | "EVIDENCE_ACCEPTED"
  | "PATCH_INTEGRATED"
  | "ORACLE_PASSED"
  | "NODE_REJECTED";

export interface HostOracleEvidenceV2 {
  readonly schema_version: 2;
  readonly obligation_id: string;
  readonly oracle_pass_receipt_id: string;
  readonly oracle_pass_receipt_sha256: string;
  readonly evidence_requirement_id: string;
  readonly operation_attempt_id: string;
  readonly operation_attempt_sha256: string;
  readonly terminal_transition_id: string;
  readonly terminal_transition_sha256: string;
  readonly record_sha256: string;
}

export interface HostOracleReceiptV2 {
  readonly schema_version: 2;
  readonly host_oracle_receipt_id: string;
  readonly goal_id: string;
  readonly run_id: string;
  readonly graph_revision_id: string;
  readonly graph_revision_sha256: string;
  readonly node_id: string;
  readonly node_spec_sha256: string;
  readonly packet_id: string;
  readonly packet_sha256: string;
  readonly proposal_id: string;
  readonly proposal_sha256: string;
  readonly oracle_sha256: string;
  readonly oracle_set_sha256: string;
  readonly postimage_root_sha256: string;
  readonly environment_sha256: string;
  readonly covered_obligation_ids: readonly string[];
  readonly validation_evidence: readonly HostOracleEvidenceV2[];
  readonly validation_evidence_root_sha256: string;
  readonly result: "PASS";
  readonly freshness: "CURRENT";
  readonly stop_generation: number;
  readonly predecessor_authority_head_sha256: string;
  readonly trust: "HOST_DERIVED";
  readonly created_at_ms: number;
  readonly record_sha256: string;
}

export interface HostNodeReceiptV2 {
  readonly schema_version: 2;
  readonly host_node_receipt_id: string;
  readonly goal_id: string;
  readonly run_id: string;
  readonly graph_revision_id: string;
  readonly graph_revision_sha256: string;
  readonly node_id: string;
  readonly node_spec_sha256: string;
  readonly packet_id: string;
  readonly packet_sha256: string;
  readonly proposal_id: string;
  readonly proposal_sha256: string;
  readonly kind: HostNodeReceiptKindV2;
  readonly evidence_sha256: string;
  readonly preimage_root_sha256: string | null;
  readonly postimage_root_sha256: string | null;
  readonly stop_generation: number;
  readonly predecessor_authority_head_sha256: string;
  readonly trust: "HOST_DERIVED";
  readonly created_at_ms: number;
  readonly record_sha256: string;
}

export type ExecutionStopReasonV2 =
  | "USER_CANCEL"
  | "MATERIAL_CHANGE"
  | "AUTHORIZATION_REVOKED"
  | "NO_PROGRESS"
  | "BUDGET_EXHAUSTED"
  | "SAFETY_FENCE"
  | "INTEGRATION_RECONCILIATION_REQUIRED"
  | "SUPERSEDED";

export type ExecutionStopScopeV2 = "PARTIAL_INVALIDATION" | "GRAPH_STOP";

export interface ExecutionStopV2 {
  readonly schema_version: 2;
  readonly execution_stop_id: string;
  readonly goal_id: string;
  readonly run_id: string;
  readonly graph_revision_id: string;
  readonly graph_revision_sha256: string;
  readonly stop_generation: number;
  readonly scope: ExecutionStopScopeV2;
  readonly reason: ExecutionStopReasonV2;
  readonly affected_node_ids: readonly string[];
  readonly affected_node_root_sha256: string;
  readonly predecessor_authority_head_sha256: string;
  readonly created_at_ms: number;
  readonly record_sha256: string;
}

export type ExecutionGraphTerminalStatusV2 = "CLOSED" | "FAILED";
export type ExecutionGraphTerminalNodeStatusV2 =
  | "ORACLE_PASSED" | "REJECTED" | "INVALIDATED" | "STOPPED" | "FAILED";

export interface ExecutionGraphTerminalNodeV2 {
  readonly schema_version: 2;
  readonly node_id: string;
  readonly status: ExecutionGraphTerminalNodeStatusV2;
  readonly evidence_sha256: string;
  readonly record_sha256: string;
}

export interface ExecutionGraphTerminalReceiptV2 {
  readonly schema_version: 2;
  readonly execution_graph_terminal_receipt_id: string;
  readonly goal_id: string;
  readonly run_id: string;
  readonly graph_revision_id: string;
  readonly graph_revision_sha256: string;
  readonly terminal_status: ExecutionGraphTerminalStatusV2;
  readonly reason_code: string;
  readonly current_postimage_root_sha256: string;
  readonly integration_frontier_sha256: string;
  readonly node_frontier: readonly ExecutionGraphTerminalNodeV2[];
  readonly node_frontier_root_sha256: string;
  readonly failure_evidence_sha256: string | null;
  readonly predecessor_authority_head_sha256: string;
  readonly trust: "HOST_DERIVED";
  readonly created_at_ms: number;
  readonly record_sha256: string;
}

export function boundedIdV2(value: unknown, label: string): string {
  if (typeof value !== "string" || !idPattern.test(value)) throw new TypeError(`${label} is invalid`);
  return value;
}

export function sha256V2(value: unknown, label: string): string {
  if (typeof value !== "string" || !sha256Pattern.test(value)) throw new TypeError(`${label} is invalid`);
  return value;
}

export function integerV2(value: unknown, label: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

export function exactKeysV2(value: object, keys: readonly string[], label: string): void {
  const expected = new Set(keys);
  for (const key of Object.keys(value)) if (!expected.delete(key)) throw new TypeError(`${label} has unexpected field ${key}`);
  if (expected.size > 0) throw new TypeError(`${label} is missing field ${[...expected][0]}`);
}

export function sealExecutionV2<T extends object>(domain: string, body: T): T & { readonly record_sha256: string } {
  return { ...body, record_sha256: canonicalJsonSha256({ domain, ...body }) };
}

export function executionNodeInputClosureV2(input: {
  readonly task: string;
  readonly requirement_ids: readonly string[];
  readonly obligation_ids: readonly string[];
  readonly exact_input_refs: readonly TaskPacketArtifactRefV2[];
  readonly decision_refs: readonly TaskPacketDecisionRefV2[];
  readonly output_schema_sha256: string;
  readonly oracle_sha256: string;
  readonly provider_profile_sha256: string;
}): string {
  if (!input.task || input.task.length > 16_384 || input.task !== input.task.normalize("NFC")) {
    throw new TypeError("Execution input task is invalid");
  }
  const requirements = [...assertStringArray(input.requirement_ids, "Execution input requirements", { nonEmpty: true })].sort();
  const obligations = [...assertStringArray(input.obligation_ids, "Execution input obligations", { nonEmpty: true })].sort();
  const refs = input.exact_input_refs.map((ref) => {
    exactKeysV2(ref, ["path", "sha256", "classification"], "Execution input ref");
    if (!ref.path || ref.path.length > 1_024 || ref.path.includes("\\") || ref.path.split("/").includes("..")) {
      throw new TypeError("Execution input ref path is invalid");
    }
    sha256V2(ref.sha256, "Execution input ref hash");
    return ref;
  }).sort((left, right) => left.path.localeCompare(right.path));
  if (new Set(refs.map((ref) => ref.path)).size !== refs.length) throw new TypeError("Execution input refs contain duplicate paths");
  const decisions = input.decision_refs.map((ref) => {
    exactKeysV2(ref, ["decision_id", "sha256"], "Execution Decision ref");
    boundedIdV2(ref.decision_id, "Execution Decision");
    sha256V2(ref.sha256, "Execution Decision hash");
    return ref;
  }).sort((left, right) => left.decision_id.localeCompare(right.decision_id));
  if (new Set(decisions.map((ref) => ref.decision_id)).size !== decisions.length) {
    throw new TypeError("Execution Decision refs contain duplicate IDs");
  }
  sha256V2(input.output_schema_sha256, "Execution output schema");
  sha256V2(input.oracle_sha256, "Execution oracle");
  sha256V2(input.provider_profile_sha256, "Execution provider profile");
  return canonicalJsonSha256({
    domain: "PCH-EXECUTION-NODE-INPUT-CLOSURE-V2",
    task: input.task,
    requirement_ids: requirements,
    obligation_ids: obligations,
    exact_input_refs: refs,
    decision_refs: decisions,
    output_schema_sha256: input.output_schema_sha256,
    oracle_sha256: input.oracle_sha256,
    provider_profile_sha256: input.provider_profile_sha256,
  });
}

function assertStringArray(value: unknown, label: string, options: { readonly nonEmpty?: boolean } = {}): readonly string[] {
  if (!Array.isArray(value) || (options.nonEmpty === true && value.length === 0)
    || value.some((entry) => typeof entry !== "string" || entry.length === 0 || entry.length > 512)
    || new Set(value).size !== value.length) {
    throw new TypeError(`${label} is invalid`);
  }
  return value as readonly string[];
}

function assertRecordHash(domain: string, value: Readonly<Record<string, unknown>>, label: string): void {
  const { record_sha256: actual, ...body } = value;
  if (typeof actual !== "string" || canonicalJsonSha256({ domain, ...body }) !== actual) {
    throw new TypeError(`${label} record hash mismatch`);
  }
}

export function createTaskPacketV2(input: {
  readonly graph: ExecutionGraphRevisionV2;
  readonly node_id: string;
  readonly attempt: number;
  readonly lease_generation: number;
  readonly fencing_token: number;
  readonly exact_input_refs: readonly TaskPacketArtifactRefV2[];
  readonly decision_refs: readonly TaskPacketDecisionRefV2[];
  readonly provider_call_plan_id: string | null;
  readonly provider_call_plan_sha256: string | null;
  readonly deadline_ms: number;
  readonly created_at_ms: number;
}, capabilityKey: string): TaskPacketV2 {
  assertExecutionGraphRecordV2(input.graph);
  const node = input.graph.nodes.find((entry) => entry.node_id === input.node_id);
  if (!node) throw new TypeError("TaskPacket node is not in the current graph");
  integerV2(input.attempt, "TaskPacket attempt", 1, node.max_retries + 1);
  integerV2(input.lease_generation, "TaskPacket lease generation", 1);
  integerV2(input.fencing_token, "TaskPacket fencing token", 1);
  integerV2(input.created_at_ms, "TaskPacket creation time");
  integerV2(input.deadline_ms, "TaskPacket deadline", input.created_at_ms + 1, node.deadline_ms);
  if (!capabilityKey) throw new TypeError("TaskPacket capability key is invalid");
  if ((input.provider_call_plan_id === null) !== (input.provider_call_plan_sha256 === null)) {
    throw new TypeError("TaskPacket ProviderCallPlan identity is incomplete");
  }
  if (input.provider_call_plan_id !== null) {
    boundedIdV2(input.provider_call_plan_id, "TaskPacket ProviderCallPlan");
    sha256V2(input.provider_call_plan_sha256, "TaskPacket ProviderCallPlan hash");
  }
  for (const ref of input.exact_input_refs) {
    exactKeysV2(ref, ["path", "sha256", "classification"], "TaskPacket input ref");
    if (!ref.path || ref.path.length > 1_024) throw new TypeError("TaskPacket input path is invalid");
    sha256V2(ref.sha256, "TaskPacket input ref hash");
  }
  for (const ref of input.decision_refs) {
    exactKeysV2(ref, ["decision_id", "sha256"], "TaskPacket Decision ref");
    boundedIdV2(ref.decision_id, "TaskPacket Decision");
    sha256V2(ref.sha256, "TaskPacket Decision hash");
  }
  const inputClosure = executionNodeInputClosureV2({
    task: node.task,
    requirement_ids: node.requirement_ids,
    obligation_ids: node.obligation_ids,
    exact_input_refs: input.exact_input_refs,
    decision_refs: input.decision_refs,
    output_schema_sha256: node.output_schema_sha256,
    oracle_sha256: node.oracle_sha256,
    provider_profile_sha256: node.provider_profile_sha256,
  });
  if (inputClosure !== node.input_closure_sha256) throw new TypeError("TaskPacket exact input closure is stale");
  const body = {
    schema_version: 2 as const,
    packet_id: idFromSha256("TASK_PACKET_V2", canonicalJsonSha256({
      graph: input.graph.record_sha256, node: node.record_sha256, attempt: input.attempt,
      lease: input.lease_generation, fence: input.fencing_token, stop: input.graph.stop_generation,
    })),
    goal_id: input.graph.goal_id,
    run_id: input.graph.run_id,
    work_cell_id: input.graph.work_cell_id,
    graph_revision_id: input.graph.execution_graph_revision_id,
    graph_revision_sha256: input.graph.record_sha256,
    node_id: node.node_id,
    node_spec_sha256: node.record_sha256,
    task: node.task,
    requirement_ids: node.requirement_ids,
    obligation_ids: node.obligation_ids,
    output_schema_sha256: node.output_schema_sha256,
    oracle_sha256: node.oracle_sha256,
    provider_profile_sha256: node.provider_profile_sha256,
    plan_revision_sha256: input.graph.plan_revision_sha256,
    topology_gate_receipt_sha256: input.graph.topology_gate_receipt_sha256,
    authorization_sha256: input.graph.authorization_sha256,
    baseline_sha256: input.graph.baseline_sha256,
    baseline_content_root_sha256: input.graph.baseline_content_root_sha256,
    environment_sha256: input.graph.environment_sha256,
    input_closure_sha256: node.input_closure_sha256,
    oracle_set_sha256: input.graph.oracle_set_sha256,
    config_sha256: input.graph.config_sha256,
    runtime_fingerprint_sha256: input.graph.runtime_fingerprint_sha256,
    attempt: input.attempt,
    lease_generation: input.lease_generation,
    fencing_token: input.fencing_token,
    stop_generation: input.graph.stop_generation,
    capabilities: node.capabilities,
    effect_ceiling: node.effect_ceiling,
    read_roots: node.read_roots,
    write_roots: node.write_roots,
    privacy_class: node.privacy_class,
    taint_classes: node.taint_classes,
    max_turns: node.max_turns,
    max_tool_calls: node.max_tool_calls,
    max_input_tokens: node.max_input_tokens,
    max_output_tokens: node.max_output_tokens,
    max_retries: node.max_retries,
    no_progress_limit: node.no_progress_limit,
    exact_input_refs: input.exact_input_refs,
    decision_refs: input.decision_refs,
    provider_call_plan_id: input.provider_call_plan_id,
    provider_call_plan_sha256: input.provider_call_plan_sha256,
    deadline_ms: input.deadline_ms,
    created_at_ms: input.created_at_ms,
  };
  const packetSha256 = canonicalJsonSha256({ domain: "PCH-TASK-PACKET-V2", ...body });
  return {
    ...body,
    packet_sha256: packetSha256,
    capability_hmac: hmacSha256Hex(capabilityKey, canonicalJson({ domain: "PCH-TASK-PACKET-CAPABILITY-V2", ...body, packet_sha256: packetSha256 })),
  };
}

export function assertTaskPacketV2(packet: TaskPacketV2, capabilityKey: string, current: {
  readonly graph_sha256: string;
  readonly authorization_sha256: string;
  readonly stop_generation: number;
  readonly now_ms: number;
}): void {
  assertTaskPacketRecordV2(packet);
  const { capability_hmac: capabilityHmac, ...authenticated } = packet;
  const expectedHmac = hmacSha256Hex(capabilityKey, canonicalJson({
    domain: "PCH-TASK-PACKET-CAPABILITY-V2", ...authenticated,
  }));
  if (expectedHmac !== capabilityHmac) throw new TypeError("TaskPacket capability HMAC mismatch");
  if (packet.graph_revision_sha256 !== current.graph_sha256) throw new TypeError("TaskPacket graph is stale");
  if (packet.authorization_sha256 !== current.authorization_sha256) throw new TypeError("TaskPacket authorization is stale");
  if (packet.stop_generation !== current.stop_generation) throw new TypeError("TaskPacket stop generation is stale");
  if (packet.deadline_ms <= current.now_ms) throw new TypeError("TaskPacket deadline expired");
}

export function assertTaskPacketRecordV2(packet: TaskPacketV2): void {
  const { packet_sha256: packetSha256, capability_hmac: capabilityHmac, ...body } = packet;
  if (canonicalJsonSha256({ domain: "PCH-TASK-PACKET-V2", ...body }) !== packetSha256) {
    throw new TypeError("TaskPacket hash mismatch");
  }
  sha256V2(capabilityHmac, "TaskPacket capability HMAC");
  boundedIdV2(packet.packet_id, "TaskPacket");
  boundedIdV2(packet.goal_id, "TaskPacket Goal");
  boundedIdV2(packet.run_id, "TaskPacket run");
  boundedIdV2(packet.work_cell_id, "TaskPacket WorkCell");
  boundedIdV2(packet.graph_revision_id, "TaskPacket graph");
  boundedIdV2(packet.node_id, "TaskPacket node");
  if (!packet.task || packet.task.length > 16_384 || packet.task !== packet.task.normalize("NFC")) {
    throw new TypeError("TaskPacket task is invalid");
  }
  assertStringArray(packet.requirement_ids, "TaskPacket requirements", { nonEmpty: true });
  assertStringArray(packet.obligation_ids, "TaskPacket obligations", { nonEmpty: true });
  const inputClosure = executionNodeInputClosureV2({
    task: packet.task,
    requirement_ids: packet.requirement_ids,
    obligation_ids: packet.obligation_ids,
    exact_input_refs: packet.exact_input_refs,
    decision_refs: packet.decision_refs,
    output_schema_sha256: packet.output_schema_sha256,
    oracle_sha256: packet.oracle_sha256,
    provider_profile_sha256: packet.provider_profile_sha256,
  });
  if (inputClosure !== packet.input_closure_sha256) throw new TypeError("TaskPacket exact input closure is invalid");
  for (const [value, label] of [
    [packet.graph_revision_sha256, "graph"], [packet.node_spec_sha256, "node"],
    [packet.authorization_sha256, "authorization"], [packet.baseline_sha256, "baseline"],
    [packet.baseline_content_root_sha256, "baseline content root"],
    [packet.environment_sha256, "environment"], [packet.input_closure_sha256, "input closure"],
    [packet.output_schema_sha256, "output schema"], [packet.oracle_sha256, "oracle"],
    [packet.provider_profile_sha256, "provider profile"],
  ] as const) sha256V2(value, `TaskPacket ${label}`);
}

export function finalizeExecutionNodeLeaseV2(input: {
  readonly packet: TaskPacketV2;
  readonly owner_hmac: string;
  readonly expires_at_ms: number;
  readonly created_at_ms: number;
}): ExecutionNodeLeaseV2 {
  assertTaskPacketRecordV2(input.packet);
  sha256V2(input.owner_hmac, "Execution node lease owner");
  integerV2(input.created_at_ms, "Execution node lease creation time");
  integerV2(input.expires_at_ms, "Execution node lease expiry", input.created_at_ms + 1, input.packet.deadline_ms);
  const body = {
    schema_version: 2 as const,
    execution_node_lease_id: idFromSha256("EXECUTION_NODE_LEASE_V2", canonicalJsonSha256({
      packet: input.packet.packet_sha256, generation: input.packet.lease_generation,
      fence: input.packet.fencing_token, owner: input.owner_hmac,
    })),
    goal_id: input.packet.goal_id,
    run_id: input.packet.run_id,
    graph_revision_id: input.packet.graph_revision_id,
    graph_revision_sha256: input.packet.graph_revision_sha256,
    node_id: input.packet.node_id,
    node_spec_sha256: input.packet.node_spec_sha256,
    packet_id: input.packet.packet_id,
    packet_sha256: input.packet.packet_sha256,
    generation: input.packet.lease_generation,
    fencing_token: input.packet.fencing_token,
    stop_generation: input.packet.stop_generation,
    owner_hmac: input.owner_hmac,
    expires_at_ms: input.expires_at_ms,
    created_at_ms: input.created_at_ms,
  };
  return sealExecutionV2("PCH-EXECUTION-NODE-LEASE-V2", body);
}

export function assertExecutionNodeLeaseV2(lease: ExecutionNodeLeaseV2): void {
  assertRecordHash("PCH-EXECUTION-NODE-LEASE-V2", lease as unknown as Readonly<Record<string, unknown>>, "Execution node lease");
  sha256V2(lease.owner_hmac, "Execution node lease owner");
  integerV2(lease.generation, "Execution node lease generation", 1);
  integerV2(lease.fencing_token, "Execution node lease fence", 1);
  integerV2(lease.stop_generation, "Execution node lease stop generation");
}

export function finalizeExecutionNodeAttemptOutcomeV2(input: {
  readonly graph: ExecutionGraphRevisionV2;
  readonly packet: TaskPacketV2;
  readonly lease: ExecutionNodeLeaseV2;
  readonly basis: ExecutionNodeAttemptBasisV2;
  readonly disposition: ExecutionNodeAttemptDispositionV2;
  readonly reason_code: string;
  readonly failure_sha256: string;
  readonly predecessor_authority_head_sha256: string;
  readonly created_at_ms: number;
}): ExecutionNodeAttemptOutcomeV2 {
  exactKeysV2(input, [
    "graph", "packet", "lease", "basis", "disposition", "reason_code", "failure_sha256",
    "predecessor_authority_head_sha256", "created_at_ms",
  ], "Execution node attempt outcome");
  assertExecutionGraphRecordV2(input.graph);
  assertTaskPacketRecordV2(input.packet);
  assertExecutionNodeLeaseV2(input.lease);
  const node = input.graph.nodes.find((entry) => entry.node_id === input.packet.node_id);
  if (!node || input.packet.graph_revision_id !== input.graph.execution_graph_revision_id
    || input.packet.graph_revision_sha256 !== input.graph.record_sha256
    || input.lease.graph_revision_id !== input.graph.execution_graph_revision_id
    || input.lease.node_id !== input.packet.node_id
    || input.lease.packet_id !== input.packet.packet_id
    || input.lease.packet_sha256 !== input.packet.packet_sha256
    || input.lease.generation !== input.packet.lease_generation
    || input.lease.fencing_token !== input.packet.fencing_token
    || input.lease.stop_generation !== input.packet.stop_generation) {
    throw new TypeError("Execution node attempt outcome closure mismatch");
  }
  if (!(["REQUEUED", "FAILED", "FENCED"] as const).includes(input.disposition)) {
    throw new TypeError("Execution node attempt disposition is invalid");
  }
  if (!(["WORKER_FAILURE", "LEASE_EXPIRED", "HOST_EPOCH_FENCED", "ABORT_CONFIRMED"] as const).includes(input.basis)) {
    throw new TypeError("Execution node attempt basis is invalid");
  }
  if ((input.basis === "LEASE_EXPIRED" && input.disposition !== "REQUEUED")
    || (input.disposition === "FAILED" && input.basis !== "WORKER_FAILURE")) {
    throw new TypeError("Execution node attempt basis and disposition are incompatible");
  }
  if (input.disposition === "REQUEUED" && input.packet.attempt > node.max_retries) {
    throw new TypeError("Execution node retry budget is exhausted");
  }
  boundedIdV2(input.reason_code, "Execution node attempt reason");
  sha256V2(input.failure_sha256, "Execution node attempt failure");
  sha256V2(input.predecessor_authority_head_sha256, "Execution node attempt predecessor");
  integerV2(input.created_at_ms, "Execution node attempt outcome time", input.packet.created_at_ms);
  const body = {
    schema_version: 2 as const,
    execution_node_attempt_outcome_id: idFromSha256("EXECUTION_NODE_ATTEMPT_V2", canonicalJsonSha256({
      packet: input.packet.packet_sha256,
      lease: input.lease.record_sha256,
      basis: input.basis,
      disposition: input.disposition,
      reason: input.reason_code,
      failure: input.failure_sha256,
    })),
    goal_id: input.packet.goal_id,
    run_id: input.packet.run_id,
    graph_revision_id: input.packet.graph_revision_id,
    graph_revision_sha256: input.packet.graph_revision_sha256,
    node_id: input.packet.node_id,
    node_spec_sha256: input.packet.node_spec_sha256,
    packet_id: input.packet.packet_id,
    packet_sha256: input.packet.packet_sha256,
    execution_node_lease_id: input.lease.execution_node_lease_id,
    execution_node_lease_sha256: input.lease.record_sha256,
    attempt: input.packet.attempt,
    lease_generation: input.packet.lease_generation,
    fencing_token: input.packet.fencing_token,
    stop_generation: input.packet.stop_generation,
    basis: input.basis,
    disposition: input.disposition,
    reason_code: input.reason_code,
    failure_sha256: input.failure_sha256,
    predecessor_authority_head_sha256: input.predecessor_authority_head_sha256,
    trust: "HOST_DERIVED" as const,
    created_at_ms: input.created_at_ms,
  };
  return sealExecutionV2("PCH-EXECUTION-NODE-ATTEMPT-OUTCOME-V2", body);
}

export function assertExecutionNodeAttemptOutcomeV2(outcome: ExecutionNodeAttemptOutcomeV2): void {
  assertRecordHash(
    "PCH-EXECUTION-NODE-ATTEMPT-OUTCOME-V2",
    outcome as unknown as Readonly<Record<string, unknown>>,
    "Execution node attempt outcome",
  );
  if (outcome.trust !== "HOST_DERIVED") throw new TypeError("Execution node attempt outcome trust is invalid");
  if (!(["REQUEUED", "FAILED", "FENCED"] as const).includes(outcome.disposition)) {
    throw new TypeError("Execution node attempt disposition is invalid");
  }
  if (!(["WORKER_FAILURE", "LEASE_EXPIRED", "HOST_EPOCH_FENCED", "ABORT_CONFIRMED"] as const).includes(outcome.basis)) {
    throw new TypeError("Execution node attempt basis is invalid");
  }
  boundedIdV2(outcome.reason_code, "Execution node attempt reason");
  sha256V2(outcome.failure_sha256, "Execution node attempt failure");
  sha256V2(outcome.predecessor_authority_head_sha256, "Execution node attempt predecessor");
}

function assertProposalPayload(kind: WorkerProposalKindV2, payload: WorkerProposalPayloadV2): void {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw new TypeError("Worker proposal payload is invalid");
  if (kind === "EVIDENCE_PROPOSAL") {
    exactKeysV2(payload, ["artifact_refs"], "Worker evidence proposal");
    const refs: readonly unknown[] = (payload as EvidenceProposalPayloadV2).artifact_refs;
    if (!Array.isArray(refs) || refs.length === 0) throw new TypeError("Worker evidence proposal is empty");
    for (const entry of refs) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new TypeError("Worker artifact ref is invalid");
      const ref = entry as { readonly sha256: unknown; readonly classification: unknown };
      exactKeysV2(ref, ["sha256", "classification"], "Worker artifact ref");
      sha256V2(ref.sha256, "Worker artifact ref");
    }
  } else if (kind === "PATCH_PROPOSAL") {
    exactKeysV2(payload, ["patch_set_id", "patch_set_sha256", "affected_paths", "preimage_root_sha256", "proposed_postimage_root_sha256"], "Worker patch proposal");
    const value = payload as PatchProposalPayloadV2;
    boundedIdV2(value.patch_set_id, "Worker PatchSet ID");
    sha256V2(value.patch_set_sha256, "Worker PatchSet");
    sha256V2(value.preimage_root_sha256, "Worker patch preimage");
    sha256V2(value.proposed_postimage_root_sha256, "Worker patch postimage");
    assertStringArray(value.affected_paths, "Worker affected paths", { nonEmpty: true });
  } else if (kind === "DECISION_REQUEST") {
    exactKeysV2(payload, ["decision_schema_sha256", "blocking", "question_hmac"], "Worker Decision request");
    const value = payload as DecisionRequestPayloadV2;
    sha256V2(value.decision_schema_sha256, "Worker Decision schema");
    sha256V2(value.question_hmac, "Worker Decision question HMAC");
    if (typeof value.blocking !== "boolean") throw new TypeError("Worker Decision blocking flag is invalid");
  } else if (kind === "CONFLICT_PROPOSAL") {
    exactKeysV2(payload, ["conflict_sha256", "candidate_patch_sha256"], "Worker conflict proposal");
    const value = payload as ConflictProposalPayloadV2;
    sha256V2(value.conflict_sha256, "Worker conflict");
    if (value.candidate_patch_sha256 !== null) sha256V2(value.candidate_patch_sha256, "Worker conflict patch");
  } else if (kind === "BLOCKED") {
    exactKeysV2(payload, ["reason_code", "evidence_refs"], "Worker blocked result");
    const value = payload as BlockedPayloadV2;
    boundedIdV2(value.reason_code, "Worker blocked reason");
    for (const ref of assertStringArray(value.evidence_refs, "Worker blocked evidence")) sha256V2(ref, "Worker blocked evidence");
  } else {
    exactKeysV2(payload, ["reason_code", "observed_stop_generation"], "Worker stopped result");
    const value = payload as StoppedPayloadV2;
    boundedIdV2(value.reason_code, "Worker stopped reason");
    integerV2(value.observed_stop_generation, "Worker observed stop generation");
  }
}

export function finalizeWorkerProposalV2(input: {
  readonly packet: TaskPacketV2;
  readonly kind: WorkerProposalKindV2;
  readonly payload: WorkerProposalPayloadV2;
  readonly created_at_ms: number;
}): WorkerProposalV2 {
  exactKeysV2(input, ["packet", "kind", "payload", "created_at_ms"], "Worker proposal");
  integerV2(input.created_at_ms, "Worker proposal creation time", input.packet.created_at_ms, input.packet.deadline_ms);
  assertProposalPayload(input.kind, input.payload);
  const body = {
    schema_version: 2 as const,
    proposal_id: idFromSha256("WORKER_PROPOSAL_V2", canonicalJsonSha256({
      packet: input.packet.packet_sha256, kind: input.kind, payload: input.payload,
    })),
    goal_id: input.packet.goal_id,
    run_id: input.packet.run_id,
    graph_revision_id: input.packet.graph_revision_id,
    graph_revision_sha256: input.packet.graph_revision_sha256,
    node_id: input.packet.node_id,
    packet_id: input.packet.packet_id,
    packet_sha256: input.packet.packet_sha256,
    lease_generation: input.packet.lease_generation,
    fencing_token: input.packet.fencing_token,
    stop_generation: input.packet.stop_generation,
    kind: input.kind,
    payload: input.payload,
    trust: "UNVERIFIED_PROPOSAL" as const,
    created_at_ms: input.created_at_ms,
  };
  return sealExecutionV2("PCH-WORKER-PROPOSAL-V2", body);
}

export function finalizeWorkerPatchSetV2(input: {
  readonly packet: TaskPacketV2;
  readonly patches: readonly WorkerPatchInputV2[];
  readonly created_at_ms: number;
}): WorkerPatchSetV2 {
  exactKeysV2(input, ["packet", "patches", "created_at_ms"], "Worker PatchSet");
  assertTaskPacketRecordV2(input.packet);
  if (input.packet.effect_ceiling !== "PATCH_PROPOSAL" || !input.packet.capabilities.includes("PATCH_PROPOSE")) {
    throw new TypeError("Worker PatchSet exceeds the TaskPacket capability grant");
  }
  if (!Array.isArray(input.patches as unknown) || input.patches.length < 1 || input.patches.length > 8_192) {
    throw new TypeError("Worker PatchSet entries are invalid");
  }
  integerV2(input.created_at_ms, "Worker PatchSet creation time", input.packet.created_at_ms, input.packet.deadline_ms);
  const entries = input.patches.map((patch): WorkerPatchEntryV2 => {
    exactKeysV2(patch, ["operation", "path", "beforeSha256", "content"], "Worker patch entry");
    let normalizedPath: string;
    try { normalizedPath = scopePathKey(patch.path).normalized; }
    catch { throw new TypeError("Worker patch entry identity is invalid"); }
    if (!(["CREATE", "MODIFY", "DELETE"] as const).includes(patch.operation)
      || patch.path.length > 1_024 || normalizedPath !== patch.path) {
      throw new TypeError("Worker patch entry identity is invalid");
    }
    if (!input.packet.write_roots.some((root) => scopeContains(root, normalizedPath))) {
      throw new TypeError("Worker patch entry is outside the TaskPacket write scope");
    }
    if ((patch.operation === "CREATE") !== (patch.beforeSha256 === null)) {
      throw new TypeError("Worker patch entry preimage is invalid");
    }
    if (patch.beforeSha256 !== null) sha256V2(patch.beforeSha256, "Worker patch entry preimage");
    if ((patch.operation === "DELETE") !== (patch.content === null)) {
      throw new TypeError("Worker patch entry content is invalid");
    }
    const afterSha256 = patch.content === null ? null : sha256Hex(patch.content);
    const body = {
      operation: patch.operation,
      path: normalizedPath,
      before_sha256: patch.beforeSha256,
      after_sha256: afterSha256,
      byte_length: patch.content?.byteLength ?? 0,
    };
    return sealExecutionV2("PCH-WORKER-PATCH-ENTRY-V2", body);
  }).sort((left, right) => left.path.localeCompare(right.path));
  if (new Set(entries.map((entry) => entry.path)).size !== entries.length) {
    throw new TypeError("Worker PatchSet contains duplicate paths");
  }
  if (new Set(entries.map((entry) => scopePathKey(entry.path).folded)).size !== entries.length) {
    throw new TypeError("Worker PatchSet contains filesystem-alias paths");
  }
  const proposedPostimage = canonicalJsonSha256({
    domain: "PCH-WORKER-PROPOSED-POSTIMAGE-V2",
    baseline: input.packet.baseline_content_root_sha256,
    entries: entries.map((entry) => entry.record_sha256),
  });
  const identity = canonicalJsonSha256({
    domain: "PCH-WORKER-PATCH-SET-V2",
    packet: input.packet.packet_sha256,
    entries: entries.map((entry) => entry.record_sha256),
    proposedPostimage,
  });
  return sealExecutionV2("PCH-WORKER-PATCH-SET-V2", {
    schema_version: 2 as const,
    patch_set_id: idFromSha256("PATCH_SET_V2", identity),
    goal_id: input.packet.goal_id,
    run_id: input.packet.run_id,
    graph_revision_id: input.packet.graph_revision_id,
    graph_revision_sha256: input.packet.graph_revision_sha256,
    node_id: input.packet.node_id,
    node_spec_sha256: input.packet.node_spec_sha256,
    packet_id: input.packet.packet_id,
    packet_sha256: input.packet.packet_sha256,
    baseline_sha256: input.packet.baseline_content_root_sha256,
    affected_paths: entries.map((entry) => entry.path),
    entries,
    proposed_postimage_root_sha256: proposedPostimage,
    created_at_ms: input.created_at_ms,
  });
}

export function assertWorkerPatchSetV2(patchSet: WorkerPatchSetV2, packet?: TaskPacketV2): void {
  exactKeysV2(patchSet, [
    "schema_version", "patch_set_id", "goal_id", "run_id", "graph_revision_id", "graph_revision_sha256",
    "node_id", "node_spec_sha256", "packet_id", "packet_sha256", "baseline_sha256", "affected_paths",
    "entries", "proposed_postimage_root_sha256", "created_at_ms", "record_sha256",
  ], "Worker PatchSet");
  assertRecordHash("PCH-WORKER-PATCH-SET-V2", patchSet as unknown as Readonly<Record<string, unknown>>, "Worker PatchSet");
  if (!Array.isArray(patchSet.entries as unknown) || patchSet.entries.length < 1
    || patchSet.affected_paths.length !== patchSet.entries.length) {
    throw new TypeError("Worker PatchSet entries are invalid");
  }
  patchSet.entries.forEach((entry, index) => {
    exactKeysV2(entry, ["operation", "path", "before_sha256", "after_sha256", "byte_length", "record_sha256"], "Worker patch entry");
    assertRecordHash("PCH-WORKER-PATCH-ENTRY-V2", entry as unknown as Readonly<Record<string, unknown>>, "Worker patch entry");
    let normalizedPath: string;
    try { normalizedPath = scopePathKey(entry.path).normalized; }
    catch { throw new TypeError("Worker PatchSet path root is invalid"); }
    if (normalizedPath !== entry.path || entry.path !== patchSet.affected_paths[index]
      || (index > 0 && patchSet.entries[index - 1]!.path.localeCompare(entry.path) >= 0)
      || !(["CREATE", "MODIFY", "DELETE"] as const).includes(entry.operation)
      || (entry.operation === "CREATE") !== (entry.before_sha256 === null)
      || (entry.operation === "DELETE") !== (entry.after_sha256 === null)
      || !Number.isSafeInteger(entry.byte_length) || entry.byte_length < 0
      || (entry.after_sha256 === null && entry.byte_length !== 0)) {
      throw new TypeError("Worker PatchSet path or entry semantics are invalid");
    }
    if (entry.before_sha256 !== null) sha256V2(entry.before_sha256, "Worker PatchSet entry preimage");
    if (entry.after_sha256 !== null) sha256V2(entry.after_sha256, "Worker PatchSet entry postimage");
  });
  if (new Set(patchSet.entries.map((entry) => scopePathKey(entry.path).folded)).size !== patchSet.entries.length) {
    throw new TypeError("Worker PatchSet contains filesystem-alias paths");
  }
  const proposedPostimage = canonicalJsonSha256({
    domain: "PCH-WORKER-PROPOSED-POSTIMAGE-V2",
    baseline: patchSet.baseline_sha256,
    entries: patchSet.entries.map((entry) => entry.record_sha256),
  });
  const identity = canonicalJsonSha256({
    domain: "PCH-WORKER-PATCH-SET-V2",
    packet: patchSet.packet_sha256,
    entries: patchSet.entries.map((entry) => entry.record_sha256),
    proposedPostimage,
  });
  if (patchSet.proposed_postimage_root_sha256 !== proposedPostimage
    || patchSet.patch_set_id !== idFromSha256("PATCH_SET_V2", identity)) {
    throw new TypeError("Worker PatchSet derived identity is invalid");
  }
  if (packet) {
    assertTaskPacketRecordV2(packet);
    if (patchSet.goal_id !== packet.goal_id || patchSet.run_id !== packet.run_id
      || patchSet.graph_revision_id !== packet.graph_revision_id
      || patchSet.graph_revision_sha256 !== packet.graph_revision_sha256
      || patchSet.node_id !== packet.node_id || patchSet.node_spec_sha256 !== packet.node_spec_sha256
      || patchSet.packet_id !== packet.packet_id || patchSet.packet_sha256 !== packet.packet_sha256
      || patchSet.baseline_sha256 !== packet.baseline_content_root_sha256
      || patchSet.created_at_ms < packet.created_at_ms || patchSet.created_at_ms > packet.deadline_ms
      || patchSet.entries.some((entry) => !packet.write_roots.some((root) => scopeContains(root, entry.path)))) {
      throw new TypeError("Worker PatchSet does not bind its TaskPacket write authority");
    }
  }
}

export function assertWorkerProposalV2(proposal: WorkerProposalV2): void {
  assertRecordHash("PCH-WORKER-PROPOSAL-V2", proposal as unknown as Readonly<Record<string, unknown>>, "Worker proposal");
  if (proposal.trust !== "UNVERIFIED_PROPOSAL") throw new TypeError("Worker proposal trust is invalid");
  assertProposalPayload(proposal.kind, proposal.payload);
}

export function finalizeExecutionIntegrationAttemptV2(input: {
  readonly graph: ExecutionGraphRevisionV2;
  readonly node_id: string;
  readonly proposal: WorkerProposalV2;
  readonly patch_set: WorkerPatchSetV2;
  readonly authorization_sha256: string;
  readonly expected_preimage_root_sha256: string;
  readonly lease_generation: number;
  readonly fencing_token: number;
  readonly owner_hmac: string;
  readonly expires_at_ms: number;
  readonly created_at_ms: number;
}): { readonly attempt: ExecutionIntegrationAttemptV2; readonly prepared: ExecutionIntegrationTransitionV2 } {
  assertExecutionGraphRecordV2(input.graph);
  assertWorkerProposalV2(input.proposal);
  assertWorkerPatchSetV2(input.patch_set);
  const node = input.graph.nodes.find((entry) => entry.node_id === input.node_id);
  if (!node || input.proposal.graph_revision_id !== input.graph.execution_graph_revision_id
    || input.proposal.graph_revision_sha256 !== input.graph.record_sha256 || input.proposal.node_id !== input.node_id
    || input.proposal.kind !== "PATCH_PROPOSAL") {
    throw new TypeError("Integration attempt does not bind a patch proposal in the current graph");
  }
  const payload = input.proposal.payload as PatchProposalPayloadV2;
  if (input.patch_set.goal_id !== input.proposal.goal_id || input.patch_set.run_id !== input.proposal.run_id
    || input.patch_set.graph_revision_id !== input.proposal.graph_revision_id
    || input.patch_set.graph_revision_sha256 !== input.proposal.graph_revision_sha256
    || input.patch_set.node_id !== input.proposal.node_id || input.patch_set.node_spec_sha256 !== node.record_sha256
    || input.patch_set.packet_id !== input.proposal.packet_id || input.patch_set.packet_sha256 !== input.proposal.packet_sha256
    || input.patch_set.patch_set_id !== payload.patch_set_id || input.patch_set.record_sha256 !== payload.patch_set_sha256
    || input.patch_set.baseline_sha256 !== payload.preimage_root_sha256
    || input.patch_set.proposed_postimage_root_sha256 !== payload.proposed_postimage_root_sha256
    || canonicalJson(input.patch_set.affected_paths) !== canonicalJson(payload.affected_paths)) {
    throw new TypeError("Integration attempt does not bind the durable Worker PatchSet");
  }
  sha256V2(input.authorization_sha256, "Integration authorization");
  sha256V2(input.expected_preimage_root_sha256, "Integration preimage");
  integerV2(input.lease_generation, "Integration lease generation", 1);
  integerV2(input.fencing_token, "Integration fencing token", 1);
  sha256V2(input.owner_hmac, "Integration owner");
  integerV2(input.created_at_ms, "Integration creation time");
  integerV2(input.expires_at_ms, "Integration expiry", input.created_at_ms + 1);
  const attemptBody = {
    schema_version: 2 as const,
    integration_attempt_id: idFromSha256("EXECUTION_INTEGRATION_V2", canonicalJsonSha256({
      graph: input.graph.record_sha256, node: node.record_sha256, proposal: input.proposal.record_sha256,
      preimage: input.expected_preimage_root_sha256, patch: input.patch_set.record_sha256,
      generation: input.lease_generation, fence: input.fencing_token,
    })),
    goal_id: input.graph.goal_id,
    run_id: input.graph.run_id,
    graph_revision_id: input.graph.execution_graph_revision_id,
    graph_revision_sha256: input.graph.record_sha256,
    node_id: node.node_id,
    node_spec_sha256: node.record_sha256,
    proposal_id: input.proposal.proposal_id,
    proposal_sha256: input.proposal.record_sha256,
    authorization_sha256: input.authorization_sha256,
    expected_preimage_root_sha256: input.expected_preimage_root_sha256,
    patch_set_id: input.patch_set.patch_set_id,
    patch_set_sha256: input.patch_set.record_sha256,
    lease_generation: input.lease_generation,
    fencing_token: input.fencing_token,
    owner_hmac: input.owner_hmac,
    expires_at_ms: input.expires_at_ms,
    created_at_ms: input.created_at_ms,
  };
  const attempt = sealExecutionV2("PCH-EXECUTION-INTEGRATION-ATTEMPT-V2", attemptBody);
  const prepared = finalizeExecutionIntegrationTransitionV2({
    attempt,
    ordinal: 0,
    state: "PREPARED",
    predecessor_transition_sha256: null,
    postimage_root_sha256: null,
    failure_sha256: null,
    created_at_ms: input.created_at_ms,
  });
  return { attempt, prepared };
}

export function finalizeExecutionIntegrationTransitionV2(input: {
  readonly attempt: ExecutionIntegrationAttemptV2;
  readonly ordinal: number;
  readonly state: ExecutionIntegrationStateV2;
  readonly predecessor_transition_sha256: string | null;
  readonly postimage_root_sha256: string | null;
  readonly failure_sha256: string | null;
  readonly created_at_ms: number;
}): ExecutionIntegrationTransitionV2 {
  assertExecutionIntegrationAttemptV2(input.attempt);
  integerV2(input.ordinal, "Integration transition ordinal");
  integerV2(input.created_at_ms, "Integration transition time", input.attempt.created_at_ms);
  if (input.ordinal === 0) {
    if (input.state !== "PREPARED" || input.predecessor_transition_sha256 !== null) {
      throw new TypeError("Integration initial transition is invalid");
    }
  } else {
    if (input.state === "PREPARED") throw new TypeError("Integration PREPARED transition cannot repeat");
    sha256V2(input.predecessor_transition_sha256, "Integration transition predecessor");
  }
  if (input.state === "OBSERVED" || input.state === "COMMITTED") sha256V2(input.postimage_root_sha256, "Integration postimage");
  else if (input.postimage_root_sha256 !== null) throw new TypeError("Integration postimage is not applicable");
  if (input.state === "REJECTED" || input.state === "FENCED") sha256V2(input.failure_sha256, "Integration failure");
  else if (input.failure_sha256 !== null) throw new TypeError("Integration failure is not applicable");
  const body = {
    schema_version: 2 as const,
    integration_transition_id: idFromSha256("EXEC_INTEGRATION_TRANSITION_V2", canonicalJsonSha256({
      attempt: input.attempt.record_sha256, ordinal: input.ordinal, state: input.state,
      predecessor: input.predecessor_transition_sha256, postimage: input.postimage_root_sha256,
      failure: input.failure_sha256,
    })),
    integration_attempt_id: input.attempt.integration_attempt_id,
    ordinal: input.ordinal,
    state: input.state,
    predecessor_transition_sha256: input.predecessor_transition_sha256,
    postimage_root_sha256: input.postimage_root_sha256,
    failure_sha256: input.failure_sha256,
    created_at_ms: input.created_at_ms,
  };
  return sealExecutionV2("PCH-EXECUTION-INTEGRATION-TRANSITION-V2", body);
}

export function assertExecutionIntegrationAttemptV2(attempt: ExecutionIntegrationAttemptV2): void {
  assertRecordHash("PCH-EXECUTION-INTEGRATION-ATTEMPT-V2", attempt as unknown as Readonly<Record<string, unknown>>, "Integration attempt");
  integerV2(attempt.lease_generation, "Integration lease generation", 1);
  integerV2(attempt.fencing_token, "Integration fence", 1);
}

export function assertExecutionIntegrationTransitionV2(transition: ExecutionIntegrationTransitionV2): void {
  assertRecordHash("PCH-EXECUTION-INTEGRATION-TRANSITION-V2", transition as unknown as Readonly<Record<string, unknown>>, "Integration transition");
}

export function finalizeHostOracleReceiptV2(input: {
  readonly graph: ExecutionGraphRevisionV2;
  readonly node_id: string;
  readonly packet_id: string;
  readonly packet_sha256: string;
  readonly proposal_id: string;
  readonly proposal_sha256: string;
  readonly postimage_root_sha256: string;
  readonly covered_obligation_ids: readonly string[];
  readonly validation_evidence: readonly Omit<HostOracleEvidenceV2, "schema_version" | "record_sha256">[];
  readonly predecessor_authority_head_sha256: string;
  readonly created_at_ms: number;
}): HostOracleReceiptV2 {
  assertExecutionGraphRecordV2(input.graph);
  const node = input.graph.nodes.find((entry) => entry.node_id === input.node_id);
  if (!node) throw new TypeError("Host OracleReceipt node is not in the current graph");
  boundedIdV2(input.packet_id, "Host OracleReceipt packet ID");
  sha256V2(input.packet_sha256, "Host OracleReceipt packet");
  boundedIdV2(input.proposal_id, "Host OracleReceipt proposal ID");
  sha256V2(input.proposal_sha256, "Host OracleReceipt proposal");
  sha256V2(input.postimage_root_sha256, "Host OracleReceipt postimage");
  sha256V2(input.predecessor_authority_head_sha256, "Host OracleReceipt predecessor");
  integerV2(input.created_at_ms, "Host OracleReceipt creation time");
  const covered = [...assertStringArray(input.covered_obligation_ids, "Host OracleReceipt obligations", { nonEmpty: true })].sort();
  if (covered.length !== node.obligation_ids.length || covered.some((id, index) => id !== node.obligation_ids[index])) {
    throw new TypeError("Host OracleReceipt must cover the complete node obligation closure");
  }
  if (!Array.isArray(input.validation_evidence as unknown) || input.validation_evidence.length === 0) {
    throw new TypeError("Host OracleReceipt validation evidence is invalid");
  }
  const evidence = input.validation_evidence.map((entry) => {
    exactKeysV2(entry, [
      "obligation_id", "oracle_pass_receipt_id", "oracle_pass_receipt_sha256", "evidence_requirement_id",
      "operation_attempt_id", "operation_attempt_sha256", "terminal_transition_id", "terminal_transition_sha256",
    ], "Host OracleReceipt evidence");
    for (const [value, label] of [
      [entry.obligation_id, "obligation"], [entry.oracle_pass_receipt_id, "Oracle PASS receipt"],
      [entry.evidence_requirement_id, "evidence requirement"], [entry.operation_attempt_id, "operation attempt"],
      [entry.terminal_transition_id, "terminal transition"],
    ] as const) boundedIdV2(value, `Host OracleReceipt ${label} ID`);
    for (const [value, label] of [
      [entry.oracle_pass_receipt_sha256, "Oracle PASS receipt"],
      [entry.operation_attempt_sha256, "operation attempt"],
      [entry.terminal_transition_sha256, "terminal transition"],
    ] as const) sha256V2(value, `Host OracleReceipt ${label}`);
    if (!covered.includes(entry.obligation_id)) throw new TypeError("Host OracleReceipt evidence is outside its obligation closure");
    return sealExecutionV2("PCH-HOST-ORACLE-EVIDENCE-V2", { schema_version: 2 as const, ...entry });
  }).sort((left, right) => left.obligation_id.localeCompare(right.obligation_id)
    || left.oracle_pass_receipt_id.localeCompare(right.oracle_pass_receipt_id));
  if (new Set(evidence.map((entry) => entry.oracle_pass_receipt_id)).size !== evidence.length) {
    throw new TypeError("Host OracleReceipt contains duplicate Oracle PASS receipts");
  }
  for (const obligationId of covered) {
    if (!evidence.some((entry) => entry.obligation_id === obligationId)) {
      throw new TypeError("Host OracleReceipt obligation lacks validation evidence");
    }
  }
  const validationRoot = canonicalJsonSha256({
    domain: "PCH-HOST-ORACLE-EVIDENCE-ROOT-V2",
    members: evidence.map((entry) => entry.record_sha256),
  });
  const body = {
    schema_version: 2 as const,
    host_oracle_receipt_id: idFromSha256("HOST_ORACLE_RECEIPT_V2", canonicalJsonSha256({
      graph: input.graph.record_sha256, node: node.record_sha256, packet: input.packet_sha256,
      proposal: input.proposal_sha256, postimage: input.postimage_root_sha256, evidence: validationRoot,
    })),
    goal_id: input.graph.goal_id,
    run_id: input.graph.run_id,
    graph_revision_id: input.graph.execution_graph_revision_id,
    graph_revision_sha256: input.graph.record_sha256,
    node_id: node.node_id,
    node_spec_sha256: node.record_sha256,
    packet_id: input.packet_id,
    packet_sha256: input.packet_sha256,
    proposal_id: input.proposal_id,
    proposal_sha256: input.proposal_sha256,
    oracle_sha256: node.oracle_sha256,
    oracle_set_sha256: input.graph.oracle_set_sha256,
    postimage_root_sha256: input.postimage_root_sha256,
    environment_sha256: input.graph.environment_sha256,
    covered_obligation_ids: covered,
    validation_evidence: evidence,
    validation_evidence_root_sha256: validationRoot,
    result: "PASS" as const,
    freshness: "CURRENT" as const,
    stop_generation: input.graph.stop_generation,
    predecessor_authority_head_sha256: input.predecessor_authority_head_sha256,
    trust: "HOST_DERIVED" as const,
    created_at_ms: input.created_at_ms,
  };
  return sealExecutionV2("PCH-HOST-ORACLE-RECEIPT-V2", body);
}

export function assertHostOracleReceiptV2(receipt: HostOracleReceiptV2, graph: ExecutionGraphRevisionV2): void {
  assertRecordHash("PCH-HOST-ORACLE-RECEIPT-V2", receipt as unknown as Readonly<Record<string, unknown>>, "Host OracleReceipt");
  if (receipt.trust !== "HOST_DERIVED" || receipt.result !== "PASS" || receipt.freshness !== "CURRENT"
    || receipt.graph_revision_id !== graph.execution_graph_revision_id
    || receipt.graph_revision_sha256 !== graph.record_sha256 || receipt.stop_generation !== graph.stop_generation) {
    throw new TypeError("Host OracleReceipt does not bind the current graph");
  }
  const node = graph.nodes.find((entry) => entry.node_id === receipt.node_id);
  if (!node || node.record_sha256 !== receipt.node_spec_sha256 || node.oracle_sha256 !== receipt.oracle_sha256
    || graph.oracle_set_sha256 !== receipt.oracle_set_sha256 || graph.environment_sha256 !== receipt.environment_sha256) {
    throw new TypeError("Host OracleReceipt semantic closure is invalid");
  }
  const rebuilt = finalizeHostOracleReceiptV2({
    graph,
    node_id: receipt.node_id,
    packet_id: receipt.packet_id,
    packet_sha256: receipt.packet_sha256,
    proposal_id: receipt.proposal_id,
    proposal_sha256: receipt.proposal_sha256,
    postimage_root_sha256: receipt.postimage_root_sha256,
    covered_obligation_ids: receipt.covered_obligation_ids,
    validation_evidence: receipt.validation_evidence.map(({ schema_version, record_sha256, ...entry }) => {
      void schema_version;
      void record_sha256;
      return entry;
    }),
    predecessor_authority_head_sha256: receipt.predecessor_authority_head_sha256,
    created_at_ms: receipt.created_at_ms,
  });
  if (rebuilt.record_sha256 !== receipt.record_sha256) throw new TypeError("Host OracleReceipt reconstruction failed");
}

export function finalizeHostNodeReceiptV2(input: {
  readonly graph: ExecutionGraphRevisionV2;
  readonly node_id: string;
  readonly packet_id: string;
  readonly packet_sha256: string;
  readonly proposal_id: string;
  readonly proposal_sha256: string;
  readonly kind: HostNodeReceiptKindV2;
  readonly evidence_sha256: string;
  readonly preimage_root_sha256: string | null;
  readonly postimage_root_sha256: string | null;
  readonly stop_generation: number;
  readonly predecessor_authority_head_sha256: string;
  readonly created_at_ms: number;
}): HostNodeReceiptV2 {
  assertExecutionGraphRecordV2(input.graph);
  const node = input.graph.nodes.find((entry) => entry.node_id === input.node_id);
  if (!node) throw new TypeError("Host receipt node is not in the current graph");
  boundedIdV2(input.packet_id, "Host receipt packet ID");
  sha256V2(input.packet_sha256, "Host receipt packet");
  boundedIdV2(input.proposal_id, "Host receipt proposal ID");
  sha256V2(input.proposal_sha256, "Host receipt proposal");
  sha256V2(input.evidence_sha256, "Host receipt evidence");
  sha256V2(input.predecessor_authority_head_sha256, "Host receipt predecessor");
  integerV2(input.stop_generation, "Host receipt stop generation");
  integerV2(input.created_at_ms, "Host receipt creation time");
  if (input.stop_generation !== input.graph.stop_generation) throw new TypeError("Host receipt stop generation is stale");
  if (input.kind === "PATCH_INTEGRATED") {
    sha256V2(input.preimage_root_sha256, "Host receipt preimage");
    sha256V2(input.postimage_root_sha256, "Host receipt postimage");
  } else if (input.preimage_root_sha256 !== null || input.postimage_root_sha256 !== null) {
    throw new TypeError("Host receipt image roots are not applicable");
  }
  const body = {
    schema_version: 2 as const,
    host_node_receipt_id: idFromSha256("HOST_NODE_RECEIPT_V2", canonicalJsonSha256({
      graph: input.graph.record_sha256, node: node.record_sha256, packet: input.packet_sha256,
      packetId: input.packet_id, proposalId: input.proposal_id,
      proposal: input.proposal_sha256, kind: input.kind, evidence: input.evidence_sha256,
      stop: input.stop_generation,
    })),
    goal_id: input.graph.goal_id,
    run_id: input.graph.run_id,
    graph_revision_id: input.graph.execution_graph_revision_id,
    graph_revision_sha256: input.graph.record_sha256,
    node_id: node.node_id,
    node_spec_sha256: node.record_sha256,
    packet_id: input.packet_id,
    packet_sha256: input.packet_sha256,
    proposal_id: input.proposal_id,
    proposal_sha256: input.proposal_sha256,
    kind: input.kind,
    evidence_sha256: input.evidence_sha256,
    preimage_root_sha256: input.preimage_root_sha256,
    postimage_root_sha256: input.postimage_root_sha256,
    stop_generation: input.stop_generation,
    predecessor_authority_head_sha256: input.predecessor_authority_head_sha256,
    trust: "HOST_DERIVED" as const,
    created_at_ms: input.created_at_ms,
  };
  return sealExecutionV2("PCH-HOST-NODE-RECEIPT-V2", body);
}

export function assertHostNodeReceiptV2(receipt: HostNodeReceiptV2, graph: ExecutionGraphRevisionV2): void {
  try {
    assertRecordHash("PCH-HOST-NODE-RECEIPT-V2", receipt as unknown as Readonly<Record<string, unknown>>, "Host receipt");
  } catch (error) {
    throw new TypeError("Host receipt is invalid", { cause: error });
  }
  if (receipt.trust !== "HOST_DERIVED" || receipt.graph_revision_id !== graph.execution_graph_revision_id
    || receipt.graph_revision_sha256 !== graph.record_sha256 || receipt.stop_generation !== graph.stop_generation) {
    throw new TypeError("Host receipt does not bind the current graph");
  }
  const node = graph.nodes.find((entry) => entry.node_id === receipt.node_id);
  if (!node || node.record_sha256 !== receipt.node_spec_sha256) throw new TypeError("Host receipt node binding is invalid");
}

export function finalizeExecutionStopV2(input: {
  readonly graph: ExecutionGraphRevisionV2;
  readonly stop_generation: number;
  readonly scope: ExecutionStopScopeV2;
  readonly reason: ExecutionStopReasonV2;
  readonly affected_node_ids: readonly string[];
  readonly predecessor_authority_head_sha256: string;
  readonly created_at_ms: number;
}): ExecutionStopV2 {
  assertExecutionGraphRecordV2(input.graph);
  integerV2(input.stop_generation, "Execution stop generation", 1);
  if (!(input.scope === "PARTIAL_INVALIDATION" || input.scope === "GRAPH_STOP")) {
    throw new TypeError("Execution stop scope is invalid");
  }
  if (input.scope === "PARTIAL_INVALIDATION" && !(input.reason === "MATERIAL_CHANGE" || input.reason === "SUPERSEDED")) {
    throw new TypeError("Partial execution invalidation requires a material change or supersession");
  }
  sha256V2(input.predecessor_authority_head_sha256, "Execution stop predecessor");
  integerV2(input.created_at_ms, "Execution stop creation time");
  const ids = [...assertStringArray(input.affected_node_ids, "Execution stop nodes", { nonEmpty: true })].sort();
  if (ids.some((nodeId) => !input.graph.nodes.some((node) => node.node_id === nodeId))) {
    throw new TypeError("Execution stop references an unknown node");
  }
  if (input.scope === "GRAPH_STOP" && ids.length !== input.graph.nodes.length) {
    throw new TypeError("Graph stop must cover every execution node");
  }
  if (input.scope === "PARTIAL_INVALIDATION") {
    const affected = new Set(ids);
    let changed = true;
    while (changed) {
      changed = false;
      for (const edge of input.graph.edges) {
        if (affected.has(edge.from_node_id) && !affected.has(edge.to_node_id)) {
          affected.add(edge.to_node_id);
          changed = true;
        }
      }
    }
    if (affected.size !== ids.length) throw new TypeError("Partial execution invalidation omits a dependent node");
  }
  const root = canonicalJsonSha256({ domain: "PCH-EXECUTION-STOP-NODES-V2", members: ids });
  const body = {
    schema_version: 2 as const,
    execution_stop_id: idFromSha256("EXECUTION_STOP_V2", canonicalJsonSha256({
      graph: input.graph.record_sha256, generation: input.stop_generation, scope: input.scope,
      reason: input.reason, nodes: root,
    })),
    goal_id: input.graph.goal_id,
    run_id: input.graph.run_id,
    graph_revision_id: input.graph.execution_graph_revision_id,
    graph_revision_sha256: input.graph.record_sha256,
    stop_generation: input.stop_generation,
    scope: input.scope,
    reason: input.reason,
    affected_node_ids: ids,
    affected_node_root_sha256: root,
    predecessor_authority_head_sha256: input.predecessor_authority_head_sha256,
    created_at_ms: input.created_at_ms,
  };
  return sealExecutionV2("PCH-EXECUTION-STOP-V2", body);
}

export function assertExecutionStopV2(stop: ExecutionStopV2): void {
  assertRecordHash("PCH-EXECUTION-STOP-V2", stop as unknown as Readonly<Record<string, unknown>>, "Execution stop");
  integerV2(stop.stop_generation, "Execution stop generation", 1);
  if (!(stop.scope === "PARTIAL_INVALIDATION" || stop.scope === "GRAPH_STOP")) throw new TypeError("Execution stop scope is invalid");
  sha256V2(stop.affected_node_root_sha256, "Execution stop node root");
  const ids = [...stop.affected_node_ids].sort();
  if (canonicalJsonSha256({ domain: "PCH-EXECUTION-STOP-NODES-V2", members: ids }) !== stop.affected_node_root_sha256) {
    throw new TypeError("Execution stop node root mismatch");
  }
}

export function finalizeExecutionGraphTerminalReceiptV2(input: {
  readonly graph: ExecutionGraphRevisionV2;
  readonly terminal_status: ExecutionGraphTerminalStatusV2;
  readonly reason_code: string;
  readonly current_postimage_root_sha256: string;
  readonly integration_frontier_sha256: string;
  readonly node_frontier: readonly Omit<ExecutionGraphTerminalNodeV2, "schema_version" | "record_sha256">[];
  readonly failure_evidence_sha256: string | null;
  readonly predecessor_authority_head_sha256: string;
  readonly created_at_ms: number;
}): ExecutionGraphTerminalReceiptV2 {
  assertExecutionGraphRecordV2(input.graph);
  if (!(input.terminal_status === "CLOSED" || input.terminal_status === "FAILED")) {
    throw new TypeError("Execution graph terminal status is invalid");
  }
  boundedIdV2(input.reason_code, "Execution graph terminal reason");
  sha256V2(input.current_postimage_root_sha256, "Execution graph terminal postimage");
  sha256V2(input.integration_frontier_sha256, "Execution graph integration frontier");
  sha256V2(input.predecessor_authority_head_sha256, "Execution graph terminal predecessor");
  integerV2(input.created_at_ms, "Execution graph terminal creation time");
  if (!Array.isArray(input.node_frontier as unknown) || input.node_frontier.length !== input.graph.nodes.length) {
    throw new TypeError("Execution graph terminal node frontier is incomplete");
  }
  const members = input.node_frontier.map((member) => {
    exactKeysV2(member, ["node_id", "status", "evidence_sha256"], "Execution graph terminal node");
    boundedIdV2(member.node_id, "Execution graph terminal node ID");
    sha256V2(member.evidence_sha256, "Execution graph terminal node evidence");
    if (!(["ORACLE_PASSED", "REJECTED", "INVALIDATED", "STOPPED", "FAILED"] as const)
      .includes(member.status)) throw new TypeError("Execution graph terminal node status is invalid");
    return sealExecutionV2("PCH-EXECUTION-GRAPH-TERMINAL-NODE-V2", { schema_version: 2 as const, ...member });
  }).sort((left, right) => left.node_id.localeCompare(right.node_id));
  if (members.some((member, index) => member.node_id !== input.graph.nodes[index]?.node_id)) {
    throw new TypeError("Execution graph terminal node frontier differs from the graph");
  }
  const success = new Set<ExecutionGraphTerminalNodeStatusV2>(["ORACLE_PASSED"]);
  if (input.terminal_status === "CLOSED") {
    if (members.some((member) => !success.has(member.status)) || input.failure_evidence_sha256 !== null) {
      throw new TypeError("CLOSED execution graph requires every node to be ORACLE_PASSED");
    }
  } else {
    sha256V2(input.failure_evidence_sha256, "Execution graph terminal failure evidence");
    if (members.every((member) => success.has(member.status))) {
      throw new TypeError("FAILED execution graph requires a failed terminal node");
    }
  }
  const nodeRoot = canonicalJsonSha256({
    domain: "PCH-EXECUTION-GRAPH-TERMINAL-NODE-ROOT-V2",
    members: members.map((member) => member.record_sha256),
  });
  const body = {
    schema_version: 2 as const,
    execution_graph_terminal_receipt_id: idFromSha256("EXECUTION_GRAPH_TERMINAL_V2", canonicalJsonSha256({
      graph: input.graph.record_sha256, status: input.terminal_status, postimage: input.current_postimage_root_sha256,
      integration: input.integration_frontier_sha256, nodes: nodeRoot, failure: input.failure_evidence_sha256,
    })),
    goal_id: input.graph.goal_id,
    run_id: input.graph.run_id,
    graph_revision_id: input.graph.execution_graph_revision_id,
    graph_revision_sha256: input.graph.record_sha256,
    terminal_status: input.terminal_status,
    reason_code: input.reason_code,
    current_postimage_root_sha256: input.current_postimage_root_sha256,
    integration_frontier_sha256: input.integration_frontier_sha256,
    node_frontier: members,
    node_frontier_root_sha256: nodeRoot,
    failure_evidence_sha256: input.failure_evidence_sha256,
    predecessor_authority_head_sha256: input.predecessor_authority_head_sha256,
    trust: "HOST_DERIVED" as const,
    created_at_ms: input.created_at_ms,
  };
  return sealExecutionV2("PCH-EXECUTION-GRAPH-TERMINAL-RECEIPT-V2", body);
}

export function assertExecutionGraphTerminalReceiptV2(
  receipt: ExecutionGraphTerminalReceiptV2,
  graph: ExecutionGraphRevisionV2,
): void {
  assertRecordHash(
    "PCH-EXECUTION-GRAPH-TERMINAL-RECEIPT-V2",
    receipt as unknown as Readonly<Record<string, unknown>>,
    "Execution graph terminal receipt",
  );
  if (receipt.trust !== "HOST_DERIVED" || receipt.graph_revision_id !== graph.execution_graph_revision_id
    || receipt.graph_revision_sha256 !== graph.record_sha256) {
    throw new TypeError("Execution graph terminal receipt does not bind the graph");
  }
  const rebuilt = finalizeExecutionGraphTerminalReceiptV2({
    graph,
    terminal_status: receipt.terminal_status,
    reason_code: receipt.reason_code,
    current_postimage_root_sha256: receipt.current_postimage_root_sha256,
    integration_frontier_sha256: receipt.integration_frontier_sha256,
    node_frontier: receipt.node_frontier.map(({ schema_version, record_sha256, ...member }) => {
      void schema_version;
      void record_sha256;
      return member;
    }),
    failure_evidence_sha256: receipt.failure_evidence_sha256,
    predecessor_authority_head_sha256: receipt.predecessor_authority_head_sha256,
    created_at_ms: receipt.created_at_ms,
  });
  if (rebuilt.record_sha256 !== receipt.record_sha256) {
    throw new TypeError("Execution graph terminal receipt reconstruction failed");
  }
}

export function assertExecutionGraphRecordV2(graph: ExecutionGraphRevisionV2): void {
  assertRecordHash("PCH-EXECUTION-GRAPH-REVISION-V2", graph as unknown as Readonly<Record<string, unknown>>, "Execution graph");
  for (const node of graph.nodes) {
    assertRecordHash("PCH-EXECUTION-NODE-SPEC-V2", node as unknown as Readonly<Record<string, unknown>>, "Execution node");
  }
  for (const edge of graph.edges) {
    assertRecordHash("PCH-EXECUTION-EDGE-V2", edge as unknown as Readonly<Record<string, unknown>>, "Execution edge");
  }
  const nodeRoot = canonicalJsonSha256({ domain: "PCH-EXECUTION-NODE-ROOT-V2", members: graph.nodes.map((node) => node.record_sha256) });
  const edgeRoot = canonicalJsonSha256({ domain: "PCH-EXECUTION-EDGE-ROOT-V2", members: graph.edges.map((edge) => edge.record_sha256) });
  if (nodeRoot !== graph.node_root_sha256 || edgeRoot !== graph.edge_root_sha256
    || canonicalJsonSha256({ domain: "PCH-EXECUTION-GRAPH-V2", nodes: nodeRoot, edges: edgeRoot }) !== graph.graph_sha256) {
    throw new TypeError("Execution graph member root mismatch");
  }
}
