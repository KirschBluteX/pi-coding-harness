import type { AuthorityConnection } from "../../authority/database.js";
import { canonicalJson, canonicalJsonSha256 } from "../../authority/canonical-json.js";
import { computeEventSha256 } from "../../authority/event-chain.js";
import { AuthorityIntegrityError } from "../../foundation/errors.js";
import { scopeContains } from "../scope-path.js";
import { registerArtifact, type ArtifactMetadata } from "../../authority/repositories/common.js";
import {
  assertDynamicMultiCandidateV2,
  assertStrongSingleBaselineV2,
  assertTopologyMeasurementEvidenceReceiptV2,
  assertTopologyMeasurementReceiptV2,
  assertTopologyGateReceiptV2,
  type DynamicMultiCandidateV2,
  type StrongSingleBaselineV2,
  type TopologyMeasurementClosureV2,
  type TopologyMeasurementEvidenceReceiptV2,
  type TopologyMeasurementReceiptV2,
  type TopologyGateReceiptV2,
} from "../../harness-v2/topology-gate.js";
import {
  assertExecutionGraphSemanticsV2,
  readyExecutionNodeIdsV2,
  successfulExecutionNodeIdsV2,
} from "./dag.js";
import {
  assertExecutionGraphRecordV2,
  assertExecutionGraphTerminalReceiptV2,
  assertExecutionIntegrationAttemptV2,
  assertExecutionIntegrationTransitionV2,
  assertExecutionNodeAttemptOutcomeV2,
  assertExecutionNodeLeaseV2,
  assertExecutionStopV2,
  assertHostOracleReceiptV2,
  assertHostNodeReceiptV2,
  assertTaskPacketRecordV2,
  assertWorkerProposalV2,
  assertWorkerPatchSetV2,
  type ExecutionCapabilityV2,
  type ExecutionEdgeConditionV2,
  type ExecutionEdgeV2,
  type ExecutionGraphRevisionV2,
  type ExecutionGraphTerminalNodeV2,
  type ExecutionGraphTerminalReceiptV2,
  type ExecutionIntegrationAttemptV2,
  type ExecutionIntegrationTransitionV2,
  type ExecutionNodeAttemptOutcomeV2,
  type ExecutionNodeLeaseV2,
  type ExecutionNodeSpecV2,
  type ExecutionPrivacyClassV2,
  type ExecutionStopV2,
  type HostOracleEvidenceV2,
  type HostOracleReceiptV2,
  type HostNodeReceiptKindV2,
  type HostNodeReceiptV2,
  type TaskPacketV2,
  type TaskPacketDecisionRefV2,
  type WorkerProposalV2,
  type WorkerPatchSetV2,
} from "./domain.js";
import {
  assertExecutionIntegrationJournalV2,
  type ExecutionIntegrationJournalV2,
} from "./integration-journal.js";
import {
  assertStrongSingleRolloutReceiptV1,
  type StrongSingleRolloutLookupV1,
  type StrongSingleRolloutPreparationV1,
  type StrongSingleRolloutReceiptV1,
} from "../../harness-v2/strong-single-rollout.js";
import {
  comparableWorkloadDimensionsV1,
  finalizeComparableWorkloadV1,
  finalizeStrongSingleWorkloadBindingV1,
  finalizeWorkloadComparabilityReceiptV1,
  type ComparableWorkloadV1,
  type StrongSingleWorkloadBindingV1,
  type WorkloadComparabilityReceiptV1,
} from "../../harness-v2/workload-comparability.js";
import { InputContextRepository } from "../../input-context/repository.js";
import {
  finalizeDynamicMultiProposalReceiptV2,
  type DynamicMultiProposalReceiptV2,
} from "../../harness-v2/dynamic-multi-proposal.js";

function tableExists(connection: AuthorityConnection, table: string): boolean {
  const row = connection.prepare("SELECT count(*) count FROM sqlite_master WHERE type='table' AND name=?").get(table) as {
    count?: unknown;
  } | undefined;
  return Number(row?.count ?? 0) === 1;
}

function text(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) throw new AuthorityIntegrityError(`Execution V2 ${key} is invalid`);
  return value;
}

function nullableText(row: Record<string, unknown>, key: string): string | null {
  return row[key] === null ? null : text(row, key);
}

function integer(row: Record<string, unknown>, key: string): number {
  const value = Number(row[key]);
  if (!Number.isSafeInteger(value)) throw new AuthorityIntegrityError(`Execution V2 ${key} is invalid`);
  return value;
}

function nullableInteger(row: Record<string, unknown>, key: string): number | null {
  return row[key] === null ? null : integer(row, key);
}

function topologyMeasurementFromRow(row: Record<string, unknown>): TopologyMeasurementReceiptV2 {
  const receipt: TopologyMeasurementReceiptV2 = {
    schema_version: 2,
    topology_measurement_receipt_id: text(row, "topology_measurement_receipt_id"),
    kind: text(row, "kind") as TopologyMeasurementReceiptV2["kind"],
    goal_id: text(row, "goal_id"),
    run_id: text(row, "run_id"),
    work_cell_id: text(row, "work_cell_id"),
    plan_revision_id: text(row, "plan_revision_id"),
    plan_revision_sha256: text(row, "plan_revision_sha256"),
    input_closure_sha256: text(row, "input_closure_sha256"),
    runtime_fingerprint_sha256: text(row, "runtime_fingerprint_sha256"),
    config_sha256: text(row, "config_sha256"),
    baseline_sha256: text(row, "baseline_sha256"),
    baseline_content_root_sha256: text(row, "baseline_content_root_sha256"),
    environment_sha256: text(row, "environment_sha256"),
    graph_proposal_sha256: nullableText(row, "graph_proposal_sha256"),
    correctness: text(row, "correctness") as "PASS" | "FAIL",
    quality_basis_points: integer(row, "quality_basis_points"),
    wall_time_ms: integer(row, "wall_time_ms"),
    provider_requests: integer(row, "provider_requests"),
    input_tokens: integer(row, "input_tokens"),
    output_tokens: integer(row, "output_tokens"),
    user_interventions: integer(row, "user_interventions"),
    safety_events: integer(row, "safety_events"),
    source_evidence_sha256: text(row, "source_evidence_sha256"),
    predecessor_authority_head_sha256: text(row, "predecessor_authority_head_sha256"),
    trust: text(row, "trust") as "HOST_DERIVED",
    observed_at_ms: integer(row, "observed_at_ms"),
    record_sha256: text(row, "record_sha256"),
  };
  assertTopologyMeasurementReceiptV2(receipt);
  return receipt;
}

function topologyMeasurementEvidenceFromRow(row: Record<string, unknown>): TopologyMeasurementEvidenceReceiptV2 {
  const receipt: TopologyMeasurementEvidenceReceiptV2 = {
    schema_version: 2,
    topology_measurement_evidence_receipt_id: text(row, "topology_measurement_evidence_receipt_id"),
    kind: text(row, "kind") as TopologyMeasurementEvidenceReceiptV2["kind"],
    goal_id: text(row, "goal_id"),
    run_id: text(row, "run_id"),
    work_cell_id: text(row, "work_cell_id"),
    plan_revision_id: text(row, "plan_revision_id"),
    plan_revision_sha256: text(row, "plan_revision_sha256"),
    input_closure_sha256: text(row, "input_closure_sha256"),
    runtime_fingerprint_sha256: text(row, "runtime_fingerprint_sha256"),
    config_sha256: text(row, "config_sha256"),
    baseline_sha256: text(row, "baseline_sha256"),
    baseline_content_root_sha256: text(row, "baseline_content_root_sha256"),
    environment_sha256: text(row, "environment_sha256"),
    graph_proposal_sha256: nullableText(row, "graph_proposal_sha256"),
    derivation: text(row, "derivation") as TopologyMeasurementEvidenceReceiptV2["derivation"],
    source_observation_sha256: text(row, "source_observation_sha256"),
    correctness: text(row, "correctness") as "PASS" | "FAIL",
    quality_basis_points: integer(row, "quality_basis_points"),
    wall_time_ms: integer(row, "wall_time_ms"),
    provider_requests: integer(row, "provider_requests"),
    input_tokens: integer(row, "input_tokens"),
    output_tokens: integer(row, "output_tokens"),
    user_interventions: integer(row, "user_interventions"),
    safety_events: integer(row, "safety_events"),
    predecessor_authority_head_sha256: text(row, "predecessor_authority_head_sha256"),
    observed_at_ms: integer(row, "observed_at_ms"),
    record_sha256: text(row, "record_sha256"),
  };
  assertTopologyMeasurementEvidenceReceiptV2(receipt);
  return receipt;
}

function json<T>(row: Record<string, unknown>, key: string): T {
  try { return JSON.parse(text(row, key)) as T; }
  catch (error) { throw new AuthorityIntegrityError(`Execution V2 ${key} is invalid JSON`, error); }
}

function assertTransaction(connection: AuthorityConnection): void {
  if (!connection.isTransaction) throw new AuthorityIntegrityError("Execution V2 authority must mutate inside the authority transaction");
}

function sameOrSubstitution(existing: Record<string, unknown> | undefined, hash: string, label: string): boolean {
  if (!existing) return false;
  if (existing.record_sha256 !== hash) throw new AuthorityIntegrityError(`${label} ID substitution`);
  return true;
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function integrationFrontierSha256(row: Record<string, unknown>): string {
  return canonicalJsonSha256({
    domain: "PCH-EXECUTION-INTEGRATION-FRONTIER-V2",
    state: text(row, "state"),
    integration_attempt_id: row.integration_attempt_id ?? null,
    latest_transition_sha256: row.latest_transition_sha256 ?? null,
    current_postimage_root_sha256: text(row, "current_postimage_root_sha256"),
    lease_generation: integer(row, "lease_generation"),
    fencing_token: integer(row, "fencing_token"),
  });
}

function taskPacketFromRow(row: Record<string, unknown>): TaskPacketV2 {
  const packet: TaskPacketV2 = {
    schema_version: 2,
    packet_id: text(row, "packet_id"),
    goal_id: text(row, "goal_id"),
    run_id: text(row, "run_id"),
    work_cell_id: text(row, "work_cell_id"),
    graph_revision_id: text(row, "execution_graph_revision_id"),
    graph_revision_sha256: text(row, "execution_graph_revision_sha256"),
    node_id: text(row, "node_id"),
    node_spec_sha256: text(row, "node_spec_sha256"),
    task: text(row, "task_text"),
    requirement_ids: json<readonly string[]>(row, "requirement_ids_json"),
    obligation_ids: json<readonly string[]>(row, "obligation_ids_json"),
    output_schema_sha256: text(row, "output_schema_sha256"),
    oracle_sha256: text(row, "oracle_sha256"),
    provider_profile_sha256: text(row, "provider_profile_sha256"),
    plan_revision_sha256: text(row, "plan_revision_sha256"),
    topology_gate_receipt_sha256: text(row, "topology_gate_receipt_sha256"),
    authorization_sha256: text(row, "authorization_sha256"),
    baseline_sha256: text(row, "baseline_sha256"),
    baseline_content_root_sha256: text(row, "baseline_content_root_sha256"),
    environment_sha256: text(row, "environment_sha256"),
    input_closure_sha256: text(row, "input_closure_sha256"),
    oracle_set_sha256: text(row, "oracle_set_sha256"),
    config_sha256: text(row, "config_sha256"),
    runtime_fingerprint_sha256: text(row, "runtime_fingerprint_sha256"),
    attempt: integer(row, "attempt"),
    lease_generation: integer(row, "lease_generation"),
    fencing_token: integer(row, "fencing_token"),
    stop_generation: integer(row, "stop_generation"),
    capabilities: json<TaskPacketV2["capabilities"]>(row, "capabilities_json"),
    effect_ceiling: text(row, "effect_ceiling") as TaskPacketV2["effect_ceiling"],
    read_roots: json<readonly string[]>(row, "read_roots_json"),
    write_roots: json<readonly string[]>(row, "write_roots_json"),
    privacy_class: text(row, "privacy_class") as TaskPacketV2["privacy_class"],
    taint_classes: json<readonly string[]>(row, "taint_classes_json"),
    max_turns: integer(row, "max_turns"),
    max_tool_calls: integer(row, "max_tool_calls"),
    max_input_tokens: integer(row, "max_input_tokens"),
    max_output_tokens: integer(row, "max_output_tokens"),
    max_retries: integer(row, "max_retries"),
    no_progress_limit: integer(row, "no_progress_limit"),
    exact_input_refs: json<TaskPacketV2["exact_input_refs"]>(row, "exact_input_refs_json"),
    decision_refs: json<TaskPacketV2["decision_refs"]>(row, "decision_refs_json"),
    provider_call_plan_id: nullableText(row, "provider_call_plan_id"),
    provider_call_plan_sha256: nullableText(row, "provider_call_plan_sha256"),
    deadline_ms: integer(row, "deadline_ms"),
    created_at_ms: integer(row, "created_at_ms"),
    packet_sha256: text(row, "packet_sha256"),
    capability_hmac: text(row, "capability_hmac"),
  };
  assertTaskPacketRecordV2(packet);
  return packet;
}

function nodeLeaseFromRow(row: Record<string, unknown>): ExecutionNodeLeaseV2 {
  const lease: ExecutionNodeLeaseV2 = {
    schema_version: 2,
    execution_node_lease_id: text(row, "execution_node_lease_id"),
    goal_id: text(row, "goal_id"),
    run_id: text(row, "run_id"),
    graph_revision_id: text(row, "execution_graph_revision_id"),
    graph_revision_sha256: text(row, "execution_graph_revision_sha256"),
    node_id: text(row, "node_id"),
    node_spec_sha256: text(row, "node_spec_sha256"),
    packet_id: text(row, "packet_id"),
    packet_sha256: text(row, "packet_sha256"),
    generation: integer(row, "generation"),
    fencing_token: integer(row, "fencing_token"),
    stop_generation: integer(row, "stop_generation"),
    owner_hmac: text(row, "owner_hmac"),
    expires_at_ms: integer(row, "expires_at_ms"),
    created_at_ms: integer(row, "created_at_ms"),
    record_sha256: text(row, "record_sha256"),
  };
  assertExecutionNodeLeaseV2(lease);
  return lease;
}

function workerProposalFromRow(row: Record<string, unknown>): WorkerProposalV2 {
  const proposal: WorkerProposalV2 = {
    schema_version: 2,
    proposal_id: text(row, "proposal_id"),
    goal_id: text(row, "goal_id"),
    run_id: text(row, "run_id"),
    graph_revision_id: text(row, "execution_graph_revision_id"),
    graph_revision_sha256: text(row, "execution_graph_revision_sha256"),
    node_id: text(row, "node_id"),
    packet_id: text(row, "packet_id"),
    packet_sha256: text(row, "packet_sha256"),
    lease_generation: integer(row, "lease_generation"),
    fencing_token: integer(row, "fencing_token"),
    stop_generation: integer(row, "stop_generation"),
    kind: text(row, "kind") as WorkerProposalV2["kind"],
    payload: json<WorkerProposalV2["payload"]>(row, "payload_json"),
    trust: text(row, "trust") as WorkerProposalV2["trust"],
    created_at_ms: integer(row, "created_at_ms"),
    record_sha256: text(row, "record_sha256"),
  };
  assertWorkerProposalV2(proposal);
  return proposal;
}

function workerPatchSetFromRow(row: Record<string, unknown>, packet: TaskPacketV2): WorkerPatchSetV2 {
  const patchSet: WorkerPatchSetV2 = {
    schema_version: 2,
    patch_set_id: text(row, "patch_set_id"),
    goal_id: text(row, "goal_id"),
    run_id: text(row, "run_id"),
    graph_revision_id: text(row, "execution_graph_revision_id"),
    graph_revision_sha256: text(row, "execution_graph_revision_sha256"),
    node_id: text(row, "node_id"),
    node_spec_sha256: text(row, "node_spec_sha256"),
    packet_id: text(row, "packet_id"),
    packet_sha256: text(row, "packet_sha256"),
    baseline_sha256: text(row, "baseline_sha256"),
    affected_paths: json<readonly string[]>(row, "affected_paths_json"),
    entries: json<WorkerPatchSetV2["entries"]>(row, "entries_json"),
    proposed_postimage_root_sha256: text(row, "proposed_postimage_root_sha256"),
    created_at_ms: integer(row, "created_at_ms"),
    record_sha256: text(row, "record_sha256"),
  };
  assertWorkerPatchSetV2(patchSet, packet);
  return patchSet;
}

function integrationAttemptFromRow(row: Record<string, unknown>): ExecutionIntegrationAttemptV2 {
  const attempt: ExecutionIntegrationAttemptV2 = {
    schema_version: 2,
    integration_attempt_id: text(row, "integration_attempt_id"),
    goal_id: text(row, "goal_id"),
    run_id: text(row, "run_id"),
    graph_revision_id: text(row, "execution_graph_revision_id"),
    graph_revision_sha256: text(row, "execution_graph_revision_sha256"),
    node_id: text(row, "node_id"),
    node_spec_sha256: text(row, "node_spec_sha256"),
    proposal_id: text(row, "proposal_id"),
    proposal_sha256: text(row, "proposal_sha256"),
    authorization_sha256: text(row, "authorization_sha256"),
    expected_preimage_root_sha256: text(row, "expected_preimage_root_sha256"),
    patch_set_id: text(row, "patch_set_id"),
    patch_set_sha256: text(row, "patch_set_sha256"),
    lease_generation: integer(row, "lease_generation"),
    fencing_token: integer(row, "fencing_token"),
    owner_hmac: text(row, "owner_hmac"),
    expires_at_ms: integer(row, "expires_at_ms"),
    created_at_ms: integer(row, "created_at_ms"),
    record_sha256: text(row, "record_sha256"),
  };
  assertExecutionIntegrationAttemptV2(attempt);
  return attempt;
}

function integrationTransitionFromRow(row: Record<string, unknown>): ExecutionIntegrationTransitionV2 {
  const transition: ExecutionIntegrationTransitionV2 = {
    schema_version: 2,
    integration_transition_id: text(row, "integration_transition_id"),
    integration_attempt_id: text(row, "integration_attempt_id"),
    ordinal: integer(row, "ordinal"),
    state: text(row, "state") as ExecutionIntegrationTransitionV2["state"],
    predecessor_transition_sha256: nullableText(row, "predecessor_transition_sha256"),
    postimage_root_sha256: nullableText(row, "postimage_root_sha256"),
    failure_sha256: nullableText(row, "failure_sha256"),
    created_at_ms: integer(row, "created_at_ms"),
    record_sha256: text(row, "record_sha256"),
  };
  assertExecutionIntegrationTransitionV2(transition);
  return transition;
}

function strongSingleRolloutFromRow(row: Record<string, unknown>): StrongSingleRolloutReceiptV1 {
  const receipt: StrongSingleRolloutReceiptV1 = {
    schema_version: 1,
    rollout_receipt_id: text(row, "rollout_receipt_id"),
    goal_id: text(row, "goal_id"),
    run_id: text(row, "run_id"),
    work_cell_id: text(row, "work_cell_id"),
    plan_revision_id: text(row, "plan_revision_id"),
    plan_revision_sha256: text(row, "plan_revision_sha256"),
    input_closure_sha256: text(row, "input_closure_sha256"),
    runtime_fingerprint_sha256: text(row, "runtime_fingerprint_sha256"),
    topology_revision: integer(row, "topology_revision"),
    topology_revision_sha256: text(row, "topology_revision_sha256"),
    config_sha256: text(row, "config_sha256"),
    authorization_id: text(row, "authorization_id"),
    authorization_sha256: text(row, "authorization_sha256"),
    baseline_sha256: text(row, "baseline_sha256"),
    baseline_content_root_sha256: text(row, "baseline_content_root_sha256"),
    environment_sha256: text(row, "environment_sha256"),
    completion_receipt_id: text(row, "completion_receipt_id"),
    completion_receipt_sha256: text(row, "completion_receipt_sha256"),
    correctness: text(row, "correctness") as "PASS",
    quality_basis_points: integer(row, "quality_basis_points") as 10_000,
    wall_time_ms: integer(row, "wall_time_ms"),
    provider_requests: integer(row, "provider_requests"),
    input_tokens: integer(row, "input_tokens"),
    output_tokens: integer(row, "output_tokens"),
    cache_read_tokens: integer(row, "cache_read_tokens"),
    provider_accounting_completeness: text(row, "provider_accounting_completeness") as "COMPLETE",
    provider_receipt_refs: json<readonly string[]>(row, "provider_receipt_refs_json"),
    provider_receipt_root_sha256: text(row, "provider_receipt_root_sha256"),
    user_interventions: integer(row, "user_interventions"),
    safety_events: integer(row, "safety_events"),
    started_at_ms: integer(row, "started_at_ms"),
    completed_at_ms: integer(row, "completed_at_ms"),
    record_sha256: text(row, "record_sha256"),
  };
  assertStrongSingleRolloutReceiptV1(receipt);
  return receipt;
}

function strongSingleWorkloadBindingFromRow(row: Record<string, unknown>): StrongSingleWorkloadBindingV1 {
  const workload = finalizeComparableWorkloadV1(Object.fromEntries(
    comparableWorkloadDimensionsV1.map((field) => [field, text(row, field)]),
  ) as unknown as Parameters<typeof finalizeComparableWorkloadV1>[0]);
  if (workload.workload_key_sha256 !== text(row, "workload_key_sha256")) {
    throw new AuthorityIntegrityError("Strong Single workload key is invalid");
  }
  const binding = finalizeStrongSingleWorkloadBindingV1({
    source_goal_id: text(row, "source_goal_id"),
    source_run_id: text(row, "source_run_id"),
    source_work_cell_id: text(row, "source_work_cell_id"),
    source_rollout_receipt_id: text(row, "source_rollout_receipt_id"),
    source_rollout_receipt_sha256: text(row, "source_rollout_receipt_sha256"),
    source_topology_revision: integer(row, "source_topology_revision"),
    source_topology_revision_sha256: text(row, "source_topology_revision_sha256"),
    workload,
    created_at_ms: integer(row, "created_at_ms"),
  });
  if (binding.strong_single_workload_binding_id !== text(row, "strong_single_workload_binding_id")
    || binding.record_sha256 !== text(row, "record_sha256")) {
    throw new AuthorityIntegrityError("Strong Single workload binding integrity failed");
  }
  return binding;
}

function dynamicMultiProposalFromRow(row: Record<string, unknown>): DynamicMultiProposalReceiptV2 {
  return finalizeDynamicMultiProposalReceiptV2({
    schema_version: 2,
    dynamic_multi_proposal_receipt_id: text(row, "dynamic_multi_proposal_receipt_id"),
    goal_id: text(row, "goal_id"),
    run_id: text(row, "run_id"),
    work_cell_id: text(row, "work_cell_id"),
    plan_revision_id: text(row, "plan_revision_id"),
    plan_revision_sha256: text(row, "plan_revision_sha256"),
    authorization_id: text(row, "authorization_id"),
    authorization_sha256: text(row, "authorization_sha256"),
    input_closure_sha256: text(row, "input_closure_sha256"),
    baseline_sha256: text(row, "baseline_sha256"),
    baseline_content_root_sha256: text(row, "baseline_content_root_sha256"),
    environment_sha256: text(row, "environment_sha256"),
    runtime_fingerprint_sha256: text(row, "runtime_fingerprint_sha256"),
    config_sha256: text(row, "config_sha256"),
    graph_proposal_sha256: text(row, "graph_proposal_sha256"),
    source: json<readonly Readonly<Record<string, unknown>>[]>(row, "source_json"),
    source_root_sha256: text(row, "source_root_sha256"),
    predecessor_authority_head_sha256: text(row, "predecessor_authority_head_sha256"),
    created_at_ms: integer(row, "created_at_ms"),
    record_sha256: text(row, "record_sha256"),
  });
}

function hostReceiptFromRow(row: Record<string, unknown>, graph: ExecutionGraphRevisionV2): HostNodeReceiptV2 {
  const receipt: HostNodeReceiptV2 = {
    schema_version: 2,
    host_node_receipt_id: text(row, "host_node_receipt_id"),
    goal_id: text(row, "goal_id"),
    run_id: text(row, "run_id"),
    graph_revision_id: text(row, "execution_graph_revision_id"),
    graph_revision_sha256: text(row, "execution_graph_revision_sha256"),
    node_id: text(row, "node_id"),
    node_spec_sha256: text(row, "node_spec_sha256"),
    packet_id: text(row, "packet_id"),
    packet_sha256: text(row, "packet_sha256"),
    proposal_id: text(row, "proposal_id"),
    proposal_sha256: text(row, "proposal_sha256"),
    kind: text(row, "kind") as HostNodeReceiptKindV2,
    evidence_sha256: text(row, "evidence_sha256"),
    preimage_root_sha256: nullableText(row, "preimage_root_sha256"),
    postimage_root_sha256: nullableText(row, "postimage_root_sha256"),
    stop_generation: integer(row, "stop_generation"),
    predecessor_authority_head_sha256: text(row, "predecessor_authority_head_sha256"),
    trust: text(row, "trust") as HostNodeReceiptV2["trust"],
    created_at_ms: integer(row, "created_at_ms"),
    record_sha256: text(row, "record_sha256"),
  };
  assertHostNodeReceiptV2(receipt, graph);
  return receipt;
}

function hostOracleReceiptFromRows(
  row: Record<string, unknown>,
  memberRows: readonly Record<string, unknown>[],
  graph: ExecutionGraphRevisionV2,
): HostOracleReceiptV2 {
  const evidence: HostOracleEvidenceV2[] = memberRows.map((member) => ({
    schema_version: 2,
    obligation_id: text(member, "obligation_id"),
    oracle_pass_receipt_id: text(member, "oracle_pass_receipt_id"),
    oracle_pass_receipt_sha256: text(member, "oracle_pass_receipt_sha256"),
    evidence_requirement_id: text(member, "evidence_requirement_id"),
    operation_attempt_id: text(member, "operation_attempt_id"),
    operation_attempt_sha256: text(member, "operation_attempt_sha256"),
    terminal_transition_id: text(member, "terminal_transition_id"),
    terminal_transition_sha256: text(member, "terminal_transition_sha256"),
    record_sha256: text(member, "record_sha256"),
  }));
  const receipt: HostOracleReceiptV2 = {
    schema_version: 2,
    host_oracle_receipt_id: text(row, "host_oracle_receipt_id"),
    goal_id: text(row, "goal_id"),
    run_id: text(row, "run_id"),
    graph_revision_id: text(row, "execution_graph_revision_id"),
    graph_revision_sha256: text(row, "execution_graph_revision_sha256"),
    node_id: text(row, "node_id"),
    node_spec_sha256: text(row, "node_spec_sha256"),
    packet_id: text(row, "packet_id"),
    packet_sha256: text(row, "packet_sha256"),
    proposal_id: text(row, "proposal_id"),
    proposal_sha256: text(row, "proposal_sha256"),
    oracle_sha256: text(row, "oracle_sha256"),
    oracle_set_sha256: text(row, "oracle_set_sha256"),
    postimage_root_sha256: text(row, "postimage_root_sha256"),
    environment_sha256: text(row, "environment_sha256"),
    covered_obligation_ids: json<readonly string[]>(row, "covered_obligation_ids_json"),
    validation_evidence: evidence,
    validation_evidence_root_sha256: text(row, "validation_evidence_root_sha256"),
    result: text(row, "result") as HostOracleReceiptV2["result"],
    freshness: text(row, "freshness") as HostOracleReceiptV2["freshness"],
    stop_generation: integer(row, "stop_generation"),
    predecessor_authority_head_sha256: text(row, "predecessor_authority_head_sha256"),
    trust: text(row, "trust") as HostOracleReceiptV2["trust"],
    created_at_ms: integer(row, "created_at_ms"),
    record_sha256: text(row, "record_sha256"),
  };
  assertHostOracleReceiptV2(receipt, graph);
  return receipt;
}

export interface ExecutionV2Projection {
  readonly graph: ExecutionGraphRevisionV2;
  readonly status: "RUNNING" | "STOPPED" | "CLOSED" | "FAILED";
  readonly stopGeneration: number;
  readonly currentPostimageRootSha256: string;
  readonly integrationState: "IDLE" | "PREPARED" | "OBSERVED" | "COMMITTED" | "REJECTED" | "FENCED";
  readonly integrationLeaseGeneration: number;
  readonly integrationFencingToken: number;
  readonly readyNodeIds: readonly string[];
  readonly activeNodeIds: readonly string[];
  readonly completedNodeIds: readonly string[];
  readonly oraclePendingNodeIds: readonly string[];
  readonly readyDispatches: readonly ExecutionNodeDispatchV2[];
}

export interface ExecutionNodeDispatchV2 {
  readonly nodeId: string;
  readonly attempt: number;
  readonly leaseGeneration: number;
  readonly fencingToken: number;
  readonly stopGeneration: number;
}

export interface ExecutionV2IntegritySummary {
  readonly available: boolean;
  readonly strongSingleRollouts: number;
  readonly strongSingleWorkloadBindings: number;
  readonly workloadComparabilityReceipts: number;
  readonly dynamicMultiProposals: number;
  readonly topologyMeasurementEvidence: number;
  readonly topologyMeasurements: number;
  readonly graphs: number;
  readonly nodes: number;
  readonly packets: number;
  readonly leases: number;
  readonly attemptOutcomes: number;
  readonly proposals: number;
  readonly patchSets: number;
  readonly patchArtifacts: number;
  readonly hostOracleReceipts: number;
  readonly hostOracleEvidence: number;
  readonly hostReceipts: number;
  readonly integrationAttempts: number;
  readonly integrationJournals: number;
  readonly integrationPreimages: number;
  readonly integrationTransitions: number;
  readonly stops: number;
  readonly graphTerminalReceipts: number;
  readonly graphTerminalNodes: number;
  readonly mismatches: number;
}

export interface WorkerPatchArtifactClosureV2 {
  readonly path: string;
  readonly artifact: ArtifactMetadata;
}

export interface WorkerPatchSetClosureV2 {
  readonly patchSet: WorkerPatchSetV2;
  readonly proposalId: string;
  readonly proposalSha256: string;
  readonly artifacts: readonly WorkerPatchArtifactClosureV2[];
}

export interface ExecutionIntegrationRecoveryV2 {
  readonly graph: ExecutionGraphRevisionV2;
  readonly attempt: ExecutionIntegrationAttemptV2;
  readonly latestTransition: ExecutionIntegrationTransitionV2;
  readonly journal: ExecutionIntegrationJournalV2;
  readonly packet: TaskPacketV2;
  readonly lease: ExecutionNodeLeaseV2;
  readonly proposal: WorkerProposalV2;
  readonly patchClosure: WorkerPatchSetClosureV2;
  readonly nodeStatus: string;
  readonly currentAuthorizationSha256: string;
  readonly authorizationRevokedAtMs: number | null;
  readonly authorizationExpiresAtMs: number;
}

export interface ExpiredExecutionNodeAttemptV2 {
  readonly packet: TaskPacketV2;
  readonly lease: ExecutionNodeLeaseV2;
}

export interface ExecutionStopPreparationV2 {
  readonly graph: ExecutionGraphRevisionV2;
  readonly stopGeneration: number;
  readonly predecessorAuthorityHeadSha256: string;
}

export interface TopologyAdmissionMeasurementsV2 {
  readonly strong_single: TopologyMeasurementReceiptV2;
  readonly candidate: TopologyMeasurementReceiptV2;
}

export interface StrongSingleRolloutCompletionV1 {
  readonly completion_receipt_id: string;
  readonly completion_receipt_sha256: string;
  readonly completed_at_ms: number;
  readonly user_interventions: number;
  readonly safety_events: number;
}

export interface ExecutionNodeOraclePreparationV2 {
  readonly graph: ExecutionGraphRevisionV2;
  readonly packet: TaskPacketV2;
  readonly proposal: WorkerProposalV2;
  readonly currentPostimageRootSha256: string;
}

export interface ExecutionV2Preparation {
  readonly goalId: string;
  readonly runId: string;
  readonly workCellId: string;
  readonly workCellSha256: string;
  readonly workCellOutcome: string;
  readonly workCellObligationIds: readonly string[];
  readonly workCellRequirementIds: readonly string[];
  readonly workCellDecisionRefs: readonly TaskPacketDecisionRefV2[];
  readonly workCellReadRoots: readonly string[];
  readonly workCellWriteRoots: readonly string[];
  readonly workCellEffectClasses: readonly string[];
  readonly workCellOracleSha256: string;
  readonly comparableWorkCellSemanticsSha256: string;
  readonly comparableRequirementContentRootSha256: string;
  readonly comparableObligationContentRootSha256: string;
  readonly comparableDecisionContentRootSha256: string;
  readonly comparableOracleSetSha256: string;
  readonly comparableScopeSha256: string;
  readonly comparableEffectPolicySha256: string;
  readonly planRevisionId: string;
  readonly planRevisionSha256: string;
  readonly inputClosureSha256: string;
  readonly authorizationId: string;
  readonly authorizationSha256: string;
  readonly baselineSha256: string;
  readonly baselineContentRootSha256: string;
  readonly baselineScopeManifest: readonly Readonly<Record<string, unknown>>[];
  readonly environmentSha256: string;
  readonly oracleSetSha256: string;
  readonly configSha256: string;
  readonly predecessorAuthorityHeadSha256: string;
}

export interface ComparableWorkloadRuntimeV1 {
  readonly runtimeFingerprintSha256: string;
  readonly providerProfileSha256: string;
  readonly cacheEpochSha256: string;
}

export interface ExecutionGraphTerminalPreparationV2 {
  readonly graph: ExecutionGraphRevisionV2;
  readonly terminalStatus: "CLOSED" | "FAILED";
  readonly currentPostimageRootSha256: string;
  readonly integrationFrontierSha256: string;
  readonly nodeFrontier: readonly Omit<ExecutionGraphTerminalNodeV2, "schema_version" | "record_sha256">[];
  readonly failureEvidenceSha256: string | null;
  readonly predecessorAuthorityHeadSha256: string;
}

export class ExecutionV2Repository {
  constructor(private readonly connection: AuthorityConnection) {}

  available(): boolean {
    return tableExists(this.connection, "execution_graph_revisions_v2")
      && tableExists(this.connection, "task_packets_v2")
      && tableExists(this.connection, "host_node_receipts_v2");
  }

  private assertAvailable(): void {
    if (!this.available()) throw new AuthorityIntegrityError("Dynamic Multi execution migration 028 is not available");
  }

  private assertCurrentReceiptAuthority(
    graph: ExecutionGraphRevisionV2,
    nodeId: string,
    stopGeneration: number,
    nowMs: number,
  ): void {
    const current = this.connection.prepare(`SELECT gh.status graph_status,gh.stop_generation graph_stop_generation,
        gh.execution_graph_revision_sha256,nh.status node_status,nh.stop_generation node_stop_generation,
        a.record_sha256 authorization_sha256,a.expires_at_ms,a.revoked_at_ms,
        ch.status work_cell_status
      FROM execution_graph_heads_v2 gh
      JOIN execution_node_heads_v2 nh
        ON nh.execution_graph_revision_id=gh.execution_graph_revision_id AND nh.node_id=?
      JOIN execution_authorizations_v1 a ON a.authorization_id=?
      JOIN work_cell_heads_v1 ch ON ch.work_cell_id=gh.work_cell_id AND ch.goal_id=gh.goal_id
      WHERE gh.run_id=? AND gh.goal_id=? AND gh.work_cell_id=?
        AND gh.execution_graph_revision_id=?`).get(
      nodeId,
      graph.authorization_id,
      graph.run_id,
      graph.goal_id,
      graph.work_cell_id,
      graph.execution_graph_revision_id,
    ) as Record<string, unknown> | undefined;
    if (!current || current.graph_status !== "RUNNING" || current.work_cell_status !== "RUNNING"
      || current.execution_graph_revision_sha256 !== graph.record_sha256
      || current.authorization_sha256 !== graph.authorization_sha256
      || current.revoked_at_ms !== null
      || integer(current, "expires_at_ms") <= nowMs
      || integer(current, "graph_stop_generation") < stopGeneration
      || integer(current, "node_stop_generation") !== stopGeneration
      || ["REJECTED", "INVALIDATED", "STOPPED", "FAILED"].includes(text(current, "node_status"))) {
      throw new AuthorityIntegrityError("Host receipt is outside the current graph, WorkCell, stop, or authorization frontier");
    }
  }

  readPreparation(goalId: string, runId: string): ExecutionV2Preparation {
    this.assertAvailable();
    const row = this.connection.prepare(`SELECT r.goal_id,h.run_id,h.topology_revision,t.config_sha256,
      ch.work_cell_id,c.spec_sha256,c.contract_id,c.outcome,c.oracle_json,c.obligation_ids_json,
      c.read_roots_json,c.write_roots_json,c.effect_classes_json,
      c.risk,c.reversible,c.budget_json,
      ph.plan_revision_id,ph.plan_revision_sha256,p.input_closure_sha256,
      a.authorization_id,a.record_sha256 authorization_sha256,
      b.record_sha256 baseline_sha256,b.content_root_sha256 baseline_content_root_sha256,
      b.scope_manifest_json baseline_scope_manifest_json,b.environment_sha256,
      e.event_sha256 predecessor_authority_head_sha256
      FROM managed_run_heads_v1 h
      JOIN managed_runs_v1 r ON r.run_id=h.run_id
      JOIN topology_revisions_v1 t ON t.run_id=h.run_id AND t.revision=h.topology_revision
      JOIN work_cell_heads_v1 ch ON ch.goal_id=r.goal_id AND ch.status='RUNNING'
      JOIN work_cells_v1 c ON c.work_cell_id=ch.work_cell_id
      JOIN plan_heads_v2 ph ON ph.goal_id=r.goal_id
      JOIN plan_revisions_v2 p ON p.plan_revision_id=ph.plan_revision_id
        AND p.contract_id=c.contract_id AND p.route_id=c.route_id
      JOIN plan_subjects_v2 ps ON ps.plan_revision_id=p.plan_revision_id
        AND ps.subject_kind='WORK_CELL' AND ps.subject_id=c.logical_key AND ps.revision_sha256=c.spec_sha256
      JOIN execution_authorizations_v1 a ON a.goal_id=r.goal_id AND a.work_cell_id=ch.work_cell_id
        AND a.contract_id=c.contract_id AND a.route_id=c.route_id AND a.revoked_at_ms IS NULL
      JOIN workspace_baselines_v1 b ON b.baseline_id=a.baseline_id
      JOIN events e ON e.goal_id=r.goal_id
      WHERE r.goal_id=? AND h.run_id=? AND h.status='ACTIVE'
        AND e.sequence=(SELECT MAX(sequence) FROM events WHERE goal_id=r.goal_id)`).get(
      goalId, runId,
    ) as Record<string, unknown> | undefined;
    if (!row) throw new AuthorityIntegrityError("Execution V2 preparation closure is unavailable");
    const oracle = json<unknown>(row, "oracle_json");
    const obligations = json<readonly string[]>(row, "obligation_ids_json");
    const planRevisionId = text(row, "plan_revision_id");
    const planSubjects = this.connection.prepare(`SELECT subject_kind,subject_id,revision_sha256
      FROM plan_subjects_v2 WHERE plan_revision_id=? AND subject_kind IN ('REQUIREMENT','DECISION')
      ORDER BY ordinal`).all(planRevisionId) as Record<string, unknown>[];
    const requirementIds = planSubjects.filter((subject) => subject.subject_kind === "REQUIREMENT")
      .map((subject) => text(subject, "subject_id"));
    if (requirementIds.length === 0) {
      throw new AuthorityIntegrityError("Execution V2 preparation lacks its frozen Plan Requirement closure");
    }
    const decisionRefs = planSubjects.filter((subject) => subject.subject_kind === "DECISION")
      .map((subject) => ({
        decision_id: text(subject, "subject_id"),
        sha256: text(subject, "revision_sha256"),
      }));
    const requirementSemanticRows = this.connection.prepare(`SELECT requirement.semantic_key,requirement.kind,
        requirement.priority,requirement.statement
      FROM plan_subjects_v2 subject
      JOIN plan_revisions_v2 plan ON plan.plan_revision_id=subject.plan_revision_id
      JOIN requirement_items_v2 requirement
        ON requirement.requirement_revision_id=plan.requirement_revision_id
        AND requirement.requirement_id=subject.subject_id
        AND requirement.record_sha256=subject.revision_sha256
      WHERE subject.plan_revision_id=? AND subject.subject_kind='REQUIREMENT'
      ORDER BY requirement.semantic_key,requirement.kind,requirement.priority,requirement.statement`).all(
      planRevisionId,
    ) as Record<string, unknown>[];
    if (requirementSemanticRows.length !== requirementIds.length) {
      throw new AuthorityIntegrityError("Execution V2 comparable Requirement closure is incomplete");
    }
    const requirementMembers = requirementSemanticRows.map((member) => ({
      semantic_key: text(member, "semantic_key"),
      kind: text(member, "kind"),
      priority: text(member, "priority"),
      statement: text(member, "statement"),
    }));
    const contractId = text(row, "contract_id");
    const obligationRows = this.connection.prepare(`SELECT obligation_id,semantic_key,priority,statement,
        oracle_json,dependencies_json
      FROM task_obligations_v1 WHERE contract_id=? ORDER BY ordinal`).all(contractId) as Record<string, unknown>[];
    const obligationKeyById = new Map(obligationRows.map((member) => [
      text(member, "obligation_id"), text(member, "semantic_key"),
    ]));
    const obligationIdsSet = new Set(obligations);
    const obligationMembers = obligationRows.filter((member) => obligationIdsSet.has(text(member, "obligation_id")))
      .map((member) => ({
        semantic_key: text(member, "semantic_key"),
        priority: text(member, "priority"),
        statement: text(member, "statement"),
        oracle: json<Readonly<Record<string, unknown>>>(member, "oracle_json"),
        dependencies: json<readonly string[]>(member, "dependencies_json").map((dependency) => {
          const key = obligationKeyById.get(dependency);
          if (!key) throw new AuthorityIntegrityError("Comparable obligation dependency is outside the Contract");
          return key;
        }).sort(),
      })).sort((left, right) => left.semantic_key.localeCompare(right.semantic_key));
    if (obligationMembers.length !== obligations.length) {
      throw new AuthorityIntegrityError("Execution V2 comparable obligation closure is incomplete");
    }
    const decisionRows = this.connection.prepare(`SELECT decision.decision_key,decision.kind,decision.question,
        decision.materiality,decision.blocking,decision.trigger_kind,decision.latest_resolution_stage,
        decision.default_action,decision.default_value_json,decision.reversibility,
        resolution.action,resolution.authority_actor,resolution.at_stage,resolution.selected_value_json
      FROM plan_subjects_v2 subject
      JOIN plan_revisions_v2 plan ON plan.plan_revision_id=subject.plan_revision_id
      JOIN decision_requirements_v2 decision
        ON decision.requirement_revision_id=plan.requirement_revision_id
        AND decision.decision_requirement_id=subject.subject_id
        AND decision.record_sha256=subject.revision_sha256
      LEFT JOIN decision_resolutions_v2 resolution
        ON resolution.decision_requirement_revision_id=decision.decision_requirement_revision_id
        AND resolution.resolution_revision=(SELECT max(latest.resolution_revision)
          FROM decision_resolutions_v2 latest
          WHERE latest.decision_requirement_revision_id=decision.decision_requirement_revision_id)
      WHERE subject.plan_revision_id=? AND subject.subject_kind='DECISION'
      ORDER BY decision.decision_key`).all(planRevisionId) as Record<string, unknown>[];
    if (decisionRows.length !== decisionRefs.length) {
      throw new AuthorityIntegrityError("Execution V2 comparable Decision closure is incomplete");
    }
    const decisionMembers = decisionRows.map((member) => ({
      decision_key: text(member, "decision_key"),
      kind: text(member, "kind"),
      question: text(member, "question"),
      materiality: text(member, "materiality"),
      blocking: integer(member, "blocking") === 1,
      trigger_kind: text(member, "trigger_kind"),
      latest_resolution_stage: text(member, "latest_resolution_stage"),
      default_action: text(member, "default_action"),
      default_value: json<unknown>(member, "default_value_json"),
      reversibility: text(member, "reversibility"),
      resolution: member.action === null ? null : {
        action: text(member, "action"),
        authority_actor: text(member, "authority_actor"),
        at_stage: text(member, "at_stage"),
        selected_value: json<unknown>(member, "selected_value_json"),
      },
    }));
    const readRoots = json<readonly string[]>(row, "read_roots_json");
    const writeRoots = json<readonly string[]>(row, "write_roots_json");
    const effectClasses = json<readonly string[]>(row, "effect_classes_json");
    const comparableWorkCellSemanticsSha256 = canonicalJsonSha256({
      domain: "PCH-COMPARABLE-WORK-CELL-SEMANTICS-V1",
      outcome: text(row, "outcome"),
      risk: text(row, "risk"),
      reversible: integer(row, "reversible") === 1,
      budget: json<unknown>(row, "budget_json"),
    });
    const comparableRequirementContentRootSha256 = canonicalJsonSha256({
      domain: "PCH-COMPARABLE-REQUIREMENT-CONTENT-ROOT-V1", members: requirementMembers,
    });
    const comparableObligationContentRootSha256 = canonicalJsonSha256({
      domain: "PCH-COMPARABLE-OBLIGATION-CONTENT-ROOT-V1", members: obligationMembers,
    });
    const comparableDecisionContentRootSha256 = canonicalJsonSha256({
      domain: "PCH-COMPARABLE-DECISION-CONTENT-ROOT-V1", members: decisionMembers,
    });
    const comparableOracleSetSha256 = canonicalJsonSha256({
      domain: "PCH-COMPARABLE-ORACLE-SET-V1",
      work_cell_oracle: oracle,
      obligation_oracles: obligationMembers.map((member) => ({ key: member.semantic_key, oracle: member.oracle })),
    });
    const comparableScopeSha256 = canonicalJsonSha256({
      domain: "PCH-COMPARABLE-SCOPE-V1", read_roots: readRoots, write_roots: writeRoots,
    });
    const comparableEffectPolicySha256 = canonicalJsonSha256({
      domain: "PCH-COMPARABLE-EFFECT-POLICY-V1", effect_classes: effectClasses,
    });
    return {
      goalId: text(row, "goal_id"),
      runId: text(row, "run_id"),
      workCellId: text(row, "work_cell_id"),
      workCellSha256: text(row, "spec_sha256"),
      workCellOutcome: text(row, "outcome"),
      workCellObligationIds: obligations,
      workCellRequirementIds: requirementIds,
      workCellDecisionRefs: decisionRefs,
      workCellReadRoots: readRoots,
      workCellWriteRoots: writeRoots,
      workCellEffectClasses: effectClasses,
      workCellOracleSha256: canonicalJsonSha256(oracle),
      comparableWorkCellSemanticsSha256,
      comparableRequirementContentRootSha256,
      comparableObligationContentRootSha256,
      comparableDecisionContentRootSha256,
      comparableOracleSetSha256,
      comparableScopeSha256,
      comparableEffectPolicySha256,
      planRevisionId,
      planRevisionSha256: text(row, "plan_revision_sha256"),
      inputClosureSha256: text(row, "input_closure_sha256"),
      authorizationId: text(row, "authorization_id"),
      authorizationSha256: text(row, "authorization_sha256"),
      baselineSha256: text(row, "baseline_sha256"),
      baselineContentRootSha256: text(row, "baseline_content_root_sha256"),
      baselineScopeManifest: json<readonly Readonly<Record<string, unknown>>[]>(row, "baseline_scope_manifest_json"),
      environmentSha256: text(row, "environment_sha256"),
      oracleSetSha256: canonicalJsonSha256({ domain: "PCH-EXECUTION-ORACLE-SET-V2", oracle, obligations }),
      configSha256: text(row, "config_sha256"),
      predecessorAuthorityHeadSha256: text(row, "predecessor_authority_head_sha256"),
    };
  }

  comparableWorkload(
    preparation: ExecutionV2Preparation,
    runtime: ComparableWorkloadRuntimeV1,
  ): ComparableWorkloadV1 {
    return finalizeComparableWorkloadV1({
      work_cell_semantics_sha256: preparation.comparableWorkCellSemanticsSha256,
      requirement_content_root_sha256: preparation.comparableRequirementContentRootSha256,
      obligation_content_root_sha256: preparation.comparableObligationContentRootSha256,
      decision_content_root_sha256: preparation.comparableDecisionContentRootSha256,
      oracle_set_sha256: preparation.comparableOracleSetSha256,
      scope_sha256: preparation.comparableScopeSha256,
      effect_policy_sha256: preparation.comparableEffectPolicySha256,
      input_content_root_sha256: preparation.baselineContentRootSha256,
      environment_sha256: preparation.environmentSha256,
      runtime_fingerprint_sha256: runtime.runtimeFingerprintSha256,
      comparison_config_sha256: preparation.configSha256,
      provider_profile_sha256: runtime.providerProfileSha256,
      cache_epoch_sha256: runtime.cacheEpochSha256,
    });
  }

  recordDynamicMultiProposal(proposal: DynamicMultiProposalReceiptV2, eventSequence: number): boolean {
    this.assertAvailable();
    assertTransaction(this.connection);
    const expected = finalizeDynamicMultiProposalReceiptV2(proposal);
    if (expected.dynamic_multi_proposal_receipt_id !== proposal.dynamic_multi_proposal_receipt_id
      || expected.record_sha256 !== proposal.record_sha256) {
      throw new AuthorityIntegrityError("Dynamic Multi proposal receipt is invalid");
    }
    const existing = this.connection.prepare(`SELECT record_sha256 FROM dynamic_multi_proposal_receipts_v2
      WHERE dynamic_multi_proposal_receipt_id=?`).get(
      proposal.dynamic_multi_proposal_receipt_id,
    ) as Record<string, unknown> | undefined;
    if (sameOrSubstitution(existing, proposal.record_sha256, "Dynamic Multi proposal receipt")) return true;
    this.connection.prepare(`INSERT INTO dynamic_multi_proposal_receipts_v2(
      dynamic_multi_proposal_receipt_id,goal_id,run_id,work_cell_id,plan_revision_id,plan_revision_sha256,
      authorization_id,authorization_sha256,input_closure_sha256,baseline_sha256,baseline_content_root_sha256,
      environment_sha256,runtime_fingerprint_sha256,config_sha256,graph_proposal_sha256,source_json,
      source_root_sha256,predecessor_authority_head_sha256,created_at_ms,record_sha256,created_event_sequence
    ) VALUES(${Array.from({ length: 21 }, () => "?").join(",")})`).run(
      proposal.dynamic_multi_proposal_receipt_id, proposal.goal_id, proposal.run_id, proposal.work_cell_id,
      proposal.plan_revision_id, proposal.plan_revision_sha256, proposal.authorization_id,
      proposal.authorization_sha256, proposal.input_closure_sha256, proposal.baseline_sha256,
      proposal.baseline_content_root_sha256, proposal.environment_sha256,
      proposal.runtime_fingerprint_sha256, proposal.config_sha256, proposal.graph_proposal_sha256,
      canonicalJson(proposal.source), proposal.source_root_sha256, proposal.predecessor_authority_head_sha256,
      proposal.created_at_ms, proposal.record_sha256, eventSequence,
    );
    return false;
  }

  readDynamicMultiProposal(runId: string, workCellId: string): DynamicMultiProposalReceiptV2 | null {
    if (!tableExists(this.connection, "dynamic_multi_proposal_receipts_v2")) return null;
    const row = this.connection.prepare(`SELECT * FROM dynamic_multi_proposal_receipts_v2
      WHERE run_id=? AND work_cell_id=? ORDER BY created_event_sequence DESC LIMIT 1`).get(
      runId, workCellId,
    ) as Record<string, unknown> | undefined;
    return row ? dynamicMultiProposalFromRow(row) : null;
  }

  readStrongSingleRolloutPreparation(goalId: string, runId: string): StrongSingleRolloutPreparationV1 | null {
    if (!tableExists(this.connection, "strong_single_rollout_receipts_v1")) return null;
    let preparation: ExecutionV2Preparation;
    try { preparation = this.readPreparation(goalId, runId); }
    catch { return null; }
    const row = this.connection.prepare(`SELECT h.topology_revision,h.effective_topology,
        t.record_sha256 topology_revision_sha256,t.config_sha256,t.created_at_ms topology_started_at_ms,
        a.created_at_ms started_at_ms
      FROM managed_run_heads_v1 h
      JOIN topology_revisions_v1 t ON t.run_id=h.run_id AND t.revision=h.topology_revision
      JOIN execution_authorizations_v1 a ON a.authorization_id=?
      WHERE h.run_id=?`).get(preparation.authorizationId, runId) as Record<string, unknown> | undefined;
    if (!row || row.effective_topology !== "SINGLE" || row.config_sha256 !== preparation.configSha256
      || integer(row, "topology_started_at_ms") > integer(row, "started_at_ms")) return null;
    return {
      goal_id: preparation.goalId,
      run_id: preparation.runId,
      work_cell_id: preparation.workCellId,
      plan_revision_id: preparation.planRevisionId,
      plan_revision_sha256: preparation.planRevisionSha256,
      input_closure_sha256: preparation.inputClosureSha256,
      topology_revision: integer(row, "topology_revision"),
      topology_revision_sha256: text(row, "topology_revision_sha256"),
      config_sha256: preparation.configSha256,
      authorization_id: preparation.authorizationId,
      authorization_sha256: preparation.authorizationSha256,
      baseline_sha256: preparation.baselineSha256,
      baseline_content_root_sha256: preparation.baselineContentRootSha256,
      environment_sha256: preparation.environmentSha256,
      started_at_ms: integer(row, "started_at_ms"),
    };
  }

  readStrongSingleRolloutCompletion(
    preparation: StrongSingleRolloutPreparationV1,
  ): StrongSingleRolloutCompletionV1 | null {
    if (!tableExists(this.connection, "strong_single_rollout_receipts_v1")) return null;
    const completion = this.connection.prepare(`SELECT completion_receipt_id,record_sha256,created_at_ms,
        created_event_sequence
      FROM work_cell_completion_receipts_v2
      WHERE goal_id=? AND work_cell_id=? AND authorization_id=? AND authorization_sha256=?
      ORDER BY revision DESC LIMIT 1`).get(
      preparation.goal_id, preparation.work_cell_id,
      preparation.authorization_id, preparation.authorization_sha256,
    ) as Record<string, unknown> | undefined;
    if (!completion) return null;
    const completedAtMs = integer(completion, "created_at_ms");
    const authorization = this.connection.prepare(`SELECT created_event_sequence FROM execution_authorizations_v1
      WHERE authorization_id=? AND record_sha256=?`).get(
      preparation.authorization_id, preparation.authorization_sha256,
    ) as Record<string, unknown> | undefined;
    if (!authorization) return null;
    const startedSequence = integer(authorization, "created_event_sequence");
    const completedSequence = integer(completion, "created_event_sequence");
    const interventions = this.connection.prepare(`SELECT count(*) count
      FROM active_goal_user_turn_classifications_v2 classification
      WHERE classification.goal_id=?
        AND classification.classification IN ('CORRECT_CURRENT','CHANGE_REQUEST','INTERRUPT_NOW')
        AND classification.created_event_sequence BETWEEN ? AND ?`).get(
      preparation.goal_id, startedSequence, completedSequence,
    ) as Record<string, unknown> | undefined;
    const health = this.connection.prepare(`SELECT count(*) count FROM route_health_records_v1
      WHERE goal_id=? AND work_cell_id=? AND level='H5_RECONCILE_OR_STOP'
        AND created_event_sequence BETWEEN ? AND ?`).get(
      preparation.goal_id, preparation.work_cell_id, startedSequence, completedSequence,
    ) as Record<string, unknown> | undefined;
    const unknownOperations = this.connection.prepare(`SELECT count(*) count
      FROM operation_transitions_v1 transition
      JOIN operation_attempts_v1 attempt ON attempt.attempt_id=transition.attempt_id
      WHERE attempt.goal_id=? AND attempt.work_cell_id=? AND transition.state='OUTCOME_UNKNOWN'
        AND transition.created_event_sequence BETWEEN ? AND ?`).get(
      preparation.goal_id, preparation.work_cell_id, startedSequence, completedSequence,
    ) as Record<string, unknown> | undefined;
    return {
      completion_receipt_id: text(completion, "completion_receipt_id"),
      completion_receipt_sha256: text(completion, "record_sha256"),
      completed_at_ms: completedAtMs,
      user_interventions: integer(interventions ?? {}, "count"),
      safety_events: integer(health ?? {}, "count") + integer(unknownOperations ?? {}, "count"),
    };
  }

  recordStrongSingleRollout(
    receipt: StrongSingleRolloutReceiptV1,
    eventSequence: number,
    workloadBinding?: StrongSingleWorkloadBindingV1,
  ): boolean {
    if (!tableExists(this.connection, "strong_single_rollout_receipts_v1")) {
      throw new AuthorityIntegrityError("Strong Single rollout registry migration 033 is unavailable");
    }
    assertTransaction(this.connection);
    try { assertStrongSingleRolloutReceiptV1(receipt); }
    catch (error) { throw new AuthorityIntegrityError("Strong Single rollout receipt is invalid", error); }
    const existing = this.connection.prepare(`SELECT record_sha256 FROM strong_single_rollout_receipts_v1
      WHERE rollout_receipt_id=?`).get(receipt.rollout_receipt_id) as Record<string, unknown> | undefined;
    const existed = sameOrSubstitution(existing, receipt.record_sha256, "Strong Single rollout receipt");
    if (!existed) this.connection.prepare(`INSERT INTO strong_single_rollout_receipts_v1(
      rollout_receipt_id,goal_id,run_id,work_cell_id,plan_revision_id,plan_revision_sha256,
      input_closure_sha256,runtime_fingerprint_sha256,topology_revision,topology_revision_sha256,
      config_sha256,authorization_id,authorization_sha256,baseline_sha256,baseline_content_root_sha256,
      environment_sha256,completion_receipt_id,completion_receipt_sha256,correctness,quality_basis_points,
      wall_time_ms,provider_requests,input_tokens,output_tokens,cache_read_tokens,
      provider_accounting_completeness,provider_receipt_refs_json,provider_receipt_root_sha256,
      user_interventions,safety_events,started_at_ms,completed_at_ms,record_sha256,created_event_sequence
    ) VALUES(${Array.from({ length: 34 }, () => "?").join(",")})`).run(
      receipt.rollout_receipt_id, receipt.goal_id, receipt.run_id, receipt.work_cell_id,
      receipt.plan_revision_id, receipt.plan_revision_sha256, receipt.input_closure_sha256,
      receipt.runtime_fingerprint_sha256, receipt.topology_revision, receipt.topology_revision_sha256,
      receipt.config_sha256, receipt.authorization_id, receipt.authorization_sha256,
      receipt.baseline_sha256, receipt.baseline_content_root_sha256, receipt.environment_sha256,
      receipt.completion_receipt_id, receipt.completion_receipt_sha256, receipt.correctness,
      receipt.quality_basis_points, receipt.wall_time_ms, receipt.provider_requests,
      receipt.input_tokens, receipt.output_tokens, receipt.cache_read_tokens,
      receipt.provider_accounting_completeness, canonicalJson(receipt.provider_receipt_refs),
      receipt.provider_receipt_root_sha256, receipt.user_interventions, receipt.safety_events,
      receipt.started_at_ms, receipt.completed_at_ms, receipt.record_sha256, eventSequence,
    );
    if (workloadBinding) {
      const expected = finalizeStrongSingleWorkloadBindingV1({
        source_goal_id: receipt.goal_id,
        source_run_id: receipt.run_id,
        source_work_cell_id: receipt.work_cell_id,
        source_rollout_receipt_id: receipt.rollout_receipt_id,
        source_rollout_receipt_sha256: receipt.record_sha256,
        source_topology_revision: receipt.topology_revision,
        source_topology_revision_sha256: receipt.topology_revision_sha256,
        workload: workloadBinding,
        created_at_ms: receipt.completed_at_ms,
      });
      if (expected.strong_single_workload_binding_id !== workloadBinding.strong_single_workload_binding_id
        || expected.record_sha256 !== workloadBinding.record_sha256) {
        throw new AuthorityIntegrityError("Strong Single workload binding does not match its rollout");
      }
      const existingBinding = this.connection.prepare(`SELECT record_sha256
        FROM strong_single_workload_bindings_v1 WHERE strong_single_workload_binding_id=?`).get(
        workloadBinding.strong_single_workload_binding_id,
      ) as Record<string, unknown> | undefined;
      if (!sameOrSubstitution(existingBinding, workloadBinding.record_sha256, "Strong Single workload binding")) {
        this.connection.prepare(`INSERT INTO strong_single_workload_bindings_v1(
          strong_single_workload_binding_id,source_goal_id,source_run_id,source_work_cell_id,
          source_rollout_receipt_id,source_rollout_receipt_sha256,source_topology_revision,
          source_topology_revision_sha256,work_cell_semantics_sha256,requirement_content_root_sha256,
          obligation_content_root_sha256,decision_content_root_sha256,oracle_set_sha256,scope_sha256,
          effect_policy_sha256,input_content_root_sha256,environment_sha256,runtime_fingerprint_sha256,
          comparison_config_sha256,provider_profile_sha256,cache_epoch_sha256,workload_key_sha256,
          created_at_ms,record_sha256,created_event_sequence
        ) VALUES(${Array.from({ length: 25 }, () => "?").join(",")})`).run(
          workloadBinding.strong_single_workload_binding_id, workloadBinding.source_goal_id,
          workloadBinding.source_run_id, workloadBinding.source_work_cell_id,
          workloadBinding.source_rollout_receipt_id, workloadBinding.source_rollout_receipt_sha256,
          workloadBinding.source_topology_revision, workloadBinding.source_topology_revision_sha256,
          workloadBinding.work_cell_semantics_sha256, workloadBinding.requirement_content_root_sha256,
          workloadBinding.obligation_content_root_sha256, workloadBinding.decision_content_root_sha256,
          workloadBinding.oracle_set_sha256, workloadBinding.scope_sha256,
          workloadBinding.effect_policy_sha256, workloadBinding.input_content_root_sha256,
          workloadBinding.environment_sha256, workloadBinding.runtime_fingerprint_sha256,
          workloadBinding.comparison_config_sha256, workloadBinding.provider_profile_sha256,
          workloadBinding.cache_epoch_sha256, workloadBinding.workload_key_sha256,
          workloadBinding.created_at_ms, workloadBinding.record_sha256, eventSequence,
        );
      }
    }
    return existed;
  }

  readStrongSingleRollout(lookup: StrongSingleRolloutLookupV1): StrongSingleRolloutReceiptV1 | null {
    if (!tableExists(this.connection, "strong_single_rollout_receipts_v1")) return null;
    const row = this.connection.prepare(`SELECT * FROM strong_single_rollout_receipts_v1
      WHERE goal_id=? AND run_id=? AND work_cell_id=? AND plan_revision_id=? AND plan_revision_sha256=?
        AND input_closure_sha256=? AND runtime_fingerprint_sha256=? AND config_sha256=?
        AND baseline_sha256=? AND baseline_content_root_sha256=? AND environment_sha256=?
        AND correctness='PASS' AND provider_accounting_completeness='COMPLETE'
      ORDER BY completed_at_ms DESC,rollout_receipt_id DESC LIMIT 1`).get(
      lookup.goal_id, lookup.run_id, lookup.work_cell_id, lookup.plan_revision_id,
      lookup.plan_revision_sha256, lookup.input_closure_sha256, lookup.runtime_fingerprint_sha256,
      lookup.config_sha256, lookup.baseline_sha256, lookup.baseline_content_root_sha256,
      lookup.environment_sha256,
    ) as Record<string, unknown> | undefined;
    if (!row) return null;
    try { return strongSingleRolloutFromRow(row); }
    catch (error) { throw new AuthorityIntegrityError("Strong Single rollout registry record is invalid", error); }
  }

  readStrongSingleWorkloadBindingByRollout(rolloutReceiptId: string): StrongSingleWorkloadBindingV1 | null {
    if (!tableExists(this.connection, "strong_single_workload_bindings_v1")) return null;
    const row = this.connection.prepare(`SELECT * FROM strong_single_workload_bindings_v1
      WHERE source_rollout_receipt_id=?`).get(rolloutReceiptId) as Record<string, unknown> | undefined;
    return row ? strongSingleWorkloadBindingFromRow(row) : null;
  }

  prepareWorkloadComparability(input: {
    readonly goalId: string;
    readonly runId: string;
    readonly currentWorkload: ComparableWorkloadV1;
    readonly nowMs: number;
  }): {
    readonly source: StrongSingleWorkloadBindingV1;
    readonly rollout: StrongSingleRolloutReceiptV1;
    readonly receipt: WorkloadComparabilityReceiptV1;
  } | null {
    if (!tableExists(this.connection, "workload_comparability_receipts_v1")) return null;
    const current = finalizeComparableWorkloadV1(input.currentWorkload);
    const preparation = this.readPreparation(input.goalId, input.runId);
    const recomputed = this.comparableWorkload(preparation, {
      runtimeFingerprintSha256: current.runtime_fingerprint_sha256,
      providerProfileSha256: current.provider_profile_sha256,
      cacheEpochSha256: current.cache_epoch_sha256,
    });
    if (recomputed.workload_key_sha256 !== current.workload_key_sha256) {
      throw new AuthorityIntegrityError("Current comparable workload differs from its authority closure");
    }
    const sourceRow = this.connection.prepare(`SELECT * FROM strong_single_workload_bindings_v1
      WHERE workload_key_sha256=? AND created_at_ms<=?
      ORDER BY created_at_ms DESC,source_rollout_receipt_id DESC LIMIT 1`).get(
      current.workload_key_sha256, input.nowMs,
    ) as Record<string, unknown> | undefined;
    if (!sourceRow) return null;
    const source = strongSingleWorkloadBindingFromRow(sourceRow);
    const rolloutRow = this.connection.prepare(`SELECT * FROM strong_single_rollout_receipts_v1
      WHERE rollout_receipt_id=? AND record_sha256=?`).get(
      source.source_rollout_receipt_id, source.source_rollout_receipt_sha256,
    ) as Record<string, unknown> | undefined;
    if (!rolloutRow) throw new AuthorityIntegrityError("Comparable Strong Single rollout is unavailable");
    const rollout = strongSingleRolloutFromRow(rolloutRow);
    const topologyRow = this.connection.prepare(`SELECT head.topology_revision,topology.record_sha256,
        topology.requested_topology,event.event_sha256 predecessor_authority_head_sha256
      FROM managed_run_heads_v1 head
      JOIN topology_revisions_v1 topology
        ON topology.run_id=head.run_id AND topology.revision=head.topology_revision
      JOIN managed_runs_v1 run ON run.run_id=head.run_id
      JOIN events event ON event.goal_id=run.goal_id
      WHERE head.run_id=? AND run.goal_id=? AND head.status='ACTIVE'
        AND event.sequence=(SELECT max(sequence) FROM events WHERE goal_id=run.goal_id)`).get(
      input.runId, input.goalId,
    ) as Record<string, unknown> | undefined;
    if (!topologyRow || topologyRow.requested_topology !== "MULTI") {
      throw new AuthorityIntegrityError("Workload comparison requires requested Multi authority");
    }
    const receipt = finalizeWorkloadComparabilityReceiptV1({
      target_goal_id: preparation.goalId,
      target_run_id: preparation.runId,
      target_work_cell_id: preparation.workCellId,
      target_plan_revision_id: preparation.planRevisionId,
      target_plan_revision_sha256: preparation.planRevisionSha256,
      target_topology_revision: integer(topologyRow, "topology_revision"),
      target_topology_revision_sha256: text(topologyRow, "record_sha256"),
      target_authorization_id: preparation.authorizationId,
      target_authorization_sha256: preparation.authorizationSha256,
      target_baseline_sha256: preparation.baselineSha256,
      target_input_closure_sha256: preparation.inputClosureSha256,
      source,
      current_workload: current,
      predecessor_authority_head_sha256: text(topologyRow, "predecessor_authority_head_sha256"),
      created_at_ms: input.nowMs,
    });
    return { source, rollout, receipt };
  }

  private recordWorkloadComparability(receipt: WorkloadComparabilityReceiptV1, eventSequence: number): void {
    const sourceRow = this.connection.prepare(`SELECT * FROM strong_single_workload_bindings_v1
      WHERE strong_single_workload_binding_id=? AND record_sha256=?`).get(
      receipt.source_binding_id, receipt.source_binding_sha256,
    ) as Record<string, unknown> | undefined;
    if (!sourceRow) throw new AuthorityIntegrityError("Workload comparability source binding is unavailable");
    const source = strongSingleWorkloadBindingFromRow(sourceRow);
    const workload = finalizeComparableWorkloadV1(receipt);
    const expected = finalizeWorkloadComparabilityReceiptV1({
      target_goal_id: receipt.target_goal_id,
      target_run_id: receipt.target_run_id,
      target_work_cell_id: receipt.target_work_cell_id,
      target_plan_revision_id: receipt.target_plan_revision_id,
      target_plan_revision_sha256: receipt.target_plan_revision_sha256,
      target_topology_revision: receipt.target_topology_revision,
      target_topology_revision_sha256: receipt.target_topology_revision_sha256,
      target_authorization_id: receipt.target_authorization_id,
      target_authorization_sha256: receipt.target_authorization_sha256,
      target_baseline_sha256: receipt.target_baseline_sha256,
      target_input_closure_sha256: receipt.target_input_closure_sha256,
      source,
      current_workload: workload,
      predecessor_authority_head_sha256: receipt.predecessor_authority_head_sha256,
      created_at_ms: receipt.created_at_ms,
    });
    if (expected.workload_comparability_receipt_id !== receipt.workload_comparability_receipt_id
      || expected.record_sha256 !== receipt.record_sha256) {
      throw new AuthorityIntegrityError("Workload comparability receipt integrity failed");
    }
    const existing = this.connection.prepare(`SELECT record_sha256 FROM workload_comparability_receipts_v1
      WHERE workload_comparability_receipt_id=?`).get(
      receipt.workload_comparability_receipt_id,
    ) as Record<string, unknown> | undefined;
    if (sameOrSubstitution(existing, receipt.record_sha256, "Workload comparability receipt")) return;
    this.connection.prepare(`INSERT INTO workload_comparability_receipts_v1(
      workload_comparability_receipt_id,target_goal_id,target_run_id,target_work_cell_id,
      target_plan_revision_id,target_plan_revision_sha256,target_topology_revision,target_topology_revision_sha256,
      target_authorization_id,target_authorization_sha256,target_baseline_sha256,target_input_closure_sha256,
      source_binding_id,source_binding_sha256,source_rollout_receipt_id,source_rollout_receipt_sha256,
      work_cell_semantics_sha256,requirement_content_root_sha256,obligation_content_root_sha256,
      decision_content_root_sha256,oracle_set_sha256,scope_sha256,effect_policy_sha256,input_content_root_sha256,
      environment_sha256,runtime_fingerprint_sha256,comparison_config_sha256,provider_profile_sha256,
      cache_epoch_sha256,workload_key_sha256,source_workload_key_sha256,current_workload_key_sha256,
      verdict,selection_policy,predecessor_authority_head_sha256,created_at_ms,record_sha256,created_event_sequence
    ) VALUES(${Array.from({ length: 38 }, () => "?").join(",")})`).run(
      receipt.workload_comparability_receipt_id, receipt.target_goal_id, receipt.target_run_id,
      receipt.target_work_cell_id, receipt.target_plan_revision_id, receipt.target_plan_revision_sha256,
      receipt.target_topology_revision, receipt.target_topology_revision_sha256,
      receipt.target_authorization_id, receipt.target_authorization_sha256, receipt.target_baseline_sha256,
      receipt.target_input_closure_sha256, receipt.source_binding_id, receipt.source_binding_sha256,
      receipt.source_rollout_receipt_id, receipt.source_rollout_receipt_sha256,
      receipt.work_cell_semantics_sha256, receipt.requirement_content_root_sha256,
      receipt.obligation_content_root_sha256, receipt.decision_content_root_sha256,
      receipt.oracle_set_sha256, receipt.scope_sha256, receipt.effect_policy_sha256,
      receipt.input_content_root_sha256, receipt.environment_sha256, receipt.runtime_fingerprint_sha256,
      receipt.comparison_config_sha256, receipt.provider_profile_sha256, receipt.cache_epoch_sha256,
      receipt.workload_key_sha256, receipt.source_workload_key_sha256, receipt.current_workload_key_sha256,
      receipt.verdict, receipt.selection_policy, receipt.predecessor_authority_head_sha256,
      receipt.created_at_ms, receipt.record_sha256, eventSequence,
    );
  }

  recordTopologyMeasurements(
    evidenceReceipts: readonly TopologyMeasurementEvidenceReceiptV2[],
    receipts: readonly TopologyMeasurementReceiptV2[],
    eventSequence: number,
    comparability?: WorkloadComparabilityReceiptV1,
  ): void {
    this.assertAvailable();
    assertTransaction(this.connection);
    if (evidenceReceipts.length !== 2 || receipts.length !== 2
      || new Set(evidenceReceipts.map((receipt) => receipt.kind)).size !== 2
      || new Set(receipts.map((receipt) => receipt.kind)).size !== 2) {
      throw new AuthorityIntegrityError("Topology admission requires one Strong Single and one Multi simulation measurement");
    }
    if (comparability) this.recordWorkloadComparability(comparability, eventSequence);
    const insertEvidence = this.connection.prepare(`INSERT INTO topology_measurement_evidence_receipts_v2(
      topology_measurement_evidence_receipt_id,kind,goal_id,run_id,work_cell_id,plan_revision_id,
      plan_revision_sha256,input_closure_sha256,runtime_fingerprint_sha256,config_sha256,
      baseline_sha256,baseline_content_root_sha256,environment_sha256,graph_proposal_sha256,
      derivation,source_observation_sha256,correctness,quality_basis_points,wall_time_ms,provider_requests,
      input_tokens,output_tokens,user_interventions,safety_events,predecessor_authority_head_sha256,
      observed_at_ms,record_sha256,created_event_sequence
    ) VALUES(${Array.from({ length: 28 }, () => "?").join(",")})`);
    for (const receipt of evidenceReceipts) {
      try { assertTopologyMeasurementEvidenceReceiptV2(receipt); }
      catch (error) { throw new AuthorityIntegrityError("Topology measurement source evidence is invalid", error); }
      const existing = this.connection.prepare(`SELECT record_sha256 FROM topology_measurement_evidence_receipts_v2
        WHERE topology_measurement_evidence_receipt_id=?`).get(
        receipt.topology_measurement_evidence_receipt_id,
      ) as Record<string, unknown> | undefined;
      if (sameOrSubstitution(existing, receipt.record_sha256, "Topology measurement evidence receipt")) continue;
      insertEvidence.run(
        receipt.topology_measurement_evidence_receipt_id, receipt.kind, receipt.goal_id, receipt.run_id,
        receipt.work_cell_id, receipt.plan_revision_id, receipt.plan_revision_sha256,
        receipt.input_closure_sha256, receipt.runtime_fingerprint_sha256, receipt.config_sha256,
        receipt.baseline_sha256, receipt.baseline_content_root_sha256, receipt.environment_sha256,
        receipt.graph_proposal_sha256, receipt.derivation, receipt.source_observation_sha256,
        receipt.correctness, receipt.quality_basis_points, receipt.wall_time_ms, receipt.provider_requests,
        receipt.input_tokens, receipt.output_tokens, receipt.user_interventions, receipt.safety_events,
        receipt.predecessor_authority_head_sha256, receipt.observed_at_ms, receipt.record_sha256, eventSequence,
      );
    }
    const insert = this.connection.prepare(`INSERT INTO topology_measurement_receipts_v2(
      topology_measurement_receipt_id,kind,goal_id,run_id,work_cell_id,plan_revision_id,
      plan_revision_sha256,input_closure_sha256,runtime_fingerprint_sha256,config_sha256,
      baseline_sha256,baseline_content_root_sha256,environment_sha256,graph_proposal_sha256,
      correctness,quality_basis_points,wall_time_ms,provider_requests,input_tokens,output_tokens,
      user_interventions,safety_events,source_evidence_sha256,predecessor_authority_head_sha256,
      trust,observed_at_ms,record_sha256,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const receipt of receipts) {
      try { assertTopologyMeasurementReceiptV2(receipt); }
      catch (error) { throw new AuthorityIntegrityError("Topology measurement receipt is invalid", error); }
      const existing = this.connection.prepare(`SELECT record_sha256 FROM topology_measurement_receipts_v2
        WHERE topology_measurement_receipt_id=?`).get(
        receipt.topology_measurement_receipt_id,
      ) as Record<string, unknown> | undefined;
      if (sameOrSubstitution(existing, receipt.record_sha256, "Topology measurement receipt")) continue;
      insert.run(
        receipt.topology_measurement_receipt_id, receipt.kind, receipt.goal_id, receipt.run_id,
        receipt.work_cell_id, receipt.plan_revision_id, receipt.plan_revision_sha256,
        receipt.input_closure_sha256, receipt.runtime_fingerprint_sha256, receipt.config_sha256,
        receipt.baseline_sha256, receipt.baseline_content_root_sha256, receipt.environment_sha256,
        receipt.graph_proposal_sha256, receipt.correctness, receipt.quality_basis_points,
        receipt.wall_time_ms, receipt.provider_requests, receipt.input_tokens, receipt.output_tokens,
        receipt.user_interventions, receipt.safety_events, receipt.source_evidence_sha256,
        receipt.predecessor_authority_head_sha256, receipt.trust, receipt.observed_at_ms,
        receipt.record_sha256, eventSequence,
      );
    }
  }

  readTopologyAdmissionMeasurements(
    closure: TopologyMeasurementClosureV2 & { readonly graph_proposal_sha256: string },
  ): TopologyAdmissionMeasurementsV2 | null {
    this.assertAvailable();
    const common = [
      closure.goal_id, closure.run_id, closure.work_cell_id, closure.plan_revision_id,
      closure.plan_revision_sha256, closure.input_closure_sha256, closure.runtime_fingerprint_sha256,
      closure.config_sha256, closure.baseline_sha256, closure.baseline_content_root_sha256,
      closure.environment_sha256,
    ] as const;
    const select = `SELECT * FROM topology_measurement_receipts_v2 WHERE goal_id=? AND run_id=?
      AND work_cell_id=? AND plan_revision_id=? AND plan_revision_sha256=? AND input_closure_sha256=?
      AND runtime_fingerprint_sha256=? AND config_sha256=? AND baseline_sha256=?
      AND baseline_content_root_sha256=? AND environment_sha256=? AND kind=?
      AND ((? IS NULL AND graph_proposal_sha256 IS NULL) OR graph_proposal_sha256=?)
      ORDER BY created_event_sequence DESC,topology_measurement_receipt_id DESC LIMIT 1`;
    const strongRow = this.connection.prepare(select).get(
      ...common, "STRONG_SINGLE", null, null,
    ) as Record<string, unknown> | undefined;
    const multiRow = this.connection.prepare(select).get(
      ...common, "DYNAMIC_MULTI_SIMULATION", closure.graph_proposal_sha256, closure.graph_proposal_sha256,
    ) as Record<string, unknown> | undefined;
    if (!strongRow || !multiRow) return null;
    return {
      strong_single: topologyMeasurementFromRow(strongRow),
      candidate: topologyMeasurementFromRow(multiRow),
    };
  }

  recordAdmission(
    baseline: StrongSingleBaselineV2 | null,
    candidate: DynamicMultiCandidateV2 | null,
    gate: TopologyGateReceiptV2,
    eventSequence: number,
  ): boolean {
    this.assertAvailable();
    assertTransaction(this.connection);
    if (baseline) assertStrongSingleBaselineV2(baseline);
    if (candidate) assertDynamicMultiCandidateV2(candidate);
    assertTopologyGateReceiptV2(gate, baseline, candidate);
    const topology = this.connection.prepare(`SELECT t.requested_topology,t.config_sha256,h.topology_revision
      FROM managed_run_heads_v1 h JOIN managed_runs_v1 r ON r.run_id=h.run_id
      JOIN topology_revisions_v1 t
        ON t.run_id=h.run_id AND t.revision=h.topology_revision
      WHERE h.run_id=? AND r.goal_id=?`).get(gate.run_id, gate.goal_id) as Record<string, unknown> | undefined;
    if (!topology || topology.requested_topology !== gate.requested_topology
      || topology.config_sha256 !== gate.config_sha256) {
      throw new AuthorityIntegrityError("Topology admission does not bind the current requested topology");
    }
    const measurement = (recordSha256: string, kind: TopologyMeasurementReceiptV2["kind"]) => {
      const row = this.connection.prepare(`SELECT * FROM topology_measurement_receipts_v2
        WHERE record_sha256=? AND kind=?`).get(recordSha256, kind) as Record<string, unknown> | undefined;
      if (!row || integer(row, "created_event_sequence") >= eventSequence) {
        throw new AuthorityIntegrityError("Topology admission measurement provenance is missing or not durable");
      }
      const receipt = topologyMeasurementFromRow(row);
      if (receipt.goal_id !== gate.goal_id || receipt.run_id !== gate.run_id
        || receipt.plan_revision_id !== gate.plan_revision_id
        || receipt.plan_revision_sha256 !== gate.plan_revision_sha256
        || receipt.input_closure_sha256 !== gate.input_closure_sha256
        || receipt.runtime_fingerprint_sha256 !== gate.runtime_fingerprint_sha256
        || receipt.config_sha256 !== gate.config_sha256) {
        throw new AuthorityIntegrityError("Topology admission measurement closure is stale");
      }
      const current = this.connection.prepare(`SELECT 1
        FROM managed_runs_v1 run
        JOIN work_cells_v1 cell ON cell.goal_id=run.goal_id AND cell.work_cell_id=?
        JOIN work_cell_heads_v1 cell_head ON cell_head.work_cell_id=cell.work_cell_id AND cell_head.status='RUNNING'
        JOIN execution_authorizations_v1 authorization
          ON authorization.goal_id=run.goal_id AND authorization.work_cell_id=cell.work_cell_id
          AND authorization.revoked_at_ms IS NULL
        JOIN workspace_baselines_v1 baseline ON baseline.baseline_id=authorization.baseline_id
        WHERE run.run_id=? AND run.goal_id=?
          AND baseline.record_sha256=? AND baseline.content_root_sha256=? AND baseline.environment_sha256=?
        LIMIT 1`).get(
        receipt.work_cell_id, receipt.run_id, receipt.goal_id, receipt.baseline_sha256,
        receipt.baseline_content_root_sha256, receipt.environment_sha256,
      );
      if (!current) throw new AuthorityIntegrityError("Topology admission measurement WorkCell or baseline is stale");
      return receipt;
    };
    if (baseline) {
      const receipt = measurement(baseline.evidence_sha256, "STRONG_SINGLE");
      if (receipt.graph_proposal_sha256 !== null || receipt.correctness !== baseline.correctness
        || receipt.quality_basis_points !== baseline.quality_basis_points
        || receipt.wall_time_ms !== baseline.wall_time_ms
        || receipt.provider_requests !== baseline.provider_requests
        || receipt.input_tokens !== baseline.input_tokens || receipt.output_tokens !== baseline.output_tokens
        || receipt.user_interventions !== baseline.user_interventions
        || receipt.safety_events !== baseline.safety_events || receipt.observed_at_ms !== baseline.observed_at_ms) {
        throw new AuthorityIntegrityError("Strong Single baseline differs from its durable measurement");
      }
    }
    if (candidate) {
      const receipt = measurement(candidate.simulator_receipt_sha256, "DYNAMIC_MULTI_SIMULATION");
      if (receipt.correctness !== "PASS" || receipt.graph_proposal_sha256 !== candidate.graph_sha256
        || receipt.quality_basis_points !== candidate.estimated_quality_basis_points
        || receipt.wall_time_ms !== candidate.estimated_wall_time_ms
        || receipt.provider_requests !== candidate.estimated_provider_requests
        || receipt.input_tokens !== candidate.estimated_input_tokens
        || receipt.output_tokens !== candidate.estimated_output_tokens
        || receipt.user_interventions !== candidate.estimated_user_interventions
        || receipt.safety_events !== candidate.estimated_safety_events
        || receipt.observed_at_ms !== candidate.estimated_at_ms) {
        throw new AuthorityIntegrityError("Dynamic Multi candidate differs from its durable measurement");
      }
    }
    const existing = this.connection.prepare(
      "SELECT record_sha256 FROM topology_gate_receipts_v2 WHERE topology_gate_receipt_id=?",
    ).get(gate.topology_gate_receipt_id) as Record<string, unknown> | undefined;
    if (sameOrSubstitution(existing, gate.record_sha256, "Topology Gate V2")) return true;
    if (baseline) this.connection.prepare(`INSERT INTO strong_single_baselines_v2(
      strong_single_baseline_id,goal_id,plan_revision_id,plan_revision_sha256,input_closure_sha256,
      runtime_fingerprint_sha256,correctness,quality_basis_points,wall_time_ms,provider_requests,
      input_tokens,output_tokens,user_interventions,safety_events,evidence_sha256,observed_at_ms,
      record_sha256,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      baseline.strong_single_baseline_id, baseline.goal_id, baseline.plan_revision_id,
      baseline.plan_revision_sha256, baseline.input_closure_sha256, baseline.runtime_fingerprint_sha256,
      baseline.correctness, baseline.quality_basis_points, baseline.wall_time_ms, baseline.provider_requests,
      baseline.input_tokens, baseline.output_tokens, baseline.user_interventions, baseline.safety_events,
      baseline.evidence_sha256, baseline.observed_at_ms, baseline.record_sha256, eventSequence,
    );
    if (candidate) this.connection.prepare(`INSERT INTO dynamic_multi_candidates_v2(
      multi_candidate_id,goal_id,plan_revision_id,plan_revision_sha256,input_closure_sha256,
      runtime_fingerprint_sha256,graph_sha256,total_node_count,independent_node_count,
      cross_partition_dependency_count,write_scope_conflict_count,task_packets_complete,
      independent_validation,estimated_quality_basis_points,estimated_wall_time_ms,
      estimated_provider_requests,estimated_input_tokens,estimated_output_tokens,
      estimated_user_interventions,estimated_safety_events,simulator_receipt_sha256,
      estimated_at_ms,record_sha256,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      candidate.multi_candidate_id, candidate.goal_id, candidate.plan_revision_id,
      candidate.plan_revision_sha256, candidate.input_closure_sha256, candidate.runtime_fingerprint_sha256,
      candidate.graph_sha256, candidate.total_node_count, candidate.independent_node_count,
      candidate.cross_partition_dependency_count, candidate.write_scope_conflict_count,
      candidate.task_packets_complete ? 1 : 0, candidate.independent_validation ? 1 : 0,
      candidate.estimated_quality_basis_points, candidate.estimated_wall_time_ms,
      candidate.estimated_provider_requests, candidate.estimated_input_tokens,
      candidate.estimated_output_tokens, candidate.estimated_user_interventions,
      candidate.estimated_safety_events, candidate.simulator_receipt_sha256,
      candidate.estimated_at_ms, candidate.record_sha256, eventSequence,
    );
    this.connection.prepare(`INSERT INTO topology_gate_receipts_v2(
      topology_gate_receipt_id,goal_id,run_id,requested_topology,effective_topology,verdict,reason_code,
      plan_revision_id,plan_revision_sha256,input_closure_sha256,runtime_fingerprint_sha256,config_sha256,
      strong_single_baseline_id,strong_single_baseline_sha256,multi_candidate_id,multi_candidate_sha256,
      predecessor_authority_head_sha256,record_sha256,created_at_ms,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      gate.topology_gate_receipt_id, gate.goal_id, gate.run_id, gate.requested_topology,
      gate.effective_topology, gate.verdict, gate.reason_code, gate.plan_revision_id,
      gate.plan_revision_sha256, gate.input_closure_sha256, gate.runtime_fingerprint_sha256,
      gate.config_sha256, gate.strong_single_baseline_id, gate.strong_single_baseline_sha256,
      gate.multi_candidate_id, gate.multi_candidate_sha256, gate.predecessor_authority_head_sha256,
      gate.record_sha256, gate.created_at_ms, eventSequence,
    );
    return false;
  }

  commitGraph(graph: ExecutionGraphRevisionV2, eventSequence: number): boolean {
    this.assertAvailable();
    assertTransaction(this.connection);
    try { assertExecutionGraphRecordV2(graph); assertExecutionGraphSemanticsV2(graph); }
    catch (error) { throw new AuthorityIntegrityError("Execution graph is invalid", error); }
    const preparation = this.readPreparation(graph.goal_id, graph.run_id);
    const obligationIds = new Set(preparation.workCellObligationIds);
    const requirementIds = new Set(preparation.workCellRequirementIds);
    const decisionRefs = new Map(preparation.workCellDecisionRefs.map((ref) => [ref.decision_id, ref.sha256]));
    const coveredObligations = new Set<string>();
    const coveredRequirements = new Set<string>();
    const allowedReadRoots = [...preparation.workCellReadRoots, ...preparation.workCellWriteRoots];
    for (const node of graph.nodes) {
      if (node.obligation_ids.some((id) => !obligationIds.has(id))
        || node.requirement_ids.some((id) => !requirementIds.has(id))
        || node.decision_refs.length !== decisionRefs.size
        || node.decision_refs.some((ref) => decisionRefs.get(ref.decision_id) !== ref.sha256)
        || node.oracle_sha256 !== preparation.workCellOracleSha256
        || node.read_roots.some((root) => !allowedReadRoots.some((allowed) => scopeContains(allowed, root)))
        || node.write_roots.some((root) => !preparation.workCellWriteRoots.some((allowed) => scopeContains(allowed, root)))
        || node.exact_input_refs.some((ref) => !node.read_roots.some((root) => scopeContains(root, ref.path)))
        || (node.effect_ceiling === "PATCH_PROPOSAL" && node.write_roots.length === 0)) {
        throw new AuthorityIntegrityError("Execution graph node exceeds the current WorkCell authority");
      }
      for (const obligationId of node.obligation_ids) coveredObligations.add(obligationId);
      for (const requirementId of node.requirement_ids) coveredRequirements.add(requirementId);
    }
    if (graph.work_cell_id !== preparation.workCellId || graph.plan_revision_id !== preparation.planRevisionId
      || graph.plan_revision_sha256 !== preparation.planRevisionSha256
      || graph.authorization_id !== preparation.authorizationId
      || graph.authorization_sha256 !== preparation.authorizationSha256
      || graph.baseline_sha256 !== preparation.baselineSha256
      || graph.baseline_content_root_sha256 !== preparation.baselineContentRootSha256
      || graph.environment_sha256 !== preparation.environmentSha256
      || graph.input_closure_sha256 !== preparation.inputClosureSha256
      || graph.oracle_set_sha256 !== preparation.oracleSetSha256
      || graph.config_sha256 !== preparation.configSha256
      || coveredObligations.size !== obligationIds.size
      || [...obligationIds].some((id) => !coveredObligations.has(id))
      || coveredRequirements.size !== requirementIds.size
      || [...requirementIds].some((id) => !coveredRequirements.has(id))) {
      throw new AuthorityIntegrityError("Execution graph does not cover the current WorkCell authority closure");
    }
    const existing = this.connection.prepare(
      "SELECT record_sha256 FROM execution_graph_revisions_v2 WHERE execution_graph_revision_id=?",
    ).get(graph.execution_graph_revision_id) as Record<string, unknown> | undefined;
    if (sameOrSubstitution(existing, graph.record_sha256, "Execution graph")) return true;
    const current = this.connection.prepare(
      "SELECT execution_graph_revision_id,status FROM execution_graph_heads_v2 WHERE run_id=?",
    ).get(graph.run_id) as Record<string, unknown> | undefined;
    if (current && current.status === "RUNNING") throw new AuthorityIntegrityError("ManagedRun already has a running Execution V2 graph");
    this.connection.prepare(`INSERT INTO execution_graph_revisions_v2(
      execution_graph_revision_id,goal_id,run_id,work_cell_id,plan_revision_id,plan_revision_sha256,
      topology_gate_receipt_id,topology_gate_receipt_sha256,authorization_id,authorization_sha256,
      baseline_sha256,baseline_content_root_sha256,environment_sha256,input_closure_sha256,oracle_set_sha256,config_sha256,
      runtime_fingerprint_sha256,predecessor_authority_head_sha256,graph_revision,stop_generation,
      node_root_sha256,edge_root_sha256,graph_sha256,record_sha256,created_at_ms,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      graph.execution_graph_revision_id, graph.goal_id, graph.run_id, graph.work_cell_id,
      graph.plan_revision_id, graph.plan_revision_sha256, graph.topology_gate_receipt_id,
      graph.topology_gate_receipt_sha256, graph.authorization_id, graph.authorization_sha256,
      graph.baseline_sha256, graph.baseline_content_root_sha256, graph.environment_sha256, graph.input_closure_sha256,
      graph.oracle_set_sha256, graph.config_sha256, graph.runtime_fingerprint_sha256,
      graph.predecessor_authority_head_sha256, graph.graph_revision, graph.stop_generation,
      graph.node_root_sha256, graph.edge_root_sha256, graph.graph_sha256, graph.record_sha256,
      graph.created_at_ms, eventSequence,
    );
    const insertNode = this.connection.prepare(`INSERT INTO execution_nodes_v2(
      execution_graph_revision_id,node_id,logical_key,task_text,capabilities_json,effect_ceiling,
      requirement_ids_json,obligation_ids_json,read_roots_json,write_roots_json,exact_input_refs_json,
      decision_refs_json,provider_call_plan_id,provider_call_plan_sha256,input_closure_sha256,
      output_schema_sha256,oracle_sha256,provider_profile_sha256,privacy_class,taint_classes_json,
      max_turns,max_tool_calls,max_input_tokens,max_output_tokens,max_retries,no_progress_limit,
      deadline_ms,record_sha256,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insertNodeHead = this.connection.prepare(`INSERT INTO execution_node_heads_v2(
      execution_graph_revision_id,node_id,status,attempt_count,stop_generation,latest_packet_id,
      latest_packet_sha256,latest_proposal_id,latest_proposal_sha256,latest_host_receipt_id,
      latest_host_receipt_sha256,updated_event_sequence
    ) VALUES(?,?,'READY',0,?,NULL,NULL,NULL,NULL,NULL,NULL,?)`);
    for (const node of graph.nodes) {
      insertNode.run(
        graph.execution_graph_revision_id, node.node_id, node.logical_key, node.task, canonicalJson(node.capabilities),
        node.effect_ceiling, canonicalJson(node.requirement_ids), canonicalJson(node.obligation_ids),
        canonicalJson(node.read_roots), canonicalJson(node.write_roots), canonicalJson(node.exact_input_refs),
        canonicalJson(node.decision_refs), node.provider_call_plan_id, node.provider_call_plan_sha256,
        node.input_closure_sha256,
        node.output_schema_sha256, node.oracle_sha256, node.provider_profile_sha256, node.privacy_class,
        canonicalJson(node.taint_classes), node.max_turns, node.max_tool_calls, node.max_input_tokens,
        node.max_output_tokens, node.max_retries, node.no_progress_limit, node.deadline_ms,
        node.record_sha256, eventSequence,
      );
      insertNodeHead.run(graph.execution_graph_revision_id, node.node_id, graph.stop_generation, eventSequence);
    }
    const insertEdge = this.connection.prepare(`INSERT INTO execution_edges_v2(
      execution_graph_revision_id,from_node_id,to_node_id,condition,record_sha256,created_event_sequence
    ) VALUES(?,?,?,?,?,?)`);
    for (const edge of graph.edges) insertEdge.run(
      graph.execution_graph_revision_id, edge.from_node_id, edge.to_node_id,
      edge.condition, edge.record_sha256, eventSequence,
    );
    this.connection.prepare(`INSERT INTO execution_graph_heads_v2(
      run_id,goal_id,work_cell_id,execution_graph_revision_id,execution_graph_revision_sha256,
      graph_revision,stop_generation,status,current_postimage_root_sha256,updated_event_sequence
    ) VALUES(?,?,?,?,?,?,?,'RUNNING',?,?)
    ON CONFLICT(run_id) DO UPDATE SET goal_id=excluded.goal_id,work_cell_id=excluded.work_cell_id,
      execution_graph_revision_id=excluded.execution_graph_revision_id,
      execution_graph_revision_sha256=excluded.execution_graph_revision_sha256,
      graph_revision=excluded.graph_revision,stop_generation=excluded.stop_generation,status='RUNNING',
      current_postimage_root_sha256=excluded.current_postimage_root_sha256,
      terminal_receipt_id=NULL,terminal_receipt_sha256=NULL,
      updated_event_sequence=excluded.updated_event_sequence`).run(
      graph.run_id, graph.goal_id, graph.work_cell_id, graph.execution_graph_revision_id,
      graph.record_sha256, graph.graph_revision, graph.stop_generation, graph.baseline_content_root_sha256, eventSequence,
    );
    this.connection.prepare(`INSERT INTO execution_integration_heads_v2(
      run_id,integration_attempt_id,latest_transition_sha256,state,current_postimage_root_sha256,
      lease_generation,fencing_token,updated_event_sequence
    ) VALUES(?,NULL,NULL,'IDLE',?,0,0,?)
    ON CONFLICT(run_id) DO UPDATE SET integration_attempt_id=NULL,latest_transition_sha256=NULL,
      state='IDLE',current_postimage_root_sha256=excluded.current_postimage_root_sha256,
      updated_event_sequence=excluded.updated_event_sequence`).run(
      graph.run_id, graph.baseline_content_root_sha256, eventSequence,
    );
    return false;
  }

  leaseNode(packet: TaskPacketV2, lease: ExecutionNodeLeaseV2, eventSequence: number, nowMs: number): boolean {
    this.assertAvailable();
    assertTransaction(this.connection);
    try { assertTaskPacketRecordV2(packet); assertExecutionNodeLeaseV2(lease); }
    catch (error) { throw new AuthorityIntegrityError("Execution node dispatch is invalid", error); }
    if (lease.goal_id !== packet.goal_id || lease.run_id !== packet.run_id
      || lease.graph_revision_id !== packet.graph_revision_id || lease.graph_revision_sha256 !== packet.graph_revision_sha256
      || lease.node_id !== packet.node_id || lease.node_spec_sha256 !== packet.node_spec_sha256
      || lease.packet_id !== packet.packet_id || lease.packet_sha256 !== packet.packet_sha256
      || lease.generation !== packet.lease_generation || lease.fencing_token !== packet.fencing_token
      || lease.stop_generation !== packet.stop_generation || lease.expires_at_ms <= nowMs) {
      throw new AuthorityIntegrityError("Execution node lease does not bind TaskPacket V2");
    }
    const existing = this.connection.prepare("SELECT record_sha256 FROM execution_node_leases_v2 WHERE execution_node_lease_id=?")
      .get(lease.execution_node_lease_id) as Record<string, unknown> | undefined;
    if (sameOrSubstitution(existing, lease.record_sha256, "Execution node lease")) return true;
    const frontier = this.connection.prepare(`SELECT gh.status graph_status,nh.status node_status,
        nh.attempt_count,nh.stop_generation,COALESCE(lh.generation,0) prior_generation,
        COALESCE(lh.fencing_token,0) prior_fencing_token
      FROM execution_graph_heads_v2 gh
      JOIN execution_node_heads_v2 nh ON nh.execution_graph_revision_id=gh.execution_graph_revision_id
        AND nh.node_id=?
      LEFT JOIN execution_node_lease_heads_v2 lh ON lh.execution_graph_revision_id=nh.execution_graph_revision_id
        AND lh.node_id=nh.node_id
      WHERE gh.run_id=? AND gh.execution_graph_revision_id=? AND gh.execution_graph_revision_sha256=?`).get(
      packet.node_id, packet.run_id, packet.graph_revision_id, packet.graph_revision_sha256,
    ) as Record<string, unknown> | undefined;
    if (!frontier || frontier.graph_status !== "RUNNING" || frontier.node_status !== "READY"
      || packet.attempt !== integer(frontier, "attempt_count") + 1
      || packet.lease_generation !== integer(frontier, "prior_generation") + 1
      || packet.fencing_token !== integer(frontier, "prior_fencing_token") + 1
      || packet.stop_generation !== integer(frontier, "stop_generation")) {
      throw new AuthorityIntegrityError("Execution node dispatch generation is stale or non-contiguous");
    }
    this.connection.prepare(`INSERT INTO task_packets_v2(
      packet_id,goal_id,run_id,work_cell_id,execution_graph_revision_id,execution_graph_revision_sha256,
      node_id,node_spec_sha256,task_text,requirement_ids_json,obligation_ids_json,output_schema_sha256,
      oracle_sha256,provider_profile_sha256,plan_revision_sha256,topology_gate_receipt_sha256,authorization_sha256,
      baseline_sha256,baseline_content_root_sha256,environment_sha256,input_closure_sha256,oracle_set_sha256,config_sha256,
      runtime_fingerprint_sha256,attempt,lease_generation,fencing_token,stop_generation,capabilities_json,
      effect_ceiling,read_roots_json,write_roots_json,privacy_class,taint_classes_json,max_turns,
      max_tool_calls,max_input_tokens,max_output_tokens,max_retries,no_progress_limit,exact_input_refs_json,
      decision_refs_json,provider_call_plan_id,provider_call_plan_sha256,deadline_ms,created_at_ms,
      packet_sha256,capability_hmac,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      packet.packet_id, packet.goal_id, packet.run_id, packet.work_cell_id, packet.graph_revision_id,
      packet.graph_revision_sha256, packet.node_id, packet.node_spec_sha256, packet.task,
      canonicalJson(packet.requirement_ids), canonicalJson(packet.obligation_ids), packet.output_schema_sha256,
      packet.oracle_sha256, packet.provider_profile_sha256, packet.plan_revision_sha256,
      packet.topology_gate_receipt_sha256, packet.authorization_sha256, packet.baseline_sha256,
      packet.baseline_content_root_sha256, packet.environment_sha256, packet.input_closure_sha256,
      packet.oracle_set_sha256, packet.config_sha256,
      packet.runtime_fingerprint_sha256, packet.attempt, packet.lease_generation, packet.fencing_token,
      packet.stop_generation, canonicalJson(packet.capabilities), packet.effect_ceiling,
      canonicalJson(packet.read_roots), canonicalJson(packet.write_roots), packet.privacy_class,
      canonicalJson(packet.taint_classes), packet.max_turns, packet.max_tool_calls, packet.max_input_tokens,
      packet.max_output_tokens, packet.max_retries, packet.no_progress_limit,
      canonicalJson(packet.exact_input_refs), canonicalJson(packet.decision_refs), packet.provider_call_plan_id,
      packet.provider_call_plan_sha256, packet.deadline_ms, packet.created_at_ms, packet.packet_sha256,
      packet.capability_hmac, eventSequence,
    );
    this.connection.prepare(`INSERT INTO execution_node_leases_v2(
      execution_node_lease_id,goal_id,run_id,execution_graph_revision_id,execution_graph_revision_sha256,
      node_id,node_spec_sha256,packet_id,packet_sha256,generation,fencing_token,stop_generation,
      owner_hmac,expires_at_ms,created_at_ms,record_sha256,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      lease.execution_node_lease_id, lease.goal_id, lease.run_id, lease.graph_revision_id,
      lease.graph_revision_sha256, lease.node_id, lease.node_spec_sha256, lease.packet_id,
      lease.packet_sha256, lease.generation, lease.fencing_token, lease.stop_generation,
      lease.owner_hmac, lease.expires_at_ms, lease.created_at_ms, lease.record_sha256, eventSequence,
    );
    this.connection.prepare(`INSERT INTO execution_node_lease_heads_v2(
      execution_graph_revision_id,node_id,execution_node_lease_id,execution_node_lease_sha256,
      generation,fencing_token,stop_generation,owner_hmac,expires_at_ms,updated_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(execution_graph_revision_id,node_id) DO UPDATE SET
      execution_node_lease_id=excluded.execution_node_lease_id,
      execution_node_lease_sha256=excluded.execution_node_lease_sha256,
      generation=excluded.generation,fencing_token=excluded.fencing_token,
      stop_generation=excluded.stop_generation,owner_hmac=excluded.owner_hmac,
      expires_at_ms=excluded.expires_at_ms,updated_event_sequence=excluded.updated_event_sequence`).run(
      lease.graph_revision_id, lease.node_id, lease.execution_node_lease_id, lease.record_sha256,
      lease.generation, lease.fencing_token, lease.stop_generation, lease.owner_hmac,
      lease.expires_at_ms, eventSequence,
    );
    const updated = this.connection.prepare(`UPDATE execution_node_heads_v2 SET status='LEASED',
      attempt_count=attempt_count+1,latest_packet_id=?,latest_packet_sha256=?,updated_event_sequence=?
      WHERE execution_graph_revision_id=? AND node_id=? AND status='READY' AND stop_generation=?`).run(
      packet.packet_id, packet.packet_sha256, eventSequence, packet.graph_revision_id,
      packet.node_id, packet.stop_generation,
    );
    if (Number(updated.changes) !== 1) throw new AuthorityIntegrityError("Execution node is not ready for dispatch");
    return false;
  }

  recordAttemptOutcome(outcome: ExecutionNodeAttemptOutcomeV2, eventSequence: number): boolean {
    this.assertAvailable();
    assertTransaction(this.connection);
    try { assertExecutionNodeAttemptOutcomeV2(outcome); }
    catch (error) { throw new AuthorityIntegrityError("Execution node attempt outcome is invalid", error); }
    const existing = this.connection.prepare(
      "SELECT record_sha256 FROM execution_node_attempt_outcomes_v2 WHERE execution_node_attempt_outcome_id=?",
    ).get(outcome.execution_node_attempt_outcome_id) as Record<string, unknown> | undefined;
    if (sameOrSubstitution(existing, outcome.record_sha256, "Execution node attempt outcome")) return true;
    const current = this.connection.prepare(`SELECT gh.status graph_status,gh.execution_graph_revision_sha256,
      n.record_sha256 node_sha256,n.max_retries,nh.status node_status,nh.attempt_count,
      nh.latest_packet_id,nh.latest_packet_sha256,nh.stop_generation node_stop_generation,
      lh.execution_node_lease_id,lh.execution_node_lease_sha256,lh.generation,lh.fencing_token,
      lh.stop_generation lease_stop_generation,lh.expires_at_ms,p.attempt,p.packet_sha256
      FROM execution_graph_heads_v2 gh
      JOIN execution_nodes_v2 n ON n.execution_graph_revision_id=gh.execution_graph_revision_id AND n.node_id=?
      JOIN execution_node_heads_v2 nh ON nh.execution_graph_revision_id=n.execution_graph_revision_id AND nh.node_id=n.node_id
      JOIN execution_node_lease_heads_v2 lh ON lh.execution_graph_revision_id=n.execution_graph_revision_id AND lh.node_id=n.node_id
      JOIN execution_node_leases_v2 l ON l.execution_node_lease_id=lh.execution_node_lease_id
      JOIN task_packets_v2 p ON p.packet_id=l.packet_id
      WHERE gh.run_id=? AND gh.goal_id=? AND gh.execution_graph_revision_id=?`).get(
      outcome.node_id, outcome.run_id, outcome.goal_id, outcome.graph_revision_id,
    ) as Record<string, unknown> | undefined;
    if (!current || current.graph_status !== "RUNNING"
      || !["LEASED", "PROPOSAL_SUBMITTED"].includes(String(current.node_status))
      || current.execution_graph_revision_sha256 !== outcome.graph_revision_sha256
      || current.node_sha256 !== outcome.node_spec_sha256
      || current.latest_packet_id !== outcome.packet_id
      || current.latest_packet_sha256 !== outcome.packet_sha256
      || current.execution_node_lease_id !== outcome.execution_node_lease_id
      || current.execution_node_lease_sha256 !== outcome.execution_node_lease_sha256
      || integer(current, "attempt") !== outcome.attempt
      || integer(current, "attempt_count") !== outcome.attempt
      || integer(current, "generation") !== outcome.lease_generation
      || integer(current, "fencing_token") !== outcome.fencing_token
      || integer(current, "lease_stop_generation") !== outcome.stop_generation
      || integer(current, "node_stop_generation") !== outcome.stop_generation
      || current.packet_sha256 !== outcome.packet_sha256) {
      throw new AuthorityIntegrityError("Execution node attempt outcome is fenced by current authority");
    }
    if (outcome.basis === "LEASE_EXPIRED" && outcome.created_at_ms < integer(current, "expires_at_ms")) {
      throw new AuthorityIntegrityError("Execution node lease has not expired");
    }
    if (outcome.disposition === "REQUEUED" && outcome.attempt > integer(current, "max_retries")) {
      throw new AuthorityIntegrityError("Execution node retry budget is exhausted");
    }
    this.connection.prepare(`INSERT INTO execution_node_attempt_outcomes_v2(
      execution_node_attempt_outcome_id,goal_id,run_id,execution_graph_revision_id,
      execution_graph_revision_sha256,node_id,node_spec_sha256,packet_id,packet_sha256,
      execution_node_lease_id,execution_node_lease_sha256,attempt,lease_generation,fencing_token,
      stop_generation,basis,disposition,reason_code,failure_sha256,predecessor_authority_head_sha256,
      trust,created_at_ms,record_sha256,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      outcome.execution_node_attempt_outcome_id, outcome.goal_id, outcome.run_id,
      outcome.graph_revision_id, outcome.graph_revision_sha256, outcome.node_id,
      outcome.node_spec_sha256, outcome.packet_id, outcome.packet_sha256,
      outcome.execution_node_lease_id, outcome.execution_node_lease_sha256, outcome.attempt,
      outcome.lease_generation, outcome.fencing_token, outcome.stop_generation,
      outcome.basis, outcome.disposition, outcome.reason_code, outcome.failure_sha256,
      outcome.predecessor_authority_head_sha256, outcome.trust, outcome.created_at_ms,
      outcome.record_sha256, eventSequence,
    );
    const next = outcome.disposition === "REQUEUED" ? "READY" : "FAILED";
    const updated = this.connection.prepare(`UPDATE execution_node_heads_v2 SET status=?,updated_event_sequence=?
      WHERE execution_graph_revision_id=? AND node_id=? AND status IN ('LEASED','PROPOSAL_SUBMITTED')
        AND latest_packet_id=? AND latest_packet_sha256=?`).run(
      next, eventSequence, outcome.graph_revision_id, outcome.node_id, outcome.packet_id, outcome.packet_sha256,
    );
    if (Number(updated.changes) !== 1) throw new AuthorityIntegrityError("Execution node attempt outcome lost its current node authority");
    return false;
  }

  submitProposal(
    proposal: WorkerProposalV2,
    patchSet: WorkerPatchSetV2 | null,
    artifacts: readonly ArtifactMetadata[],
    eventSequence: number,
    nowMs: number,
  ): boolean {
    this.assertAvailable();
    assertTransaction(this.connection);
    try { assertWorkerProposalV2(proposal); }
    catch (error) { throw new AuthorityIntegrityError("Worker proposal is invalid", error); }
    if ((proposal.kind === "PATCH_PROPOSAL") !== (patchSet !== null)) {
      throw new AuthorityIntegrityError("Worker PatchSet must accompany exactly one Patch proposal");
    }
    if (patchSet === null && artifacts.length !== 0) {
      throw new AuthorityIntegrityError("Patchless Worker proposal cannot register PatchSet artifacts");
    }
    if (patchSet !== null) {
      const packetRow = this.connection.prepare("SELECT * FROM task_packets_v2 WHERE packet_id=?")
        .get(proposal.packet_id) as Record<string, unknown> | undefined;
      if (!packetRow) throw new AuthorityIntegrityError("Worker PatchSet TaskPacket is missing");
      try { assertWorkerPatchSetV2(patchSet, taskPacketFromRow(packetRow)); }
      catch (error) { throw new AuthorityIntegrityError("Worker PatchSet is invalid", error); }
      const payload = proposal.payload as {
        readonly patch_set_id: string;
        readonly patch_set_sha256: string;
        readonly affected_paths: readonly string[];
        readonly preimage_root_sha256: string;
        readonly proposed_postimage_root_sha256: string;
      };
      if (patchSet.goal_id !== proposal.goal_id || patchSet.run_id !== proposal.run_id
        || patchSet.graph_revision_id !== proposal.graph_revision_id
        || patchSet.graph_revision_sha256 !== proposal.graph_revision_sha256
        || patchSet.node_id !== proposal.node_id || patchSet.packet_id !== proposal.packet_id
        || patchSet.packet_sha256 !== proposal.packet_sha256
        || patchSet.patch_set_id !== payload.patch_set_id || patchSet.record_sha256 !== payload.patch_set_sha256
        || patchSet.baseline_sha256 !== payload.preimage_root_sha256
        || patchSet.proposed_postimage_root_sha256 !== payload.proposed_postimage_root_sha256
        || !sameJson(patchSet.affected_paths, payload.affected_paths)) {
        throw new AuthorityIntegrityError("Worker PatchSet does not bind its normalized proposal");
      }
      const expectedArtifacts = patchSet.entries.filter((entry) => entry.after_sha256 !== null);
      const expectedArtifactHashes = new Set(expectedArtifacts.map((entry) => entry.after_sha256));
      if (artifacts.length !== expectedArtifactHashes.size
        || new Set(artifacts.map((artifact) => artifact.sha256)).size !== artifacts.length) {
        throw new AuthorityIntegrityError("Worker PatchSet artifact closure is incomplete");
      }
      for (const entry of expectedArtifacts) {
        const artifact = artifacts.find((candidate) => candidate.sha256 === entry.after_sha256);
        if (!artifact || artifact.byteLength !== entry.byte_length || artifact.classification === "SECRET") {
          throw new AuthorityIntegrityError(`Worker PatchSet artifact differs at ${entry.path}`);
        }
      }
    }
    const existing = this.connection.prepare("SELECT record_sha256 FROM worker_proposals_v2 WHERE proposal_id=?")
      .get(proposal.proposal_id) as Record<string, unknown> | undefined;
    if (sameOrSubstitution(existing, proposal.record_sha256, "Worker proposal")) {
      if (patchSet !== null) {
        const closure = this.readWorkerPatchSetClosure(patchSet.patch_set_id);
        if (!closure || closure.patchSet.record_sha256 !== patchSet.record_sha256
          || closure.proposalId !== proposal.proposal_id
          || artifacts.some((artifact) => !closure.artifacts.some((member) =>
            member.artifact.artifactId === artifact.artifactId
            && member.artifact.sha256 === artifact.sha256
            && member.artifact.byteLength === artifact.byteLength))) {
          throw new AuthorityIntegrityError("Idempotent Worker proposal lacks its durable PatchSet closure");
        }
      }
      return true;
    }
    const current = this.connection.prepare(`SELECT lh.generation,lh.fencing_token,lh.stop_generation,lh.expires_at_ms,
      nh.status,nh.latest_packet_id,nh.latest_packet_sha256,g.authorization_sha256,a.revoked_at_ms
      FROM execution_node_lease_heads_v2 lh
      JOIN execution_node_heads_v2 nh ON nh.execution_graph_revision_id=lh.execution_graph_revision_id AND nh.node_id=lh.node_id
      JOIN execution_graph_revisions_v2 g ON g.execution_graph_revision_id=lh.execution_graph_revision_id
      JOIN execution_authorizations_v1 a ON a.authorization_id=g.authorization_id
      WHERE lh.execution_graph_revision_id=? AND lh.node_id=?`).get(
      proposal.graph_revision_id, proposal.node_id,
    ) as Record<string, unknown> | undefined;
    if (!current || current.status !== "LEASED" || current.latest_packet_id !== proposal.packet_id
      || current.latest_packet_sha256 !== proposal.packet_sha256
      || integer(current, "generation") !== proposal.lease_generation
      || integer(current, "fencing_token") !== proposal.fencing_token
      || integer(current, "stop_generation") !== proposal.stop_generation
      || integer(current, "expires_at_ms") <= nowMs || current.revoked_at_ms !== null) {
      throw new AuthorityIntegrityError("Worker proposal is fenced by current execution authority");
    }
    this.connection.prepare(`INSERT INTO worker_proposals_v2(
      proposal_id,goal_id,run_id,execution_graph_revision_id,execution_graph_revision_sha256,node_id,
      packet_id,packet_sha256,lease_generation,fencing_token,stop_generation,kind,payload_json,
      trust,created_at_ms,record_sha256,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      proposal.proposal_id, proposal.goal_id, proposal.run_id, proposal.graph_revision_id,
      proposal.graph_revision_sha256, proposal.node_id, proposal.packet_id, proposal.packet_sha256,
      proposal.lease_generation, proposal.fencing_token, proposal.stop_generation, proposal.kind,
      canonicalJson(proposal.payload), proposal.trust, proposal.created_at_ms, proposal.record_sha256,
      eventSequence,
    );
    if (patchSet !== null) {
      for (const artifact of artifacts) registerArtifact(this.connection, artifact, nowMs);
      this.connection.prepare(`INSERT INTO worker_patch_sets_v2(
        patch_set_id,goal_id,run_id,execution_graph_revision_id,execution_graph_revision_sha256,
        node_id,node_spec_sha256,packet_id,packet_sha256,proposal_id,proposal_sha256,baseline_sha256,
        affected_paths_json,entries_json,proposed_postimage_root_sha256,created_at_ms,record_sha256,
        created_event_sequence
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        patchSet.patch_set_id, patchSet.goal_id, patchSet.run_id, patchSet.graph_revision_id,
        patchSet.graph_revision_sha256, patchSet.node_id, patchSet.node_spec_sha256,
        patchSet.packet_id, patchSet.packet_sha256, proposal.proposal_id, proposal.record_sha256,
        patchSet.baseline_sha256, canonicalJson(patchSet.affected_paths), canonicalJson(patchSet.entries),
        patchSet.proposed_postimage_root_sha256, patchSet.created_at_ms, patchSet.record_sha256,
        eventSequence,
      );
      const insertArtifact = this.connection.prepare(`INSERT INTO worker_patch_set_artifacts_v2(
        patch_set_id,path,artifact_id,artifact_sha256,byte_length,created_event_sequence
      ) VALUES(?,?,?,?,?,?)`);
      for (const entry of patchSet.entries) {
        if (entry.after_sha256 === null) continue;
        const artifact = artifacts.find((candidate) => candidate.sha256 === entry.after_sha256)!;
        insertArtifact.run(
          patchSet.patch_set_id, entry.path, artifact.artifactId, artifact.sha256,
          artifact.byteLength, eventSequence,
        );
      }
    }
    this.connection.prepare(`UPDATE execution_node_heads_v2 SET status='PROPOSAL_SUBMITTED',
      latest_proposal_id=?,latest_proposal_sha256=?,updated_event_sequence=?
      WHERE execution_graph_revision_id=? AND node_id=? AND status='LEASED'`).run(
      proposal.proposal_id, proposal.record_sha256, eventSequence, proposal.graph_revision_id, proposal.node_id,
    );
    return false;
  }

  recordHostOracleReceipt(receipt: HostOracleReceiptV2, eventSequence: number, nowMs: number): boolean {
    this.assertAvailable();
    assertTransaction(this.connection);
    const graph = this.readGraph(receipt.graph_revision_id);
    if (!graph) throw new AuthorityIntegrityError("Host OracleReceipt graph is missing");
    this.assertCurrentReceiptAuthority(graph, receipt.node_id, receipt.stop_generation, nowMs);
    try { assertHostOracleReceiptV2(receipt, graph); }
    catch (error) { throw new AuthorityIntegrityError("Host OracleReceipt is invalid", error); }
    const existing = this.connection.prepare(
      "SELECT record_sha256 FROM host_oracle_receipts_v2 WHERE host_oracle_receipt_id=?",
    ).get(receipt.host_oracle_receipt_id) as Record<string, unknown> | undefined;
    if (sameOrSubstitution(existing, receipt.record_sha256, "Host OracleReceipt")) return true;
    const current = this.connection.prepare(`SELECT h.status,h.latest_proposal_id,h.latest_proposal_sha256,
        p.packet_sha256,w.record_sha256 proposal_sha256,gh.current_postimage_root_sha256
      FROM execution_node_heads_v2 h
      JOIN execution_graph_heads_v2 gh
        ON gh.execution_graph_revision_id=h.execution_graph_revision_id AND gh.run_id=?
      JOIN task_packets_v2 p ON p.packet_id=?
      JOIN worker_proposals_v2 w ON w.proposal_id=?
      WHERE h.execution_graph_revision_id=? AND h.node_id=?`).get(
      receipt.run_id, receipt.packet_id, receipt.proposal_id, receipt.graph_revision_id, receipt.node_id,
    ) as Record<string, unknown> | undefined;
    if (!current || !["EVIDENCE_ACCEPTED", "PATCH_INTEGRATED", "ORACLE_PASSED"].includes(text(current, "status"))
      || text(current, "latest_proposal_id") !== receipt.proposal_id
      || text(current, "latest_proposal_sha256") !== receipt.proposal_sha256
      || text(current, "packet_sha256") !== receipt.packet_sha256
      || text(current, "proposal_sha256") !== receipt.proposal_sha256
      || text(current, "current_postimage_root_sha256") !== receipt.postimage_root_sha256) {
      if (current && text(current, "current_postimage_root_sha256") !== receipt.postimage_root_sha256) {
        throw new AuthorityIntegrityError("Host OracleReceipt does not bind the current postimage");
      }
      throw new AuthorityIntegrityError("Host OracleReceipt lacks the current accepted node proposal");
    }
    for (const evidence of receipt.validation_evidence) {
      const row = this.connection.prepare(`SELECT p.record_sha256 pass_sha256,p.goal_id,p.work_cell_id,
          p.evidence_requirement_id,p.attempt_id,p.terminal_transition_id,p.terminal_transition_sha256,
          p.authorization_sha256,p.postimage_root_sha256,p.environment_sha256,
          a.record_sha256 attempt_sha256,a.operation_kind,a.oracle_sha256,
          t.transition_sha256,t.state,t.postcondition,o.task_obligation_id
        FROM oracle_pass_receipts_v2 p
        JOIN operation_attempts_v1 a ON a.attempt_id=p.attempt_id
        JOIN operation_transitions_v1 t ON t.transition_id=p.terminal_transition_id AND t.attempt_id=a.attempt_id
        JOIN evidence_requirements_v2 r ON r.evidence_requirement_id=p.evidence_requirement_id
        JOIN facet_obligation_bindings_v2 b ON b.binding_id=r.binding_id
        JOIN acceptance_obligations_v2 o ON o.acceptance_obligation_id=b.acceptance_obligation_id
        WHERE p.pass_receipt_id=?`).get(evidence.oracle_pass_receipt_id) as Record<string, unknown> | undefined;
      if (!row || text(row, "pass_sha256") !== evidence.oracle_pass_receipt_sha256
        || text(row, "goal_id") !== receipt.goal_id || text(row, "work_cell_id") !== graph.work_cell_id
        || text(row, "evidence_requirement_id") !== evidence.evidence_requirement_id
        || text(row, "attempt_id") !== evidence.operation_attempt_id
        || text(row, "attempt_sha256") !== evidence.operation_attempt_sha256
        || text(row, "terminal_transition_id") !== evidence.terminal_transition_id
        || text(row, "terminal_transition_sha256") !== evidence.terminal_transition_sha256
        || text(row, "transition_sha256") !== evidence.terminal_transition_sha256
        || text(row, "authorization_sha256") !== graph.authorization_sha256
        || text(row, "postimage_root_sha256") !== receipt.postimage_root_sha256
        || text(row, "environment_sha256") !== receipt.environment_sha256
        || text(row, "operation_kind") !== "VALIDATION" || text(row, "oracle_sha256") !== receipt.oracle_sha256
        || !["COMMITTED", "RECONCILED"].includes(text(row, "state")) || text(row, "postcondition") !== "PASS"
        || text(row, "task_obligation_id") !== evidence.obligation_id) {
        throw new AuthorityIntegrityError("Host OracleReceipt evidence is not a real frozen Host validation PASS");
      }
    }
    this.connection.prepare(`INSERT INTO host_oracle_receipts_v2(
      host_oracle_receipt_id,goal_id,run_id,execution_graph_revision_id,execution_graph_revision_sha256,
      node_id,node_spec_sha256,packet_id,packet_sha256,proposal_id,proposal_sha256,oracle_sha256,
      oracle_set_sha256,postimage_root_sha256,environment_sha256,covered_obligation_ids_json,
      validation_evidence_root_sha256,result,freshness,stop_generation,predecessor_authority_head_sha256,
      trust,created_at_ms,record_sha256,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      receipt.host_oracle_receipt_id, receipt.goal_id, receipt.run_id, receipt.graph_revision_id,
      receipt.graph_revision_sha256, receipt.node_id, receipt.node_spec_sha256, receipt.packet_id,
      receipt.packet_sha256, receipt.proposal_id, receipt.proposal_sha256, receipt.oracle_sha256,
      receipt.oracle_set_sha256, receipt.postimage_root_sha256, receipt.environment_sha256,
      canonicalJson(receipt.covered_obligation_ids), receipt.validation_evidence_root_sha256,
      receipt.result, receipt.freshness, receipt.stop_generation, receipt.predecessor_authority_head_sha256,
      receipt.trust, receipt.created_at_ms, receipt.record_sha256, eventSequence,
    );
    const insertEvidence = this.connection.prepare(`INSERT INTO host_oracle_evidence_members_v2(
      host_oracle_receipt_id,ordinal,obligation_id,oracle_pass_receipt_id,oracle_pass_receipt_sha256,
      evidence_requirement_id,operation_attempt_id,operation_attempt_sha256,terminal_transition_id,
      terminal_transition_sha256,record_sha256,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
    receipt.validation_evidence.forEach((evidence, ordinal) => insertEvidence.run(
      receipt.host_oracle_receipt_id, ordinal, evidence.obligation_id, evidence.oracle_pass_receipt_id,
      evidence.oracle_pass_receipt_sha256, evidence.evidence_requirement_id, evidence.operation_attempt_id,
      evidence.operation_attempt_sha256, evidence.terminal_transition_id, evidence.terminal_transition_sha256,
      evidence.record_sha256, eventSequence,
    ));
    return false;
  }

  recordHostReceipt(receipt: HostNodeReceiptV2, eventSequence: number, nowMs: number): boolean {
    this.assertAvailable();
    assertTransaction(this.connection);
    const graph = this.readGraph(receipt.graph_revision_id);
    if (!graph) throw new AuthorityIntegrityError("Host receipt graph is missing");
    this.assertCurrentReceiptAuthority(graph, receipt.node_id, receipt.stop_generation, nowMs);
    try { assertHostNodeReceiptV2(receipt, graph); }
    catch (error) { throw new AuthorityIntegrityError("Host node receipt is invalid", error); }
    const existing = this.connection.prepare("SELECT record_sha256 FROM host_node_receipts_v2 WHERE host_node_receipt_id=?")
      .get(receipt.host_node_receipt_id) as Record<string, unknown> | undefined;
    if (sameOrSubstitution(existing, receipt.record_sha256, "Host node receipt")) return true;
    const proposal = this.connection.prepare(`SELECT kind,record_sha256 FROM worker_proposals_v2
      WHERE proposal_id=? AND execution_graph_revision_id=? AND node_id=? AND packet_id=?`).get(
      receipt.proposal_id, receipt.graph_revision_id, receipt.node_id, receipt.packet_id,
    ) as Record<string, unknown> | undefined;
    if (!proposal || proposal.record_sha256 !== receipt.proposal_sha256) {
      throw new AuthorityIntegrityError("Host receipt does not bind the Worker proposal");
    }
    if (receipt.kind === "EVIDENCE_ACCEPTED" && proposal.kind !== "EVIDENCE_PROPOSAL") {
      throw new AuthorityIntegrityError("Evidence acceptance requires an evidence proposal");
    }
    if (receipt.kind === "PATCH_INTEGRATED") {
      if (proposal.kind !== "PATCH_PROPOSAL") throw new AuthorityIntegrityError("Patch integration requires a patch proposal");
      const integration = this.connection.prepare(`SELECT h.state,a.expected_preimage_root_sha256,
        t.postimage_root_sha256
        FROM execution_integration_heads_v2 h
        JOIN execution_integration_attempts_v2 a ON a.integration_attempt_id=h.integration_attempt_id
        JOIN execution_integration_transitions_v2 t
          ON t.integration_attempt_id=a.integration_attempt_id AND t.record_sha256=h.latest_transition_sha256
        WHERE h.run_id=? AND a.proposal_id=? AND a.proposal_sha256=?`).get(
        receipt.run_id, receipt.proposal_id, receipt.proposal_sha256,
      ) as Record<string, unknown> | undefined;
      if (!integration || integration.state !== "COMMITTED"
        || integration.expected_preimage_root_sha256 !== receipt.preimage_root_sha256
        || integration.postimage_root_sha256 !== receipt.postimage_root_sha256) {
        throw new AuthorityIntegrityError("Patch integration lacks a committed serial integration receipt");
      }
    }
    if (receipt.kind === "ORACLE_PASSED") {
      const oracle = this.connection.prepare(`SELECT goal_id,run_id,execution_graph_revision_id,node_id,
          packet_id,packet_sha256,proposal_id,proposal_sha256,result,freshness,stop_generation,record_sha256
        FROM host_oracle_receipts_v2 WHERE record_sha256=?`).get(
        receipt.evidence_sha256,
      ) as Record<string, unknown> | undefined;
      if (!oracle || text(oracle, "goal_id") !== receipt.goal_id || text(oracle, "run_id") !== receipt.run_id
        || text(oracle, "execution_graph_revision_id") !== receipt.graph_revision_id
        || text(oracle, "node_id") !== receipt.node_id || text(oracle, "packet_id") !== receipt.packet_id
        || text(oracle, "packet_sha256") !== receipt.packet_sha256
        || text(oracle, "proposal_id") !== receipt.proposal_id
        || text(oracle, "proposal_sha256") !== receipt.proposal_sha256
        || text(oracle, "result") !== "PASS" || text(oracle, "freshness") !== "CURRENT"
        || integer(oracle, "stop_generation") !== receipt.stop_generation) {
        throw new AuthorityIntegrityError("Host OracleReceipt V2 is required before ORACLE_PASSED");
      }
      const prior = this.connection.prepare(`SELECT count(*) count FROM host_node_receipts_v2
        WHERE execution_graph_revision_id=? AND node_id=? AND proposal_id=?
          AND kind IN ('EVIDENCE_ACCEPTED','PATCH_INTEGRATED')`).get(
        receipt.graph_revision_id, receipt.node_id, receipt.proposal_id,
      ) as Record<string, unknown> | undefined;
      if (integer(prior ?? {}, "count") !== 1) throw new AuthorityIntegrityError("Fresh oracle lacks an accepted predecessor receipt");
    }
    this.connection.prepare(`INSERT INTO host_node_receipts_v2(
      host_node_receipt_id,goal_id,run_id,execution_graph_revision_id,execution_graph_revision_sha256,
      node_id,node_spec_sha256,packet_id,packet_sha256,proposal_id,proposal_sha256,kind,evidence_sha256,
      preimage_root_sha256,postimage_root_sha256,stop_generation,
      predecessor_authority_head_sha256,trust,created_at_ms,record_sha256,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      receipt.host_node_receipt_id, receipt.goal_id, receipt.run_id, receipt.graph_revision_id,
      receipt.graph_revision_sha256, receipt.node_id, receipt.node_spec_sha256, receipt.packet_id,
      receipt.packet_sha256, receipt.proposal_id, receipt.proposal_sha256, receipt.kind,
      receipt.evidence_sha256, receipt.preimage_root_sha256, receipt.postimage_root_sha256,
      receipt.stop_generation, receipt.predecessor_authority_head_sha256,
      receipt.trust, receipt.created_at_ms, receipt.record_sha256, eventSequence,
    );
    const status: Record<HostNodeReceiptKindV2, string> = {
      EVIDENCE_ACCEPTED: "EVIDENCE_ACCEPTED",
      PATCH_INTEGRATED: "PATCH_INTEGRATED",
      ORACLE_PASSED: "ORACLE_PASSED",
      NODE_REJECTED: "REJECTED",
    };
    const predecessorStatuses = receipt.kind === "ORACLE_PASSED"
      ? ["EVIDENCE_ACCEPTED", "PATCH_INTEGRATED", "ORACLE_PASSED"]
      : ["PROPOSAL_SUBMITTED"];
    const updated = this.connection.prepare(`UPDATE execution_node_heads_v2 SET status=?,latest_host_receipt_id=?,
      latest_host_receipt_sha256=?,updated_event_sequence=?
      WHERE execution_graph_revision_id=? AND node_id=? AND latest_proposal_id=?
        AND latest_proposal_sha256=? AND status IN (${predecessorStatuses.map(() => "?").join(",")})`).run(
      status[receipt.kind], receipt.host_node_receipt_id, receipt.record_sha256, eventSequence,
      receipt.graph_revision_id, receipt.node_id, receipt.proposal_id, receipt.proposal_sha256,
      ...predecessorStatuses,
    );
    if (Number(updated.changes) !== 1) throw new AuthorityIntegrityError("Host receipt lost its current node authority");
    return false;
  }

  stopExecution(stop: ExecutionStopV2, eventSequence: number): boolean {
    this.assertAvailable();
    assertTransaction(this.connection);
    try { assertExecutionStopV2(stop); }
    catch (error) { throw new AuthorityIntegrityError("Execution stop is invalid", error); }
    const existing = this.connection.prepare("SELECT record_sha256 FROM execution_stops_v2 WHERE execution_stop_id=?")
      .get(stop.execution_stop_id) as Record<string, unknown> | undefined;
    if (sameOrSubstitution(existing, stop.record_sha256, "Execution stop")) return true;
    const graphHead = this.connection.prepare(`SELECT status,stop_generation FROM execution_graph_heads_v2
      WHERE run_id=? AND execution_graph_revision_id=? AND execution_graph_revision_sha256=?`).get(
      stop.run_id, stop.graph_revision_id, stop.graph_revision_sha256,
    ) as Record<string, unknown> | undefined;
    if (!graphHead || graphHead.status !== "RUNNING"
      || integer(graphHead, "stop_generation") + 1 !== stop.stop_generation) {
      throw new AuthorityIntegrityError("Execution stop directive sequence is stale");
    }
    if (stop.scope === "PARTIAL_INVALIDATION") {
      const activeIntegration = this.connection.prepare(`SELECT a.node_id FROM execution_integration_heads_v2 h
        JOIN execution_integration_attempts_v2 a ON a.integration_attempt_id=h.integration_attempt_id
        WHERE h.run_id=? AND h.state IN ('PREPARED','OBSERVED')`).get(stop.run_id) as Record<string, unknown> | undefined;
      if (activeIntegration && stop.affected_node_ids.includes(text(activeIntegration, "node_id"))) {
        throw new AuthorityIntegrityError("Affected integration must reconcile before partial invalidation");
      }
    }
    this.connection.prepare(`INSERT INTO execution_stops_v2(
      execution_stop_id,goal_id,run_id,execution_graph_revision_id,execution_graph_revision_sha256,
      stop_generation,scope,reason,affected_node_root_sha256,predecessor_authority_head_sha256,
      created_at_ms,record_sha256,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      stop.execution_stop_id, stop.goal_id, stop.run_id, stop.graph_revision_id,
      stop.graph_revision_sha256, stop.stop_generation, stop.scope, stop.reason, stop.affected_node_root_sha256,
      stop.predecessor_authority_head_sha256, stop.created_at_ms, stop.record_sha256, eventSequence,
    );
    const insertMember = this.connection.prepare(`INSERT INTO execution_stop_node_members_v2(
      execution_stop_id,execution_graph_revision_id,node_id,ordinal,created_event_sequence
    ) VALUES(?,?,?,?,?)`);
    stop.affected_node_ids.forEach((nodeId, ordinal) => insertMember.run(
      stop.execution_stop_id, stop.graph_revision_id, nodeId, ordinal, eventSequence,
    ));
    const graphStatus = stop.scope === "GRAPH_STOP" ? "STOPPED" : "RUNNING";
    const graphUpdated = this.connection.prepare(`UPDATE execution_graph_heads_v2 SET status=?,stop_generation=?,updated_event_sequence=?
      WHERE run_id=? AND execution_graph_revision_id=? AND status='RUNNING'`).run(
      graphStatus, stop.stop_generation, eventSequence, stop.run_id, stop.graph_revision_id,
    );
    if (Number(graphUpdated.changes) !== 1) throw new AuthorityIntegrityError("Execution stop lost graph authority");
    const preserveSuccess = stop.scope === "GRAPH_STOP";
    const nodeStatus = preserveSuccess ? "STOPPED" : "INVALIDATED";
    const updateNode = this.connection.prepare(`UPDATE execution_node_heads_v2 SET
      status=CASE WHEN ?=1 AND status='ORACLE_PASSED' THEN status ELSE ? END,
      stop_generation=?,
      latest_packet_id=CASE WHEN ?=1 AND status='ORACLE_PASSED' THEN latest_packet_id ELSE NULL END,
      latest_packet_sha256=CASE WHEN ?=1 AND status='ORACLE_PASSED' THEN latest_packet_sha256 ELSE NULL END,
      latest_proposal_id=CASE WHEN ?=1 AND status='ORACLE_PASSED' THEN latest_proposal_id ELSE NULL END,
      latest_proposal_sha256=CASE WHEN ?=1 AND status='ORACLE_PASSED' THEN latest_proposal_sha256 ELSE NULL END,
      latest_host_receipt_id=CASE WHEN ?=1 AND status='ORACLE_PASSED' THEN latest_host_receipt_id ELSE NULL END,
      latest_host_receipt_sha256=CASE WHEN ?=1 AND status='ORACLE_PASSED' THEN latest_host_receipt_sha256 ELSE NULL END,
      updated_event_sequence=? WHERE execution_graph_revision_id=? AND node_id=?`);
    for (const nodeId of stop.affected_node_ids) {
      const preserve = preserveSuccess ? 1 : 0;
      const updated = updateNode.run(
        preserve, nodeStatus, stop.stop_generation,
        preserve, preserve, preserve, preserve, preserve, preserve,
        eventSequence, stop.graph_revision_id, nodeId,
      );
      if (Number(updated.changes) !== 1) throw new AuthorityIntegrityError("Execution stop member lost node authority");
    }
    return false;
  }

  readGraphTerminalPreparation(runId: string): ExecutionGraphTerminalPreparationV2 {
    this.assertAvailable();
    const head = this.connection.prepare("SELECT * FROM execution_graph_heads_v2 WHERE run_id=?")
      .get(runId) as Record<string, unknown> | undefined;
    if (!head || !["RUNNING", "STOPPED"].includes(text(head, "status"))) {
      throw new AuthorityIntegrityError("Execution graph is not eligible for a terminal receipt");
    }
    const graph = this.readGraph(text(head, "execution_graph_revision_id"));
    if (!graph || graph.record_sha256 !== text(head, "execution_graph_revision_sha256")) {
      throw new AuthorityIntegrityError("Execution graph terminal preparation is stale");
    }
    const integration = this.connection.prepare("SELECT * FROM execution_integration_heads_v2 WHERE run_id=?")
      .get(runId) as Record<string, unknown> | undefined;
    if (!integration || ["PREPARED", "OBSERVED"].includes(text(integration, "state"))) {
      throw new AuthorityIntegrityError("Execution integration is unresolved");
    }
    const unresolvedOperations = this.connection.prepare(`SELECT count(*) count FROM operation_heads_v1
      WHERE goal_id=? AND work_cell_id=? AND state IN ('PREPARED','DISPATCHED','OBSERVED','OUTCOME_UNKNOWN')`).get(
      graph.goal_id, graph.work_cell_id,
    ) as Record<string, unknown> | undefined;
    if (integer(unresolvedOperations ?? {}, "count") !== 0) {
      throw new AuthorityIntegrityError("Execution graph has unresolved Host operations");
    }
    const latestIntegrationTransitionSha256 = nullableText(integration, "latest_transition_sha256");
    const integrationSequence = latestIntegrationTransitionSha256 === null ? 0 : integer(
      (this.connection.prepare(`SELECT created_event_sequence FROM execution_integration_transitions_v2
        WHERE record_sha256=?`).get(latestIntegrationTransitionSha256) as Record<string, unknown> | undefined) ?? {},
      "created_event_sequence",
    );
    const nodeRows = this.connection.prepare(`SELECT * FROM execution_node_heads_v2
      WHERE execution_graph_revision_id=? ORDER BY node_id`).all(
      graph.execution_graph_revision_id,
    ) as Record<string, unknown>[];
    const success = new Set(["ORACLE_PASSED"]);
    const failure = new Set(["REJECTED", "STOPPED", "FAILED"]);
    const nodeFrontier = nodeRows.map((row) => {
      const nodeId = text(row, "node_id");
      const status = text(row, "status");
      let evidenceSha256: string;
      if (success.has(status) || status === "REJECTED") {
        evidenceSha256 = text(row, "latest_host_receipt_sha256");
        if (status === "ORACLE_PASSED") {
          const oracle = this.connection.prepare(`SELECT o.postimage_root_sha256,o.created_event_sequence
            FROM host_node_receipts_v2 r
            JOIN host_oracle_receipts_v2 o ON o.record_sha256=r.evidence_sha256
            WHERE r.host_node_receipt_id=? AND r.kind='ORACLE_PASSED'`).get(
            text(row, "latest_host_receipt_id"),
          ) as Record<string, unknown> | undefined;
          if (!oracle || text(oracle, "postimage_root_sha256") !== text(head, "current_postimage_root_sha256")
            || integer(oracle, "created_event_sequence") <= integrationSequence) {
            throw new AuthorityIntegrityError(`Execution node ${nodeId} lacks a fresh current-postimage oracle`);
          }
        }
      } else if (status === "FAILED") {
        const outcome = this.connection.prepare(`SELECT record_sha256 FROM execution_node_attempt_outcomes_v2
          WHERE execution_graph_revision_id=? AND node_id=? AND disposition IN ('FAILED','FENCED')
          ORDER BY created_event_sequence DESC LIMIT 1`).get(
          graph.execution_graph_revision_id, nodeId,
        ) as Record<string, unknown> | undefined;
        if (!outcome) throw new AuthorityIntegrityError("Failed execution node lacks a terminal outcome");
        evidenceSha256 = text(outcome, "record_sha256");
      } else if (status === "STOPPED") {
        const stopped = this.connection.prepare(`SELECT s.record_sha256 FROM execution_stops_v2 s
          JOIN execution_stop_node_members_v2 m ON m.execution_stop_id=s.execution_stop_id
          WHERE s.execution_graph_revision_id=? AND m.node_id=? AND s.scope='GRAPH_STOP'
          ORDER BY s.stop_generation DESC LIMIT 1`).get(
          graph.execution_graph_revision_id, nodeId,
        ) as Record<string, unknown> | undefined;
        if (!stopped) throw new AuthorityIntegrityError("Stopped execution node lacks a graph stop receipt");
        evidenceSha256 = text(stopped, "record_sha256");
      } else {
        throw new AuthorityIntegrityError(`Execution node ${nodeId} is not terminal`);
      }
      return {
        node_id: nodeId,
        status: status as ExecutionGraphTerminalNodeV2["status"],
        evidence_sha256: evidenceSha256,
      };
    });
    const terminalStatus = nodeFrontier.every((member) => success.has(member.status)) ? "CLOSED" as const : "FAILED" as const;
    if (terminalStatus === "FAILED" && nodeFrontier.every((member) => !failure.has(member.status))) {
      throw new AuthorityIntegrityError("Execution graph has no authoritative terminal failure");
    }
    const failureEvidence = terminalStatus === "FAILED"
      ? nodeFrontier.find((member) => failure.has(member.status))!.evidence_sha256
      : null;
    const event = this.connection.prepare("SELECT event_sha256 FROM events WHERE goal_id=? ORDER BY sequence DESC LIMIT 1")
      .get(graph.goal_id) as Record<string, unknown> | undefined;
    if (!event) throw new AuthorityIntegrityError("Execution graph terminal predecessor is missing");
    return {
      graph,
      terminalStatus,
      currentPostimageRootSha256: text(head, "current_postimage_root_sha256"),
      integrationFrontierSha256: integrationFrontierSha256(integration),
      nodeFrontier,
      failureEvidenceSha256: failureEvidence,
      predecessorAuthorityHeadSha256: text(event, "event_sha256"),
    };
  }

  recordGraphTerminal(receipt: ExecutionGraphTerminalReceiptV2, eventSequence: number): boolean {
    this.assertAvailable();
    assertTransaction(this.connection);
    const graph = this.readGraph(receipt.graph_revision_id);
    if (!graph) throw new AuthorityIntegrityError("Execution graph terminal receipt graph is missing");
    try { assertExecutionGraphTerminalReceiptV2(receipt, graph); }
    catch (error) { throw new AuthorityIntegrityError("Execution graph terminal receipt is invalid", error); }
    const existing = this.connection.prepare(`SELECT record_sha256 FROM execution_graph_terminal_receipts_v2
      WHERE execution_graph_terminal_receipt_id=?`).get(
      receipt.execution_graph_terminal_receipt_id,
    ) as Record<string, unknown> | undefined;
    if (sameOrSubstitution(existing, receipt.record_sha256, "Execution graph terminal receipt")) return true;
    const current = this.readGraphTerminalPreparation(receipt.run_id);
    if (current.graph.record_sha256 !== receipt.graph_revision_sha256
      || current.terminalStatus !== receipt.terminal_status
      || current.currentPostimageRootSha256 !== receipt.current_postimage_root_sha256
      || current.integrationFrontierSha256 !== receipt.integration_frontier_sha256
      || current.failureEvidenceSha256 !== receipt.failure_evidence_sha256
      || current.predecessorAuthorityHeadSha256 !== receipt.predecessor_authority_head_sha256
      || !sameJson(current.nodeFrontier, receipt.node_frontier.map(
        ({ schema_version, record_sha256, ...member }) => {
          void schema_version;
          void record_sha256;
          return member;
        },
      ))) {
      throw new AuthorityIntegrityError("Execution graph terminal receipt is stale");
    }
    this.connection.prepare(`INSERT INTO execution_graph_terminal_receipts_v2(
      execution_graph_terminal_receipt_id,goal_id,run_id,execution_graph_revision_id,
      execution_graph_revision_sha256,terminal_status,reason_code,current_postimage_root_sha256,
      integration_frontier_sha256,node_frontier_root_sha256,failure_evidence_sha256,
      predecessor_authority_head_sha256,trust,created_at_ms,record_sha256,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      receipt.execution_graph_terminal_receipt_id, receipt.goal_id, receipt.run_id,
      receipt.graph_revision_id, receipt.graph_revision_sha256, receipt.terminal_status,
      receipt.reason_code, receipt.current_postimage_root_sha256, receipt.integration_frontier_sha256,
      receipt.node_frontier_root_sha256, receipt.failure_evidence_sha256,
      receipt.predecessor_authority_head_sha256, receipt.trust, receipt.created_at_ms,
      receipt.record_sha256, eventSequence,
    );
    const insertMember = this.connection.prepare(`INSERT INTO execution_graph_terminal_node_members_v2(
      execution_graph_terminal_receipt_id,execution_graph_revision_id,node_id,ordinal,status,
      evidence_sha256,record_sha256,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?)`);
    receipt.node_frontier.forEach((member, ordinal) => insertMember.run(
      receipt.execution_graph_terminal_receipt_id, receipt.graph_revision_id, member.node_id,
      ordinal, member.status, member.evidence_sha256, member.record_sha256, eventSequence,
    ));
    const updated = this.connection.prepare(`UPDATE execution_graph_heads_v2 SET status=?,terminal_receipt_id=?,
      terminal_receipt_sha256=?,updated_event_sequence=? WHERE run_id=? AND execution_graph_revision_id=?
      AND status IN ('RUNNING','STOPPED') AND current_postimage_root_sha256=?`).run(
      receipt.terminal_status, receipt.execution_graph_terminal_receipt_id, receipt.record_sha256,
      eventSequence, receipt.run_id, receipt.graph_revision_id, receipt.current_postimage_root_sha256,
    );
    if (Number(updated.changes) !== 1) throw new AuthorityIntegrityError("Execution graph terminal CAS was lost");
    return false;
  }

  prepareIntegration(
    attempt: ExecutionIntegrationAttemptV2,
    prepared: ExecutionIntegrationTransitionV2,
    journal: ExecutionIntegrationJournalV2,
    eventSequence: number,
    nowMs: number,
  ): boolean {
    this.assertAvailable();
    assertTransaction(this.connection);
    try {
      assertExecutionIntegrationAttemptV2(attempt);
      assertExecutionIntegrationTransitionV2(prepared);
      assertExecutionIntegrationJournalV2(journal);
    }
    catch (error) { throw new AuthorityIntegrityError("Execution integration preparation is invalid", error); }
    if (prepared.integration_attempt_id !== attempt.integration_attempt_id || prepared.ordinal !== 0
      || prepared.state !== "PREPARED" || prepared.predecessor_transition_sha256 !== null
      || prepared.postimage_root_sha256 !== null
      || prepared.failure_sha256 !== null || prepared.created_at_ms !== attempt.created_at_ms
      || attempt.expires_at_ms <= nowMs || journal.integration_attempt_id !== attempt.integration_attempt_id) {
      throw new AuthorityIntegrityError("Execution integration PREPARED binding is invalid");
    }
    const existing = this.connection.prepare(`SELECT a.record_sha256,j.record_sha256 journal_record_sha256
      FROM execution_integration_attempts_v2 a
      LEFT JOIN execution_integration_journals_v2 j ON j.integration_attempt_id=a.integration_attempt_id
      WHERE a.integration_attempt_id=?`)
      .get(attempt.integration_attempt_id) as Record<string, unknown> | undefined;
    if (sameOrSubstitution(existing, attempt.record_sha256, "Execution integration attempt")) {
      if (existing?.journal_record_sha256 !== journal.record_sha256) {
        throw new AuthorityIntegrityError("Idempotent execution integration attempt lacks its journal closure");
      }
      return true;
    }
    const current = this.connection.prepare(`SELECT h.state,h.current_postimage_root_sha256,h.lease_generation,h.fencing_token,
      gh.goal_id,gh.work_cell_id,gh.execution_graph_revision_id,gh.execution_graph_revision_sha256,
      gh.stop_generation,gh.status graph_status,
      g.record_sha256 graph_sha256,g.authorization_sha256,a.revoked_at_ms,a.expires_at_ms authorization_expires_at_ms,
      n.record_sha256 node_sha256,p.goal_id proposal_goal_id,p.run_id proposal_run_id,
      p.execution_graph_revision_id proposal_graph_id,p.node_id proposal_node_id,
      p.kind proposal_kind,p.record_sha256 proposal_sha256,p.payload_json,nh.status node_status,
      ps.patch_set_id durable_patch_set_id,ps.record_sha256 durable_patch_set_sha256,
      ps.baseline_sha256 durable_patch_set_baseline_sha256,ps.entries_json durable_patch_set_entries_json
      FROM execution_integration_heads_v2 h
      JOIN execution_graph_heads_v2 gh ON gh.run_id=h.run_id
      JOIN execution_graph_revisions_v2 g ON g.execution_graph_revision_id=gh.execution_graph_revision_id
      JOIN execution_authorizations_v1 a ON a.authorization_id=g.authorization_id
      JOIN execution_nodes_v2 n ON n.execution_graph_revision_id=g.execution_graph_revision_id AND n.node_id=?
      JOIN execution_node_heads_v2 nh ON nh.execution_graph_revision_id=n.execution_graph_revision_id AND nh.node_id=n.node_id
      JOIN worker_proposals_v2 p ON p.proposal_id=? AND p.execution_graph_revision_id=g.execution_graph_revision_id
        AND p.node_id=n.node_id
      JOIN worker_patch_sets_v2 ps ON ps.proposal_id=p.proposal_id AND ps.patch_set_id=?
      WHERE h.run_id=? AND g.execution_graph_revision_id=?`).get(
      attempt.node_id, attempt.proposal_id, attempt.patch_set_id, attempt.run_id, attempt.graph_revision_id,
    ) as Record<string, unknown> | undefined;
    const patch = current ? json<WorkerProposalV2["payload"]>(current, "payload_json") : null;
    if (!current || !["IDLE", "COMMITTED", "REJECTED", "FENCED"].includes(String(current.state))
      || current.graph_status !== "RUNNING" || current.goal_id !== attempt.goal_id
      || current.execution_graph_revision_id !== attempt.graph_revision_id
      || current.execution_graph_revision_sha256 !== attempt.graph_revision_sha256
      || current.current_postimage_root_sha256 !== attempt.expected_preimage_root_sha256
      || current.graph_sha256 !== attempt.graph_revision_sha256
      || current.node_sha256 !== attempt.node_spec_sha256 || current.proposal_kind !== "PATCH_PROPOSAL"
      || current.proposal_sha256 !== attempt.proposal_sha256 || current.node_status !== "PROPOSAL_SUBMITTED"
      || current.proposal_goal_id !== attempt.goal_id || current.proposal_run_id !== attempt.run_id
      || current.proposal_graph_id !== attempt.graph_revision_id || current.proposal_node_id !== attempt.node_id
      || current.authorization_sha256 !== attempt.authorization_sha256 || current.revoked_at_ms !== null
      || integer(current, "authorization_expires_at_ms") <= nowMs
      || !patch || !("patch_set_id" in patch) || patch.patch_set_id !== attempt.patch_set_id
      || !("patch_set_sha256" in patch) || patch.patch_set_sha256 !== attempt.patch_set_sha256
      || !("preimage_root_sha256" in patch) || patch.preimage_root_sha256 !== current.durable_patch_set_baseline_sha256
      || current.durable_patch_set_id !== attempt.patch_set_id
      || current.durable_patch_set_sha256 !== attempt.patch_set_sha256
      || attempt.lease_generation !== integer(current, "lease_generation") + 1
      || attempt.fencing_token !== integer(current, "fencing_token") + 1) {
      throw new AuthorityIntegrityError("Execution integration lost serial preimage or authority CAS");
    }
    const durableEntries = json<readonly WorkerPatchSetV2["entries"][number][]>(
      current,
      "durable_patch_set_entries_json",
    );
    if (journal.entries.length !== durableEntries.length || journal.entries.some((entry, ordinal) => {
      const patchEntry = durableEntries[ordinal];
      return !patchEntry || entry.ordinal !== ordinal || entry.path !== patchEntry.path
        || entry.operation !== patchEntry.operation || entry.expected_before_sha256 !== patchEntry.before_sha256
        || entry.expected_after_sha256 !== patchEntry.after_sha256 || entry.byte_length !== patchEntry.byte_length;
    })) {
      throw new AuthorityIntegrityError("Execution integration journal differs from its durable PatchSet");
    }
    const claimed = this.connection.prepare(`SELECT count(*) count FROM execution_integration_attempts_v2 prior
      JOIN execution_integration_transitions_v2 latest
        ON latest.integration_attempt_id=prior.integration_attempt_id
        AND latest.ordinal=(SELECT MAX(candidate.ordinal) FROM execution_integration_transitions_v2 candidate
          WHERE candidate.integration_attempt_id=prior.integration_attempt_id)
      WHERE prior.run_id=? AND prior.expected_preimage_root_sha256=?
        AND latest.state<>'REJECTED'`).get(
      attempt.run_id, attempt.expected_preimage_root_sha256,
    ) as Record<string, unknown> | undefined;
    if (integer(claimed ?? {}, "count") !== 0) {
      throw new AuthorityIntegrityError("Execution integration preimage already has an authoritative attempt");
    }
    registerArtifact(this.connection, journal.journal_artifact, nowMs);
    for (const entry of journal.entries) {
      if (entry.preimage_artifact) registerArtifact(this.connection, entry.preimage_artifact, nowMs);
    }
    this.connection.prepare(`INSERT INTO execution_integration_attempts_v2(
      integration_attempt_id,goal_id,run_id,execution_graph_revision_id,execution_graph_revision_sha256,
      node_id,node_spec_sha256,proposal_id,proposal_sha256,authorization_sha256,
      expected_preimage_root_sha256,patch_set_id,patch_set_sha256,lease_generation,fencing_token,
      owner_hmac,expires_at_ms,record_sha256,created_at_ms,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      attempt.integration_attempt_id, attempt.goal_id, attempt.run_id, attempt.graph_revision_id,
      attempt.graph_revision_sha256, attempt.node_id, attempt.node_spec_sha256, attempt.proposal_id,
      attempt.proposal_sha256, attempt.authorization_sha256, attempt.expected_preimage_root_sha256,
      attempt.patch_set_id, attempt.patch_set_sha256, attempt.lease_generation, attempt.fencing_token,
      attempt.owner_hmac, attempt.expires_at_ms, attempt.record_sha256, attempt.created_at_ms, eventSequence,
    );
    this.connection.prepare(`INSERT INTO execution_integration_journals_v2(
      integration_attempt_id,journal_artifact_id,journal_sha256,journal_record_sha256,
      entry_count,record_sha256,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?)`).run(
      attempt.integration_attempt_id, journal.journal_artifact.artifactId, journal.journal_sha256,
      journal.journal_record_sha256, journal.entries.length, journal.record_sha256, eventSequence,
    );
    const insertPreimage = this.connection.prepare(`INSERT INTO execution_integration_preimages_v2(
      integration_attempt_id,ordinal,path,operation,expected_before_sha256,observed_before_sha256,
      expected_after_sha256,byte_length,preimage_artifact_id,preimage_artifact_sha256,
      record_sha256,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const entry of journal.entries) {
      insertPreimage.run(
        attempt.integration_attempt_id, entry.ordinal, entry.path, entry.operation,
        entry.expected_before_sha256, entry.observed_before_sha256, entry.expected_after_sha256,
        entry.byte_length, entry.preimage_artifact?.artifactId ?? null,
        entry.preimage_artifact?.sha256 ?? null, entry.record_sha256, eventSequence,
      );
    }
    this.insertIntegrationTransition(prepared, eventSequence);
    const updated = this.connection.prepare(`UPDATE execution_integration_heads_v2 SET integration_attempt_id=?,
      latest_transition_sha256=?,state='PREPARED',lease_generation=?,fencing_token=?,updated_event_sequence=?
      WHERE run_id=? AND state=? AND current_postimage_root_sha256=?
        AND lease_generation=? AND fencing_token=?`).run(
      attempt.integration_attempt_id, prepared.record_sha256, attempt.lease_generation,
      attempt.fencing_token, eventSequence, attempt.run_id, text(current, "state"),
      attempt.expected_preimage_root_sha256, attempt.lease_generation - 1, attempt.fencing_token - 1,
    );
    if (Number(updated.changes) !== 1) throw new AuthorityIntegrityError("Execution integration authority CAS was lost");
    return false;
  }

  transitionIntegration(transition: ExecutionIntegrationTransitionV2, eventSequence: number, nowMs: number): boolean {
    this.assertAvailable();
    assertTransaction(this.connection);
    try { assertExecutionIntegrationTransitionV2(transition); }
    catch (error) { throw new AuthorityIntegrityError("Execution integration transition is invalid", error); }
    const existing = this.connection.prepare("SELECT record_sha256 FROM execution_integration_transitions_v2 WHERE integration_transition_id=?")
      .get(transition.integration_transition_id) as Record<string, unknown> | undefined;
    if (sameOrSubstitution(existing, transition.record_sha256, "Execution integration transition")) return true;
    const current = this.connection.prepare(`SELECT a.run_id,a.goal_id,a.execution_graph_revision_id,
      a.execution_graph_revision_sha256,a.authorization_sha256,a.expires_at_ms,
      a.expected_preimage_root_sha256,a.lease_generation,a.fencing_token,
      h.integration_attempt_id,h.latest_transition_sha256,h.state,h.current_postimage_root_sha256,
      h.lease_generation head_lease_generation,h.fencing_token head_fencing_token,
      t.ordinal,t.postimage_root_sha256,t.created_at_ms predecessor_created_at_ms,
      gh.execution_graph_revision_id head_graph_id,gh.execution_graph_revision_sha256 head_graph_sha256,
      gh.status graph_status,gh.stop_generation,g.authorization_sha256 graph_authorization_sha256,
      z.record_sha256 current_authorization_sha256,z.revoked_at_ms,z.expires_at_ms authorization_expires_at_ms
      FROM execution_integration_attempts_v2 a
      JOIN execution_integration_heads_v2 h ON h.run_id=a.run_id
      JOIN execution_integration_transitions_v2 t
        ON t.integration_attempt_id=a.integration_attempt_id AND t.record_sha256=h.latest_transition_sha256
      JOIN execution_graph_heads_v2 gh ON gh.run_id=a.run_id
      JOIN execution_graph_revisions_v2 g ON g.execution_graph_revision_id=gh.execution_graph_revision_id
      JOIN execution_authorizations_v1 z ON z.authorization_id=g.authorization_id
      WHERE a.integration_attempt_id=?`).get(transition.integration_attempt_id) as Record<string, unknown> | undefined;
    if (!current || current.integration_attempt_id !== transition.integration_attempt_id
      || current.latest_transition_sha256 !== transition.predecessor_transition_sha256
      || transition.ordinal !== integer(current, "ordinal") + 1
      || (transition.state !== "FENCED" && integer(current, "expires_at_ms") <= nowMs)
      || transition.created_at_ms < integer(current, "predecessor_created_at_ms")
      || integer(current, "head_lease_generation") !== integer(current, "lease_generation")
      || integer(current, "head_fencing_token") !== integer(current, "fencing_token")) {
      throw new AuthorityIntegrityError("Execution integration transition lost its lease or predecessor CAS");
    }
    if (current.graph_status !== "RUNNING" || current.head_graph_id !== current.execution_graph_revision_id
      || current.head_graph_sha256 !== current.execution_graph_revision_sha256) {
      throw new AuthorityIntegrityError("Execution integration transition is fenced by the current graph authority");
    }
    if (current.graph_authorization_sha256 !== current.authorization_sha256
      || current.current_authorization_sha256 !== current.authorization_sha256
      || (transition.state !== "FENCED" && (current.revoked_at_ms !== null
        || integer(current, "authorization_expires_at_ms") <= nowMs))) {
      throw new AuthorityIntegrityError("Execution integration transition is fenced by revoked or stale authorization");
    }
    const allowed = (current.state === "PREPARED" && ["OBSERVED", "REJECTED", "FENCED"].includes(transition.state))
      || (current.state === "OBSERVED" && ["COMMITTED", "REJECTED", "FENCED"].includes(transition.state));
    if (!allowed) throw new AuthorityIntegrityError("Execution integration state transition is invalid");
    const observed = transition.state === "OBSERVED";
    const committed = transition.state === "COMMITTED";
    const failed = transition.state === "REJECTED" || transition.state === "FENCED";
    if ((observed && (transition.postimage_root_sha256 === null || transition.failure_sha256 !== null))
      || (committed && (transition.postimage_root_sha256 === null || transition.failure_sha256 !== null))
      || (failed && (transition.postimage_root_sha256 !== null || transition.failure_sha256 === null))) {
      throw new AuthorityIntegrityError("Execution integration transition evidence shape is invalid");
    }
    if (transition.state === "OBSERVED"
      && current.current_postimage_root_sha256 !== current.expected_preimage_root_sha256) {
      throw new AuthorityIntegrityError("Execution integration preimage changed before observation");
    }
    if (transition.state === "COMMITTED" && transition.postimage_root_sha256 !== current.postimage_root_sha256) {
      throw new AuthorityIntegrityError("Execution integration COMMITTED postimage differs from OBSERVED");
    }
    this.insertIntegrationTransition(transition, eventSequence);
    const updated = this.connection.prepare(`UPDATE execution_integration_heads_v2 SET latest_transition_sha256=?,state=?,
      current_postimage_root_sha256=CASE WHEN ?='COMMITTED' THEN ? ELSE current_postimage_root_sha256 END,
      updated_event_sequence=? WHERE run_id=? AND integration_attempt_id=?
        AND latest_transition_sha256=? AND state=? AND lease_generation=? AND fencing_token=?`).run(
      transition.record_sha256, transition.state, transition.state, transition.postimage_root_sha256,
      eventSequence, text(current, "run_id"), transition.integration_attempt_id,
      transition.predecessor_transition_sha256, text(current, "state"),
      integer(current, "lease_generation"), integer(current, "fencing_token"),
    );
    if (Number(updated.changes) !== 1) throw new AuthorityIntegrityError("Execution integration transition CAS was lost");
    if (transition.state === "COMMITTED") {
      const graphUpdated = this.connection.prepare(`UPDATE execution_graph_heads_v2
        SET current_postimage_root_sha256=?,updated_event_sequence=?
        WHERE run_id=? AND execution_graph_revision_id=? AND execution_graph_revision_sha256=?
          AND status='RUNNING' AND current_postimage_root_sha256=?`).run(
        transition.postimage_root_sha256, eventSequence, text(current, "run_id"),
        text(current, "execution_graph_revision_id"), text(current, "execution_graph_revision_sha256"),
        text(current, "expected_preimage_root_sha256"),
      );
      if (Number(graphUpdated.changes) !== 1) throw new AuthorityIntegrityError("Execution integration graph preimage CAS was lost");
    }
    return false;
  }

  private insertIntegrationTransition(transition: ExecutionIntegrationTransitionV2, eventSequence: number): void {
    this.connection.prepare(`INSERT INTO execution_integration_transitions_v2(
      integration_transition_id,integration_attempt_id,ordinal,state,predecessor_transition_sha256,
      postimage_root_sha256,failure_sha256,record_sha256,created_at_ms,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
      transition.integration_transition_id, transition.integration_attempt_id, transition.ordinal,
      transition.state, transition.predecessor_transition_sha256, transition.postimage_root_sha256,
      transition.failure_sha256, transition.record_sha256,
      transition.created_at_ms, eventSequence,
    );
  }

  readWorkerPatchSetClosure(patchSetId: string): WorkerPatchSetClosureV2 | null {
    this.assertAvailable();
    const row = this.connection.prepare("SELECT * FROM worker_patch_sets_v2 WHERE patch_set_id=?")
      .get(patchSetId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const packetRow = this.connection.prepare("SELECT * FROM task_packets_v2 WHERE packet_id=?")
      .get(text(row, "packet_id")) as Record<string, unknown> | undefined;
    const proposalRow = this.connection.prepare("SELECT * FROM worker_proposals_v2 WHERE proposal_id=?")
      .get(text(row, "proposal_id")) as Record<string, unknown> | undefined;
    if (!packetRow || !proposalRow) throw new AuthorityIntegrityError("Worker PatchSet proposal closure is missing");
    let packet: TaskPacketV2;
    let patchSet: WorkerPatchSetV2;
    let proposal: WorkerProposalV2;
    try {
      packet = taskPacketFromRow(packetRow);
      proposal = workerProposalFromRow(proposalRow);
      patchSet = workerPatchSetFromRow(row, packet);
    } catch (error) {
      throw new AuthorityIntegrityError("Worker PatchSet durable record is invalid", error);
    }
    const payload = proposal.payload;
    if (proposal.kind !== "PATCH_PROPOSAL" || !("patch_set_id" in payload) || !("patch_set_sha256" in payload)
      || payload.patch_set_id !== patchSet.patch_set_id || payload.patch_set_sha256 !== patchSet.record_sha256
      || text(row, "proposal_sha256") !== proposal.record_sha256) {
      throw new AuthorityIntegrityError("Worker PatchSet does not rebuild from its proposal");
    }
    const artifactRows = this.connection.prepare(`SELECT s.path,s.artifact_id,s.artifact_sha256,s.byte_length,
        s.created_event_sequence,a.media_type,a.classification,a.locator,a.encryption_key_id,a.retention_class
      FROM worker_patch_set_artifacts_v2 s JOIN artifacts a
        ON a.artifact_id=s.artifact_id AND a.sha256=s.artifact_sha256
      WHERE s.patch_set_id=? ORDER BY s.path`).all(patchSet.patch_set_id) as Record<string, unknown>[];
    const expected = patchSet.entries.filter((entry) => entry.after_sha256 !== null);
    if (artifactRows.length !== expected.length) {
      throw new AuthorityIntegrityError("Worker PatchSet artifact-path closure is incomplete");
    }
    const byPath = new Map(expected.map((entry) => [entry.path, entry]));
    const artifacts = artifactRows.map((artifactRow): WorkerPatchArtifactClosureV2 => {
      const path = text(artifactRow, "path");
      const entry = byPath.get(path);
      if (!entry || entry.after_sha256 !== text(artifactRow, "artifact_sha256")
        || entry.byte_length !== integer(artifactRow, "byte_length")
        || integer(artifactRow, "created_event_sequence") !== integer(row, "created_event_sequence")
        || text(artifactRow, "classification") === "SECRET") {
        throw new AuthorityIntegrityError(`Worker PatchSet artifact differs at ${path}`);
      }
      return {
        path,
        artifact: {
          artifactId: text(artifactRow, "artifact_id"),
          sha256: text(artifactRow, "artifact_sha256"),
          byteLength: integer(artifactRow, "byte_length"),
          mediaType: text(artifactRow, "media_type"),
          classification: text(artifactRow, "classification") as ArtifactMetadata["classification"],
          locator: text(artifactRow, "locator"),
          encryptionKeyId: nullableText(artifactRow, "encryption_key_id"),
          retentionClass: text(artifactRow, "retention_class"),
        },
      };
    });
    return {
      patchSet,
      proposalId: proposal.proposal_id,
      proposalSha256: proposal.record_sha256,
      artifacts,
    };
  }

  readExecutionIntegrationJournal(integrationAttemptId: string): ExecutionIntegrationJournalV2 | null {
    this.assertAvailable();
    const row = this.connection.prepare(`SELECT j.*,
        a.artifact_id journal_artifact_id,a.sha256 journal_artifact_sha256,
        a.byte_length journal_artifact_byte_length,a.media_type journal_artifact_media_type,
        a.classification journal_artifact_classification,a.locator journal_artifact_locator,
        a.encryption_key_id journal_artifact_encryption_key_id,a.retention_class journal_artifact_retention_class
      FROM execution_integration_journals_v2 j
      JOIN artifacts a ON a.artifact_id=j.journal_artifact_id
      WHERE j.integration_attempt_id=?`).get(integrationAttemptId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const entryRows = this.connection.prepare(`SELECT p.*,
        a.artifact_id preimage_metadata_artifact_id,a.sha256 preimage_metadata_sha256,
        a.byte_length preimage_metadata_byte_length,a.media_type preimage_metadata_media_type,
        a.classification preimage_metadata_classification,a.locator preimage_metadata_locator,
        a.encryption_key_id preimage_metadata_encryption_key_id,a.retention_class preimage_metadata_retention_class
      FROM execution_integration_preimages_v2 p
      LEFT JOIN artifacts a ON a.artifact_id=p.preimage_artifact_id
      WHERE p.integration_attempt_id=? ORDER BY p.ordinal`).all(integrationAttemptId) as Record<string, unknown>[];
    if (entryRows.length !== integer(row, "entry_count")) {
      throw new AuthorityIntegrityError("Execution integration journal entry closure is incomplete");
    }
    const journal: ExecutionIntegrationJournalV2 = {
      schema_version: 2,
      integration_attempt_id: integrationAttemptId,
      journal_sha256: text(row, "journal_sha256"),
      journal_record_sha256: text(row, "journal_record_sha256"),
      journal_artifact: {
        artifactId: text(row, "journal_artifact_id"),
        sha256: text(row, "journal_artifact_sha256"),
        byteLength: integer(row, "journal_artifact_byte_length"),
        mediaType: text(row, "journal_artifact_media_type"),
        classification: text(row, "journal_artifact_classification") as ArtifactMetadata["classification"],
        locator: text(row, "journal_artifact_locator"),
        encryptionKeyId: nullableText(row, "journal_artifact_encryption_key_id"),
        retentionClass: text(row, "journal_artifact_retention_class"),
      },
      entries: entryRows.map((entry) => {
        const artifactId = nullableText(entry, "preimage_metadata_artifact_id");
        return {
          ordinal: integer(entry, "ordinal"),
          path: text(entry, "path"),
          operation: text(entry, "operation") as "CREATE" | "MODIFY" | "DELETE",
          expected_before_sha256: nullableText(entry, "expected_before_sha256"),
          observed_before_sha256: nullableText(entry, "observed_before_sha256"),
          expected_after_sha256: nullableText(entry, "expected_after_sha256"),
          byte_length: integer(entry, "byte_length"),
          preimage_artifact: artifactId === null ? null : {
            artifactId,
            sha256: text(entry, "preimage_metadata_sha256"),
            byteLength: integer(entry, "preimage_metadata_byte_length"),
            mediaType: text(entry, "preimage_metadata_media_type"),
            classification: text(entry, "preimage_metadata_classification") as ArtifactMetadata["classification"],
            locator: text(entry, "preimage_metadata_locator"),
            encryptionKeyId: nullableText(entry, "preimage_metadata_encryption_key_id"),
            retentionClass: text(entry, "preimage_metadata_retention_class"),
          },
          integration_attempt_id: integrationAttemptId,
          record_sha256: text(entry, "record_sha256"),
        };
      }),
      record_sha256: text(row, "record_sha256"),
    };
    try { assertExecutionIntegrationJournalV2(journal); }
    catch (error) { throw new AuthorityIntegrityError("Execution integration journal is invalid", error); }
    return journal;
  }

  readIntegrationRecovery(runId: string): ExecutionIntegrationRecoveryV2 | null {
    this.assertAvailable();
    const row = this.connection.prepare(`SELECT h.state integration_state,h.latest_transition_sha256,
        nh.status node_status,z.record_sha256 current_authorization_sha256,
        z.revoked_at_ms authorization_revoked_at_ms,z.expires_at_ms authorization_expires_at_ms,a.*
      FROM execution_integration_heads_v2 h
      JOIN execution_integration_attempts_v2 a ON a.integration_attempt_id=h.integration_attempt_id
      JOIN execution_node_heads_v2 nh ON nh.execution_graph_revision_id=a.execution_graph_revision_id
        AND nh.node_id=a.node_id
      JOIN execution_graph_revisions_v2 g ON g.execution_graph_revision_id=a.execution_graph_revision_id
      JOIN execution_authorizations_v1 z ON z.authorization_id=g.authorization_id
      WHERE h.run_id=? AND (
        h.state IN ('PREPARED','OBSERVED')
        OR (h.state='COMMITTED' AND nh.status='PROPOSAL_SUBMITTED')
      )`).get(runId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const graph = this.readGraph(text(row, "execution_graph_revision_id"));
    if (!graph || graph.record_sha256 !== text(row, "execution_graph_revision_sha256")) {
      throw new AuthorityIntegrityError("Execution integration recovery graph is stale");
    }
    const attempt = integrationAttemptFromRow(row);
    const journal = this.readExecutionIntegrationJournal(attempt.integration_attempt_id);
    const transitionRow = this.connection.prepare(`SELECT * FROM execution_integration_transitions_v2
      WHERE integration_attempt_id=? AND record_sha256=?`).get(
      attempt.integration_attempt_id, text(row, "latest_transition_sha256"),
    ) as Record<string, unknown> | undefined;
    const proposalRow = this.connection.prepare("SELECT * FROM worker_proposals_v2 WHERE proposal_id=?")
      .get(attempt.proposal_id) as Record<string, unknown> | undefined;
    const packetRow = proposalRow ? this.connection.prepare("SELECT * FROM task_packets_v2 WHERE packet_id=?")
      .get(text(proposalRow, "packet_id")) as Record<string, unknown> | undefined : undefined;
    if (!transitionRow || !packetRow || !proposalRow || !journal) {
      throw new AuthorityIntegrityError("Execution integration recovery closure is incomplete");
    }
    const packet = taskPacketFromRow(packetRow);
    const proposal = workerProposalFromRow(proposalRow);
    const leaseRow = this.connection.prepare(`SELECT * FROM execution_node_leases_v2
      WHERE packet_id=? AND generation=? AND fencing_token=?`).get(
      packet.packet_id, packet.lease_generation, packet.fencing_token,
    ) as Record<string, unknown> | undefined;
    const patchClosure = this.readWorkerPatchSetClosure(attempt.patch_set_id);
    if (!leaseRow || !patchClosure || patchClosure.patchSet.record_sha256 !== attempt.patch_set_sha256
      || proposal.record_sha256 !== attempt.proposal_sha256 || proposal.packet_id !== packet.packet_id) {
      throw new AuthorityIntegrityError("Execution integration recovery packet, lease, proposal, or PatchSet is stale");
    }
    return {
      graph,
      attempt,
      latestTransition: integrationTransitionFromRow(transitionRow),
      journal,
      packet,
      lease: nodeLeaseFromRow(leaseRow),
      proposal,
      patchClosure,
      nodeStatus: text(row, "node_status"),
      currentAuthorizationSha256: text(row, "current_authorization_sha256"),
      authorizationRevokedAtMs: nullableInteger(row, "authorization_revoked_at_ms"),
      authorizationExpiresAtMs: integer(row, "authorization_expires_at_ms"),
    };
  }

  readStopPreparation(runId: string): ExecutionStopPreparationV2 | null {
    this.assertAvailable();
    const head = this.connection.prepare(`SELECT execution_graph_revision_id,
        execution_graph_revision_sha256,stop_generation,status
      FROM execution_graph_heads_v2 WHERE run_id=?`).get(runId) as Record<string, unknown> | undefined;
    if (!head || head.status !== "RUNNING") return null;
    const graph = this.readGraph(text(head, "execution_graph_revision_id"));
    if (!graph || graph.record_sha256 !== text(head, "execution_graph_revision_sha256")) {
      throw new AuthorityIntegrityError("Execution stop preparation graph is stale");
    }
    const event = this.connection.prepare("SELECT event_sha256 FROM events WHERE goal_id=? ORDER BY sequence DESC LIMIT 1")
      .get(graph.goal_id) as Record<string, unknown> | undefined;
    if (!event) throw new AuthorityIntegrityError("Execution stop preparation lacks an authority predecessor");
    return {
      graph,
      stopGeneration: integer(head, "stop_generation"),
      predecessorAuthorityHeadSha256: text(event, "event_sha256"),
    };
  }

  readExpiredNodeAttempts(runId: string, nowMs: number): readonly ExpiredExecutionNodeAttemptV2[] {
    this.assertAvailable();
    const rows = this.connection.prepare(`SELECT nh.latest_packet_id,lh.execution_node_lease_id
      FROM execution_graph_heads_v2 gh
      JOIN execution_node_heads_v2 nh ON nh.execution_graph_revision_id=gh.execution_graph_revision_id
      JOIN execution_node_lease_heads_v2 lh ON lh.execution_graph_revision_id=nh.execution_graph_revision_id
        AND lh.node_id=nh.node_id
      WHERE gh.run_id=? AND gh.status='RUNNING' AND nh.status IN ('LEASED','PROPOSAL_SUBMITTED')
        AND lh.expires_at_ms<=? ORDER BY nh.node_id`).all(runId, nowMs) as Record<string, unknown>[];
    return rows.map((row) => {
      const packetRow = this.connection.prepare("SELECT * FROM task_packets_v2 WHERE packet_id=?")
        .get(text(row, "latest_packet_id")) as Record<string, unknown> | undefined;
      const leaseRow = this.connection.prepare("SELECT * FROM execution_node_leases_v2 WHERE execution_node_lease_id=?")
        .get(text(row, "execution_node_lease_id")) as Record<string, unknown> | undefined;
      if (!packetRow || !leaseRow) throw new AuthorityIntegrityError("Expired execution node closure is missing");
      const packet = taskPacketFromRow(packetRow);
      const lease = nodeLeaseFromRow(leaseRow);
      if (lease.packet_id !== packet.packet_id || lease.packet_sha256 !== packet.packet_sha256
        || lease.expires_at_ms > nowMs) throw new AuthorityIntegrityError("Expired execution node closure is stale");
      return { packet, lease };
    });
  }

  isCurrentNodePacket(packet: TaskPacketV2): boolean {
    this.assertAvailable();
    assertTaskPacketRecordV2(packet);
    const row = this.connection.prepare(`SELECT gh.status graph_status,gh.execution_graph_revision_id,
        gh.execution_graph_revision_sha256,nh.status node_status,nh.stop_generation,
        nh.latest_packet_id,nh.latest_packet_sha256
      FROM execution_graph_heads_v2 gh
      JOIN execution_node_heads_v2 nh ON nh.execution_graph_revision_id=gh.execution_graph_revision_id
        AND nh.node_id=?
      WHERE gh.run_id=?`).get(packet.node_id, packet.run_id) as Record<string, unknown> | undefined;
    return Boolean(row) && row!.graph_status === "RUNNING"
      && row!.execution_graph_revision_id === packet.graph_revision_id
      && row!.execution_graph_revision_sha256 === packet.graph_revision_sha256
      && ["LEASED", "PROPOSAL_SUBMITTED"].includes(String(row!.node_status))
      && integer(row!, "stop_generation") === packet.stop_generation
      && row!.latest_packet_id === packet.packet_id
      && row!.latest_packet_sha256 === packet.packet_sha256;
  }

  readGraph(graphId: string): ExecutionGraphRevisionV2 | null {
    this.assertAvailable();
    const row = this.connection.prepare("SELECT * FROM execution_graph_revisions_v2 WHERE execution_graph_revision_id=?")
      .get(graphId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const nodeRows = this.connection.prepare(`SELECT * FROM execution_nodes_v2
      WHERE execution_graph_revision_id=? ORDER BY node_id`).all(graphId) as Record<string, unknown>[];
    const nodes: ExecutionNodeSpecV2[] = nodeRows.map((node) => ({
      schema_version: 2,
      node_id: text(node, "node_id"),
      logical_key: text(node, "logical_key"),
      task: text(node, "task_text"),
      capabilities: json<readonly ExecutionCapabilityV2[]>(node, "capabilities_json"),
      effect_ceiling: text(node, "effect_ceiling") as ExecutionNodeSpecV2["effect_ceiling"],
      requirement_ids: json<readonly string[]>(node, "requirement_ids_json"),
      obligation_ids: json<readonly string[]>(node, "obligation_ids_json"),
      read_roots: json<readonly string[]>(node, "read_roots_json"),
      write_roots: json<readonly string[]>(node, "write_roots_json"),
      exact_input_refs: json<ExecutionNodeSpecV2["exact_input_refs"]>(node, "exact_input_refs_json"),
      decision_refs: json<ExecutionNodeSpecV2["decision_refs"]>(node, "decision_refs_json"),
      provider_call_plan_id: nullableText(node, "provider_call_plan_id"),
      provider_call_plan_sha256: nullableText(node, "provider_call_plan_sha256"),
      input_closure_sha256: text(node, "input_closure_sha256"),
      output_schema_sha256: text(node, "output_schema_sha256"),
      oracle_sha256: text(node, "oracle_sha256"),
      provider_profile_sha256: text(node, "provider_profile_sha256"),
      privacy_class: text(node, "privacy_class") as ExecutionPrivacyClassV2,
      taint_classes: json<readonly string[]>(node, "taint_classes_json"),
      max_turns: integer(node, "max_turns"),
      max_tool_calls: integer(node, "max_tool_calls"),
      max_input_tokens: integer(node, "max_input_tokens"),
      max_output_tokens: integer(node, "max_output_tokens"),
      max_retries: integer(node, "max_retries"),
      no_progress_limit: integer(node, "no_progress_limit"),
      deadline_ms: integer(node, "deadline_ms"),
      record_sha256: text(node, "record_sha256"),
    }));
    const edgeRows = this.connection.prepare(`SELECT * FROM execution_edges_v2
      WHERE execution_graph_revision_id=? ORDER BY from_node_id,to_node_id,condition`).all(graphId) as Record<string, unknown>[];
    const edges: ExecutionEdgeV2[] = edgeRows.map((edge) => ({
      from_node_id: text(edge, "from_node_id"),
      to_node_id: text(edge, "to_node_id"),
      condition: text(edge, "condition") as ExecutionEdgeConditionV2,
      record_sha256: text(edge, "record_sha256"),
    }));
    const graph: ExecutionGraphRevisionV2 = {
      schema_version: 2,
      execution_graph_revision_id: text(row, "execution_graph_revision_id"),
      goal_id: text(row, "goal_id"),
      run_id: text(row, "run_id"),
      work_cell_id: text(row, "work_cell_id"),
      plan_revision_id: text(row, "plan_revision_id"),
      plan_revision_sha256: text(row, "plan_revision_sha256"),
      topology_gate_receipt_id: text(row, "topology_gate_receipt_id"),
      topology_gate_receipt_sha256: text(row, "topology_gate_receipt_sha256"),
      authorization_id: text(row, "authorization_id"),
      authorization_sha256: text(row, "authorization_sha256"),
      baseline_sha256: text(row, "baseline_sha256"),
      baseline_content_root_sha256: text(row, "baseline_content_root_sha256"),
      environment_sha256: text(row, "environment_sha256"),
      input_closure_sha256: text(row, "input_closure_sha256"),
      oracle_set_sha256: text(row, "oracle_set_sha256"),
      config_sha256: text(row, "config_sha256"),
      runtime_fingerprint_sha256: text(row, "runtime_fingerprint_sha256"),
      predecessor_authority_head_sha256: text(row, "predecessor_authority_head_sha256"),
      graph_revision: integer(row, "graph_revision"),
      stop_generation: integer(row, "stop_generation"),
      node_root_sha256: text(row, "node_root_sha256"),
      edge_root_sha256: text(row, "edge_root_sha256"),
      graph_sha256: text(row, "graph_sha256"),
      nodes,
      edges,
      created_at_ms: integer(row, "created_at_ms"),
      record_sha256: text(row, "record_sha256"),
    };
    try { assertExecutionGraphRecordV2(graph); assertExecutionGraphSemanticsV2(graph); }
    catch (error) { throw new AuthorityIntegrityError("Stored execution graph cannot be reconstructed", error); }
    return graph;
  }

  private readHostReceipts(graphId: string): readonly HostNodeReceiptV2[] {
    const rows = this.connection.prepare(`SELECT r.* FROM host_node_receipts_v2 r
      JOIN execution_node_heads_v2 h ON h.execution_graph_revision_id=r.execution_graph_revision_id
        AND h.node_id=r.node_id AND h.latest_proposal_id=r.proposal_id
        AND h.latest_proposal_sha256=r.proposal_sha256 AND h.stop_generation=r.stop_generation
      JOIN execution_graph_heads_v2 gh ON gh.execution_graph_revision_id=r.execution_graph_revision_id
      JOIN execution_integration_heads_v2 ih ON ih.run_id=gh.run_id
      LEFT JOIN execution_integration_transitions_v2 it ON it.record_sha256=ih.latest_transition_sha256
      LEFT JOIN host_oracle_receipts_v2 o ON o.record_sha256=r.evidence_sha256 AND r.kind='ORACLE_PASSED'
      WHERE r.execution_graph_revision_id=?
        AND (r.kind<>'ORACLE_PASSED' OR (
          o.postimage_root_sha256=gh.current_postimage_root_sha256
          AND o.created_event_sequence>COALESCE(it.created_event_sequence,0)
        ))
      ORDER BY r.created_event_sequence,r.host_node_receipt_id`).all(graphId) as Record<string, unknown>[];
    const graph = this.readGraph(graphId);
    if (!graph) throw new AuthorityIntegrityError("Host receipt graph is missing");
    return rows.map((row) => hostReceiptFromRow(row, graph));
  }

  readProjection(runId: string, availableSlots = 1): ExecutionV2Projection | null {
    this.assertAvailable();
    const head = this.connection.prepare("SELECT * FROM execution_graph_heads_v2 WHERE run_id=?").get(runId) as Record<string, unknown> | undefined;
    if (!head) return null;
    const graph = this.readGraph(text(head, "execution_graph_revision_id"));
    if (!graph) throw new AuthorityIntegrityError("Execution graph head references a missing graph");
    const integration = this.connection.prepare("SELECT * FROM execution_integration_heads_v2 WHERE run_id=?")
      .get(runId) as Record<string, unknown> | undefined;
    if (!integration || text(integration, "current_postimage_root_sha256") !== text(head, "current_postimage_root_sha256")) {
      throw new AuthorityIntegrityError("Execution integration head is missing or differs from the graph postimage");
    }
    const nodeRows = this.connection.prepare(`SELECT nh.node_id,nh.status,nh.attempt_count,nh.stop_generation,
      nh.latest_host_receipt_id,nh.latest_host_receipt_sha256,
      COALESCE(lh.generation,0) lease_generation,COALESCE(lh.fencing_token,0) fencing_token
      FROM execution_node_heads_v2 nh
      LEFT JOIN execution_node_lease_heads_v2 lh
        ON lh.execution_graph_revision_id=nh.execution_graph_revision_id AND lh.node_id=nh.node_id
      WHERE nh.execution_graph_revision_id=? ORDER BY nh.node_id`).all(
      graph.execution_graph_revision_id,
    ) as Record<string, unknown>[];
    const active = nodeRows.filter((row) => row.status === "LEASED" || row.status === "PROPOSAL_SUBMITTED")
      .map((row) => text(row, "node_id"));
    const unavailable = nodeRows.filter((row) => row.status !== "READY")
      .map((row) => text(row, "node_id"));
    const receipts = this.readHostReceipts(graph.execution_graph_revision_id);
    const completed = successfulExecutionNodeIdsV2(graph, receipts);
    const completedSet = new Set(completed);
    const oraclePending = nodeRows.filter((row) =>
      ["EVIDENCE_ACCEPTED", "PATCH_INTEGRATED", "ORACLE_PASSED"].includes(String(row.status))
        && !completedSet.has(text(row, "node_id")))
      .map((row) => text(row, "node_id"));
    const readyNodeIds = head.status === "RUNNING" ? readyExecutionNodeIdsV2(graph, receipts, unavailable, availableSlots) : [];
    const rowsByNode = new Map(nodeRows.map((row) => [text(row, "node_id"), row]));
    return {
      graph,
      status: text(head, "status") as ExecutionV2Projection["status"],
      stopGeneration: integer(head, "stop_generation"),
      currentPostimageRootSha256: text(head, "current_postimage_root_sha256"),
      integrationState: text(integration, "state") as ExecutionV2Projection["integrationState"],
      integrationLeaseGeneration: integer(integration, "lease_generation"),
      integrationFencingToken: integer(integration, "fencing_token"),
      readyNodeIds,
      activeNodeIds: active,
      completedNodeIds: completed,
      oraclePendingNodeIds: oraclePending,
      readyDispatches: readyNodeIds.map((nodeId) => {
        const row = rowsByNode.get(nodeId)!;
        return {
          nodeId,
          attempt: integer(row, "attempt_count") + 1,
          leaseGeneration: integer(row, "lease_generation") + 1,
          fencingToken: integer(row, "fencing_token") + 1,
          stopGeneration: integer(row, "stop_generation"),
        };
      }),
    };
  }

  readNodeOraclePreparation(runId: string, nodeId: string): ExecutionNodeOraclePreparationV2 {
    this.assertAvailable();
    const current = this.connection.prepare(`SELECT gh.execution_graph_revision_id,gh.execution_graph_revision_sha256,
        gh.current_postimage_root_sha256,gh.status graph_status,nh.status node_status,
        nh.latest_packet_id,nh.latest_packet_sha256,nh.latest_proposal_id,nh.latest_proposal_sha256
      FROM execution_graph_heads_v2 gh
      JOIN execution_node_heads_v2 nh ON nh.execution_graph_revision_id=gh.execution_graph_revision_id
      WHERE gh.run_id=? AND nh.node_id=?`).get(runId, nodeId) as Record<string, unknown> | undefined;
    if (!current || current.graph_status !== "RUNNING"
      || !["EVIDENCE_ACCEPTED", "PATCH_INTEGRATED", "ORACLE_PASSED"].includes(String(current.node_status))) {
      throw new AuthorityIntegrityError("Execution node is not pending a Host oracle");
    }
    const graph = this.readGraph(text(current, "execution_graph_revision_id"));
    if (!graph || graph.record_sha256 !== text(current, "execution_graph_revision_sha256")) {
      throw new AuthorityIntegrityError("Execution node oracle graph closure is stale");
    }
    const packetRow = this.connection.prepare("SELECT * FROM task_packets_v2 WHERE packet_id=?").get(
      text(current, "latest_packet_id"),
    ) as Record<string, unknown> | undefined;
    const proposalRow = this.connection.prepare("SELECT * FROM worker_proposals_v2 WHERE proposal_id=?").get(
      text(current, "latest_proposal_id"),
    ) as Record<string, unknown> | undefined;
    if (!packetRow || !proposalRow) throw new AuthorityIntegrityError("Execution node oracle packet/proposal closure is missing");
    const packet = taskPacketFromRow(packetRow);
    const proposal = workerProposalFromRow(proposalRow);
    if (packet.packet_sha256 !== text(current, "latest_packet_sha256")
      || proposal.record_sha256 !== text(current, "latest_proposal_sha256")
      || packet.node_id !== nodeId || proposal.node_id !== nodeId
      || proposal.packet_id !== packet.packet_id || proposal.packet_sha256 !== packet.packet_sha256) {
      throw new AuthorityIntegrityError("Execution node oracle packet/proposal closure is stale");
    }
    return {
      graph,
      packet,
      proposal,
      currentPostimageRootSha256: text(current, "current_postimage_root_sha256"),
    };
  }

  verifyIntegrity(): ExecutionV2IntegritySummary {
    if (!this.available()) return {
      available: false, strongSingleRollouts: 0, strongSingleWorkloadBindings: 0,
      workloadComparabilityReceipts: 0, dynamicMultiProposals: 0, topologyMeasurementEvidence: 0, topologyMeasurements: 0, graphs: 0, nodes: 0, packets: 0, leases: 0, proposals: 0, patchSets: 0, patchArtifacts: 0,
      attemptOutcomes: 0, hostOracleReceipts: 0, hostOracleEvidence: 0, hostReceipts: 0,
      integrationAttempts: 0, integrationJournals: 0, integrationPreimages: 0,
      integrationTransitions: 0, stops: 0,
      graphTerminalReceipts: 0, graphTerminalNodes: 0, mismatches: 0,
    };
    const count = (table: string): number => integer(
      (this.connection.prepare(`SELECT count(*) count FROM ${table}`).get() as Record<string, unknown> | undefined) ?? {}, "count",
    );
    let mismatches = 0;
    const check = (action: () => void): void => {
      try { action(); }
      catch { mismatches += 1; }
    };
    const requireIntegrity = (condition: boolean, message: string): void => {
      if (!condition) throw new AuthorityIntegrityError(message);
    };
    const assertEvent = (
      goalId: string,
      sequence: number,
      eventType: string,
      expected: Readonly<Record<string, unknown>>,
    ): void => {
      const event = this.connection.prepare("SELECT event_type,payload_json FROM events WHERE goal_id=? AND sequence=?")
        .get(goalId, sequence) as Record<string, unknown> | undefined;
      requireIntegrity(Boolean(event) && event?.event_type === eventType, "Execution record event type is invalid");
      const payload = json<Record<string, unknown>>(event!, "payload_json");
      for (const [key, value] of Object.entries(expected)) {
        requireIntegrity(payload[key] === value, `Execution record event payload ${key} is invalid`);
      }
    };
    const assertExactEvent = (
      goalId: string,
      sequence: number,
      eventType: string,
      expected: Readonly<Record<string, unknown>>,
    ): void => {
      const event = this.connection.prepare(`SELECT e.event_id,e.event_type,e.command_id,e.payload_json,
          e.payload_sha256,e.prev_event_sha256,e.event_sha256,e.store_generation,e.leader_epoch,sm.store_id
        FROM events e CROSS JOIN store_meta sm
        WHERE sm.singleton=1 AND e.goal_id=? AND e.sequence=?`).get(goalId, sequence) as Record<string, unknown> | undefined;
      requireIntegrity(Boolean(event) && event?.event_type === eventType, "Execution record event type is invalid");
      const expectedPayloadJson = canonicalJson(expected);
      requireIntegrity(text(event!, "payload_json") === expectedPayloadJson
        && text(event!, "payload_sha256") === canonicalJsonSha256(expected),
      "Execution record event payload closure is invalid");
      const prior = sequence === 1 ? null : this.connection.prepare(
        "SELECT event_sha256 FROM events WHERE goal_id=? AND sequence=?",
      ).get(goalId, sequence - 1) as Record<string, unknown> | undefined;
      const expectedPredecessor = sequence === 1 ? null : prior ? text(prior, "event_sha256") : null;
      requireIntegrity(nullableText(event!, "prev_event_sha256") === expectedPredecessor,
        "Execution record event predecessor is invalid");
      requireIntegrity(computeEventSha256({
        storeId: text(event!, "store_id"), goalId, sequence, eventType,
        commandId: text(event!, "command_id"), payloadSha256: text(event!, "payload_sha256"),
        prevEventSha256: nullableText(event!, "prev_event_sha256"),
        storeGeneration: integer(event!, "store_generation"), leaderEpoch: integer(event!, "leader_epoch"),
      }) === text(event!, "event_sha256"), "Execution record event hash is invalid");
    };
    const assertPredecessor = (goalId: string, sequence: number, predecessor: string): void => {
      const event = this.connection.prepare("SELECT event_sha256 FROM events WHERE goal_id=? AND sequence=?")
        .get(goalId, sequence - 1) as Record<string, unknown> | undefined;
      requireIntegrity(event?.event_sha256 === predecessor, "Execution record predecessor authority head is invalid");
    };

    const rolloutRows = tableExists(this.connection, "strong_single_rollout_receipts_v1")
      ? this.connection.prepare(`SELECT * FROM strong_single_rollout_receipts_v1
        ORDER BY created_event_sequence,rollout_receipt_id`).all() as Record<string, unknown>[]
      : [];
    const dynamicMultiProposalRows = tableExists(this.connection, "dynamic_multi_proposal_receipts_v2")
      ? this.connection.prepare(`SELECT * FROM dynamic_multi_proposal_receipts_v2
        ORDER BY created_event_sequence,dynamic_multi_proposal_receipt_id`).all() as Record<string, unknown>[]
      : [];
    for (const row of dynamicMultiProposalRows) check(() => {
      const proposal = dynamicMultiProposalFromRow(row);
      const sequence = integer(row, "created_event_sequence");
      assertExactEvent(proposal.goal_id, sequence, "DYNAMIC_MULTI_PROPOSAL_RECORDED", {
        proposalId: proposal.dynamic_multi_proposal_receipt_id,
        proposalSha256: proposal.record_sha256,
        runId: proposal.run_id,
        workCellId: proposal.work_cell_id,
        graphProposalSha256: proposal.graph_proposal_sha256,
      });
      assertPredecessor(proposal.goal_id, sequence, proposal.predecessor_authority_head_sha256);
      const closure = this.connection.prepare(`SELECT 1 valid
        FROM managed_runs_v1 run
        JOIN topology_revisions_v1 topology ON topology.run_id=run.run_id
          AND topology.created_event_sequence=(
            SELECT MAX(prior_topology.created_event_sequence) FROM topology_revisions_v1 prior_topology
            WHERE prior_topology.run_id=run.run_id AND prior_topology.created_event_sequence<?)
        JOIN plan_revisions_v2 plan ON plan.plan_revision_id=? AND plan.goal_id=run.goal_id
        JOIN work_cells_v1 cell ON cell.work_cell_id=? AND cell.goal_id=run.goal_id
        JOIN plan_subjects_v2 subject ON subject.plan_revision_id=plan.plan_revision_id
          AND subject.goal_id=run.goal_id AND subject.subject_kind='WORK_CELL'
          AND subject.subject_id=cell.logical_key AND subject.revision_sha256=cell.spec_sha256
        JOIN execution_authorizations_v1 authorization ON authorization.authorization_id=?
          AND authorization.goal_id=run.goal_id AND authorization.work_cell_id=cell.work_cell_id
        JOIN workspace_baselines_v1 baseline ON baseline.baseline_id=authorization.baseline_id
          AND baseline.goal_id=run.goal_id
        WHERE run.run_id=? AND run.goal_id=? AND run.created_event_sequence<?
          AND topology.requested_topology='MULTI' AND topology.config_sha256=?
          AND plan.record_sha256=? AND plan.input_closure_sha256=? AND plan.created_event_sequence<?
          AND cell.created_event_sequence<?
          AND authorization.record_sha256=? AND authorization.created_event_sequence<?
          AND authorization.expires_at_ms>=?
          AND (authorization.revoked_at_ms IS NULL OR authorization.revoked_at_ms>=?)
          AND baseline.record_sha256=? AND baseline.content_root_sha256=?
          AND baseline.environment_sha256=? AND baseline.created_event_sequence<?`).get(
        sequence, proposal.plan_revision_id, proposal.work_cell_id, proposal.authorization_id,
        proposal.run_id, proposal.goal_id, sequence, proposal.config_sha256,
        proposal.plan_revision_sha256, proposal.input_closure_sha256, sequence, sequence,
        proposal.authorization_sha256, sequence, proposal.created_at_ms, proposal.created_at_ms,
        proposal.baseline_sha256, proposal.baseline_content_root_sha256,
        proposal.environment_sha256, sequence,
      ) as Record<string, unknown> | undefined;
      requireIntegrity(closure?.valid === 1, "Dynamic Multi proposal authority closure is invalid");
    });
    for (const row of rolloutRows) check(() => {
      const receipt = strongSingleRolloutFromRow(row);
      const sequence = integer(row, "created_event_sequence");
      assertEvent(receipt.goal_id, sequence, "STRONG_SINGLE_ROLLOUT_RECORDED", {
        rolloutReceiptId: receipt.rollout_receipt_id,
        rolloutReceiptSha256: receipt.record_sha256,
        runId: receipt.run_id,
        workCellId: receipt.work_cell_id,
        providerReceiptRootSha256: receipt.provider_receipt_root_sha256,
      });
      const usage = this.connection.prepare(`SELECT count(*) count FROM provider_invocation_transitions_v1
        WHERE goal_id=? AND run_id=? AND created_at_ms BETWEEN ? AND ?`).get(
        receipt.goal_id, receipt.run_id, receipt.started_at_ms, receipt.completed_at_ms,
      ) as Record<string, unknown> | undefined;
      requireIntegrity(integer(usage ?? {}, "count") === 0,
        "Strong Single rollout contains Worker provider invocations");
      const topology = this.connection.prepare(`SELECT t.revision topology_revision,t.effective_topology,
          t.record_sha256,t.config_sha256,t.created_at_ms
        FROM managed_runs_v1 run JOIN topology_revisions_v1 t
          ON t.run_id=run.run_id AND t.revision=?
        WHERE run.run_id=? AND run.goal_id=?`).get(
        receipt.topology_revision, receipt.run_id, receipt.goal_id,
      ) as Record<string, unknown> | undefined;
      requireIntegrity(Boolean(topology) && topology!.effective_topology === "SINGLE"
        && integer(topology!, "topology_revision") === receipt.topology_revision
        && text(topology!, "record_sha256") === receipt.topology_revision_sha256
        && text(topology!, "config_sha256") === receipt.config_sha256
        && integer(topology!, "created_at_ms") <= receipt.started_at_ms,
      "Strong Single rollout topology epoch is invalid");
      const providerUsage = new InputContextRepository(this.connection).readRunProviderTurnUsage({
        goal_id: receipt.goal_id,
        run_id: receipt.run_id,
        started_at_ms: receipt.started_at_ms,
        completed_at_ms: receipt.completed_at_ms,
      });
      requireIntegrity(providerUsage.accounting_completeness === "COMPLETE"
        && providerUsage.requests === receipt.provider_requests
        && providerUsage.input_tokens === receipt.input_tokens
        && providerUsage.output_tokens === receipt.output_tokens
        && providerUsage.cache_read_tokens === receipt.cache_read_tokens
        && sameJson(providerUsage.receipt_refs, receipt.provider_receipt_refs),
      "Strong Single rollout provider evidence closure is invalid");
    });

    const rolloutByHash = new Map(rolloutRows.map((row) => [text(row, "record_sha256"), row]));
    const workloadBindingRows = tableExists(this.connection, "strong_single_workload_bindings_v1")
      ? this.connection.prepare(`SELECT * FROM strong_single_workload_bindings_v1
        ORDER BY created_event_sequence,strong_single_workload_binding_id`).all() as Record<string, unknown>[]
      : [];
    const workloadBindingByHash = new Map<string, StrongSingleWorkloadBindingV1>();
    for (const row of workloadBindingRows) check(() => {
      const binding = strongSingleWorkloadBindingFromRow(row);
      const rollout = rolloutByHash.get(binding.source_rollout_receipt_sha256);
      requireIntegrity(Boolean(rollout)
        && rollout!.rollout_receipt_id === binding.source_rollout_receipt_id
        && rollout!.goal_id === binding.source_goal_id
        && rollout!.run_id === binding.source_run_id
        && rollout!.work_cell_id === binding.source_work_cell_id
        && integer(rollout!, "topology_revision") === binding.source_topology_revision
        && rollout!.topology_revision_sha256 === binding.source_topology_revision_sha256
        && integer(rollout!, "completed_at_ms") === binding.created_at_ms,
      "Strong Single workload binding rollout closure is invalid");
      const event = this.connection.prepare("SELECT payload_json FROM events WHERE goal_id=? AND sequence=?").get(
        binding.source_goal_id, integer(row, "created_event_sequence"),
      ) as Record<string, unknown> | undefined;
      const payload = event ? json<Record<string, unknown>>(event, "payload_json") : null;
      requireIntegrity(payload?.workloadBindingSha256 === binding.record_sha256,
        "Strong Single workload binding event is invalid");
      workloadBindingByHash.set(binding.record_sha256, binding);
    });

    const comparabilityRows = tableExists(this.connection, "workload_comparability_receipts_v1")
      ? this.connection.prepare(`SELECT * FROM workload_comparability_receipts_v1
        ORDER BY created_event_sequence,workload_comparability_receipt_id`).all() as Record<string, unknown>[]
      : [];
    const comparabilityByHash = new Map<string, WorkloadComparabilityReceiptV1>();
    for (const row of comparabilityRows) check(() => {
      const source = workloadBindingByHash.get(text(row, "source_binding_sha256"));
      requireIntegrity(Boolean(source), "Workload comparability source binding is invalid");
      const workload = finalizeComparableWorkloadV1(Object.fromEntries(
        comparableWorkloadDimensionsV1.map((field) => [field, text(row, field)]),
      ) as unknown as Parameters<typeof finalizeComparableWorkloadV1>[0]);
      requireIntegrity(workload.workload_key_sha256 === text(row, "workload_key_sha256")
        && workload.workload_key_sha256 === text(row, "source_workload_key_sha256")
        && workload.workload_key_sha256 === text(row, "current_workload_key_sha256"),
      "Workload comparability key closure is invalid");
      const receipt = finalizeWorkloadComparabilityReceiptV1({
        target_goal_id: text(row, "target_goal_id"), target_run_id: text(row, "target_run_id"),
        target_work_cell_id: text(row, "target_work_cell_id"),
        target_plan_revision_id: text(row, "target_plan_revision_id"),
        target_plan_revision_sha256: text(row, "target_plan_revision_sha256"),
        target_topology_revision: integer(row, "target_topology_revision"),
        target_topology_revision_sha256: text(row, "target_topology_revision_sha256"),
        target_authorization_id: text(row, "target_authorization_id"),
        target_authorization_sha256: text(row, "target_authorization_sha256"),
        target_baseline_sha256: text(row, "target_baseline_sha256"),
        target_input_closure_sha256: text(row, "target_input_closure_sha256"),
        source: source!, current_workload: workload,
        predecessor_authority_head_sha256: text(row, "predecessor_authority_head_sha256"),
        created_at_ms: integer(row, "created_at_ms"),
      });
      requireIntegrity(receipt.workload_comparability_receipt_id === text(row, "workload_comparability_receipt_id")
        && receipt.record_sha256 === text(row, "record_sha256"),
      "Workload comparability receipt hash is invalid");
      const event = this.connection.prepare("SELECT payload_json FROM events WHERE goal_id=? AND sequence=?").get(
        receipt.target_goal_id, integer(row, "created_event_sequence"),
      ) as Record<string, unknown> | undefined;
      const payload = event ? json<Record<string, unknown>>(event, "payload_json") : null;
      requireIntegrity(payload?.comparabilitySha256 === receipt.record_sha256,
        "Workload comparability event is invalid");
      comparabilityByHash.set(receipt.record_sha256, receipt);
    });

    const evidenceRows = this.connection.prepare(`SELECT * FROM topology_measurement_evidence_receipts_v2
      ORDER BY created_event_sequence,topology_measurement_evidence_receipt_id`).all() as Record<string, unknown>[];
    const measurementEvidence = new Map<string, TopologyMeasurementEvidenceReceiptV2>();
    for (const row of evidenceRows) check(() => {
      const receipt = topologyMeasurementEvidenceFromRow(row);
      const sequence = integer(row, "created_event_sequence");
      const event = this.connection.prepare("SELECT event_type,payload_json FROM events WHERE goal_id=? AND sequence=?")
        .get(receipt.goal_id, sequence) as Record<string, unknown> | undefined;
      const payload = event ? json<Record<string, unknown>>(event, "payload_json") : null;
      requireIntegrity(event?.event_type === "TOPOLOGY_MEASUREMENTS_RECORDED"
        && Array.isArray(payload?.measurementEvidenceSha256s)
        && payload.measurementEvidenceSha256s.includes(receipt.record_sha256),
      "Topology measurement source evidence event is invalid");
      assertPredecessor(receipt.goal_id, sequence, receipt.predecessor_authority_head_sha256);
      measurementEvidence.set(receipt.record_sha256, receipt);
    });

    const measurementRows = this.connection.prepare(`SELECT * FROM topology_measurement_receipts_v2
      ORDER BY created_event_sequence,topology_measurement_receipt_id`).all() as Record<string, unknown>[];
    const measurements = new Map<string, TopologyMeasurementReceiptV2>();
    for (const row of measurementRows) check(() => {
      const receipt = topologyMeasurementFromRow(row);
      const sequence = integer(row, "created_event_sequence");
      const event = this.connection.prepare("SELECT event_type,payload_json FROM events WHERE goal_id=? AND sequence=?")
        .get(receipt.goal_id, sequence) as Record<string, unknown> | undefined;
      const payload = event ? json<Record<string, unknown>>(event, "payload_json") : null;
      requireIntegrity(event?.event_type === "TOPOLOGY_MEASUREMENTS_RECORDED"
        && Array.isArray(payload?.measurementSha256s)
        && payload.measurementSha256s.includes(receipt.record_sha256),
      "Topology measurement event evidence is invalid");
      const source = measurementEvidence.get(receipt.source_evidence_sha256);
      requireIntegrity(Boolean(source)
        && source!.kind === receipt.kind
        && source!.goal_id === receipt.goal_id && source!.run_id === receipt.run_id
        && source!.work_cell_id === receipt.work_cell_id
        && source!.plan_revision_id === receipt.plan_revision_id
        && source!.plan_revision_sha256 === receipt.plan_revision_sha256
        && source!.input_closure_sha256 === receipt.input_closure_sha256
        && source!.runtime_fingerprint_sha256 === receipt.runtime_fingerprint_sha256
        && source!.config_sha256 === receipt.config_sha256
        && source!.baseline_sha256 === receipt.baseline_sha256
        && source!.baseline_content_root_sha256 === receipt.baseline_content_root_sha256
        && source!.environment_sha256 === receipt.environment_sha256
        && source!.graph_proposal_sha256 === receipt.graph_proposal_sha256
        && source!.correctness === receipt.correctness
        && source!.quality_basis_points === receipt.quality_basis_points
        && source!.wall_time_ms === receipt.wall_time_ms
        && source!.provider_requests === receipt.provider_requests
        && source!.input_tokens === receipt.input_tokens && source!.output_tokens === receipt.output_tokens
        && source!.user_interventions === receipt.user_interventions
        && source!.safety_events === receipt.safety_events
        && source!.observed_at_ms === receipt.observed_at_ms,
      "Topology measurement source evidence closure is invalid");
      assertPredecessor(receipt.goal_id, sequence, receipt.predecessor_authority_head_sha256);
      measurements.set(receipt.record_sha256, receipt);
    });

    const baselineRows = this.connection.prepare("SELECT * FROM strong_single_baselines_v2")
      .all() as Record<string, unknown>[];
    for (const row of baselineRows) check(() => {
      const receipt = measurements.get(text(row, "evidence_sha256"));
      requireIntegrity(Boolean(receipt) && receipt!.kind === "STRONG_SINGLE"
        && receipt!.goal_id === text(row, "goal_id")
        && receipt!.plan_revision_id === text(row, "plan_revision_id")
        && receipt!.plan_revision_sha256 === text(row, "plan_revision_sha256")
        && receipt!.input_closure_sha256 === text(row, "input_closure_sha256")
        && receipt!.runtime_fingerprint_sha256 === text(row, "runtime_fingerprint_sha256")
        && receipt!.correctness === text(row, "correctness")
        && receipt!.quality_basis_points === integer(row, "quality_basis_points")
        && receipt!.wall_time_ms === integer(row, "wall_time_ms")
        && receipt!.provider_requests === integer(row, "provider_requests")
        && receipt!.input_tokens === integer(row, "input_tokens")
        && receipt!.output_tokens === integer(row, "output_tokens")
        && receipt!.user_interventions === integer(row, "user_interventions")
        && receipt!.safety_events === integer(row, "safety_events")
        && receipt!.observed_at_ms === integer(row, "observed_at_ms"),
      "Strong Single baseline provenance is invalid");
    });

    const candidateRows = this.connection.prepare("SELECT * FROM dynamic_multi_candidates_v2")
      .all() as Record<string, unknown>[];
    for (const row of candidateRows) check(() => {
      const receipt = measurements.get(text(row, "simulator_receipt_sha256"));
      requireIntegrity(Boolean(receipt) && receipt!.kind === "DYNAMIC_MULTI_SIMULATION"
        && receipt!.correctness === "PASS"
        && receipt!.goal_id === text(row, "goal_id")
        && receipt!.plan_revision_id === text(row, "plan_revision_id")
        && receipt!.plan_revision_sha256 === text(row, "plan_revision_sha256")
        && receipt!.input_closure_sha256 === text(row, "input_closure_sha256")
        && receipt!.runtime_fingerprint_sha256 === text(row, "runtime_fingerprint_sha256")
        && receipt!.graph_proposal_sha256 === text(row, "graph_sha256")
        && receipt!.quality_basis_points === integer(row, "estimated_quality_basis_points")
        && receipt!.wall_time_ms === integer(row, "estimated_wall_time_ms")
        && receipt!.provider_requests === integer(row, "estimated_provider_requests")
        && receipt!.input_tokens === integer(row, "estimated_input_tokens")
        && receipt!.output_tokens === integer(row, "estimated_output_tokens")
        && receipt!.user_interventions === integer(row, "estimated_user_interventions")
        && receipt!.safety_events === integer(row, "estimated_safety_events")
        && receipt!.observed_at_ms === integer(row, "estimated_at_ms"),
      "Dynamic Multi candidate provenance is invalid");
    });

    const graphRows = this.connection.prepare(
      "SELECT * FROM execution_graph_revisions_v2 ORDER BY execution_graph_revision_id",
    ).all() as Record<string, unknown>[];
    const graphs = new Map<string, ExecutionGraphRevisionV2>();
    for (const row of graphRows) check(() => {
      const graph = this.readGraph(text(row, "execution_graph_revision_id"));
      requireIntegrity(Boolean(graph), "Execution graph is missing");
      graphs.set(graph!.execution_graph_revision_id, graph!);
      const sequence = integer(row, "created_event_sequence");
      assertEvent(graph!.goal_id, sequence, "EXECUTION_GRAPH_COMMITTED", {
        graphId: graph!.execution_graph_revision_id,
        graphSha256: graph!.record_sha256,
        nodeRootSha256: graph!.node_root_sha256,
        edgeRootSha256: graph!.edge_root_sha256,
      });
      assertPredecessor(graph!.goal_id, sequence, graph!.predecessor_authority_head_sha256);
    });

    const packetRows = this.connection.prepare("SELECT * FROM task_packets_v2 ORDER BY packet_id")
      .all() as Record<string, unknown>[];
    const providerInvocationAvailable = tableExists(this.connection, "provider_call_plans_v1");
    const packets = new Map<string, TaskPacketV2>();
    for (const row of packetRows) check(() => {
      const packet = taskPacketFromRow(row);
      const graph = graphs.get(packet.graph_revision_id);
      const node = graph?.nodes.find((entry) => entry.node_id === packet.node_id);
      requireIntegrity(Boolean(graph) && Boolean(node), "TaskPacket graph or node is missing");
      requireIntegrity(packet.goal_id === graph!.goal_id && packet.run_id === graph!.run_id
        && packet.work_cell_id === graph!.work_cell_id && packet.graph_revision_sha256 === graph!.record_sha256
        && packet.node_spec_sha256 === node!.record_sha256
        && packet.task === node!.task
        && sameJson(packet.requirement_ids, node!.requirement_ids)
        && sameJson(packet.obligation_ids, node!.obligation_ids)
        && packet.output_schema_sha256 === node!.output_schema_sha256
        && packet.oracle_sha256 === node!.oracle_sha256
        && packet.provider_profile_sha256 === node!.provider_profile_sha256
        && packet.plan_revision_sha256 === graph!.plan_revision_sha256
        && packet.topology_gate_receipt_sha256 === graph!.topology_gate_receipt_sha256
        && packet.authorization_sha256 === graph!.authorization_sha256
        && packet.baseline_sha256 === graph!.baseline_sha256
        && packet.baseline_content_root_sha256 === graph!.baseline_content_root_sha256
        && packet.environment_sha256 === graph!.environment_sha256
        && packet.input_closure_sha256 === node!.input_closure_sha256
        && packet.oracle_set_sha256 === graph!.oracle_set_sha256
        && packet.config_sha256 === graph!.config_sha256
        && packet.runtime_fingerprint_sha256 === graph!.runtime_fingerprint_sha256
        && packet.stop_generation === graph!.stop_generation
        && packet.effect_ceiling === node!.effect_ceiling && packet.privacy_class === node!.privacy_class
        && sameJson(packet.capabilities, node!.capabilities) && sameJson(packet.read_roots, node!.read_roots)
        && sameJson(packet.write_roots, node!.write_roots) && sameJson(packet.taint_classes, node!.taint_classes)
        && sameJson(packet.exact_input_refs, node!.exact_input_refs)
        && sameJson(packet.decision_refs, node!.decision_refs)
        && (providerInvocationAvailable
          ? packet.provider_call_plan_id !== null && packet.provider_call_plan_sha256 !== null
          : packet.provider_call_plan_id === node!.provider_call_plan_id
            && packet.provider_call_plan_sha256 === node!.provider_call_plan_sha256),
      "TaskPacket does not rebuild from its graph closure");
      assertEvent(packet.goal_id, integer(row, "created_event_sequence"), "EXECUTION_NODE_LEASED", {
        graphId: packet.graph_revision_id, nodeId: packet.node_id, packetId: packet.packet_id,
      });
      packets.set(packet.packet_id, packet);
    });

    const leaseRows = this.connection.prepare("SELECT * FROM execution_node_leases_v2 ORDER BY execution_node_lease_id")
      .all() as Record<string, unknown>[];
    const leases = new Map<string, ExecutionNodeLeaseV2>();
    for (const row of leaseRows) check(() => {
      const lease = nodeLeaseFromRow(row);
      const packet = packets.get(lease.packet_id);
      requireIntegrity(Boolean(packet) && lease.goal_id === packet!.goal_id && lease.run_id === packet!.run_id
        && lease.graph_revision_id === packet!.graph_revision_id
        && lease.graph_revision_sha256 === packet!.graph_revision_sha256
        && lease.node_id === packet!.node_id && lease.node_spec_sha256 === packet!.node_spec_sha256
        && lease.packet_sha256 === packet!.packet_sha256 && lease.generation === packet!.lease_generation
        && lease.fencing_token === packet!.fencing_token && lease.stop_generation === packet!.stop_generation,
      "Execution node lease does not rebuild from its TaskPacket");
      assertEvent(lease.goal_id, integer(row, "created_event_sequence"), "EXECUTION_NODE_LEASED", {
        graphId: lease.graph_revision_id, nodeId: lease.node_id, packetId: lease.packet_id,
        leaseId: lease.execution_node_lease_id, generation: lease.generation, fencingToken: lease.fencing_token,
      });
      leases.set(lease.execution_node_lease_id, lease);
    });

    const outcomeRows = this.connection.prepare(
      "SELECT * FROM execution_node_attempt_outcomes_v2 ORDER BY created_event_sequence,execution_node_attempt_outcome_id",
    ).all() as Record<string, unknown>[];
    const outcomes = new Map<string, ExecutionNodeAttemptOutcomeV2>();
    for (const row of outcomeRows) check(() => {
      const outcome: ExecutionNodeAttemptOutcomeV2 = {
        schema_version: 2,
        execution_node_attempt_outcome_id: text(row, "execution_node_attempt_outcome_id"),
        goal_id: text(row, "goal_id"),
        run_id: text(row, "run_id"),
        graph_revision_id: text(row, "execution_graph_revision_id"),
        graph_revision_sha256: text(row, "execution_graph_revision_sha256"),
        node_id: text(row, "node_id"),
        node_spec_sha256: text(row, "node_spec_sha256"),
        packet_id: text(row, "packet_id"),
        packet_sha256: text(row, "packet_sha256"),
        execution_node_lease_id: text(row, "execution_node_lease_id"),
        execution_node_lease_sha256: text(row, "execution_node_lease_sha256"),
        attempt: integer(row, "attempt"),
        lease_generation: integer(row, "lease_generation"),
        fencing_token: integer(row, "fencing_token"),
        stop_generation: integer(row, "stop_generation"),
        basis: text(row, "basis") as ExecutionNodeAttemptOutcomeV2["basis"],
        disposition: text(row, "disposition") as ExecutionNodeAttemptOutcomeV2["disposition"],
        reason_code: text(row, "reason_code"),
        failure_sha256: text(row, "failure_sha256"),
        predecessor_authority_head_sha256: text(row, "predecessor_authority_head_sha256"),
        trust: text(row, "trust") as "HOST_DERIVED",
        created_at_ms: integer(row, "created_at_ms"),
        record_sha256: text(row, "record_sha256"),
      };
      assertExecutionNodeAttemptOutcomeV2(outcome);
      const graph = graphs.get(outcome.graph_revision_id);
      const packet = packets.get(outcome.packet_id);
      const lease = leases.get(outcome.execution_node_lease_id);
      requireIntegrity(Boolean(graph) && Boolean(packet) && Boolean(lease)
        && outcome.goal_id === graph!.goal_id && outcome.run_id === graph!.run_id
        && outcome.graph_revision_sha256 === graph!.record_sha256
        && outcome.node_spec_sha256 === graph!.nodes.find((node) => node.node_id === outcome.node_id)?.record_sha256
        && outcome.packet_sha256 === packet!.packet_sha256
        && outcome.execution_node_lease_sha256 === lease!.record_sha256
        && outcome.lease_generation === lease!.generation && outcome.fencing_token === lease!.fencing_token,
      "Execution node attempt outcome closure is invalid");
      const sequence = integer(row, "created_event_sequence");
      assertEvent(outcome.goal_id, sequence, "EXECUTION_NODE_ATTEMPT_OUTCOME_RECORDED", {
        graphId: outcome.graph_revision_id, nodeId: outcome.node_id,
        outcomeId: outcome.execution_node_attempt_outcome_id, basis: outcome.basis, disposition: outcome.disposition,
        attempt: outcome.attempt, generation: outcome.lease_generation, fencingToken: outcome.fencing_token,
      });
      assertPredecessor(outcome.goal_id, sequence, outcome.predecessor_authority_head_sha256);
      outcomes.set(outcome.execution_node_attempt_outcome_id, outcome);
    });

    const proposalRows = this.connection.prepare("SELECT * FROM worker_proposals_v2 ORDER BY proposal_id")
      .all() as Record<string, unknown>[];
    const proposals = new Map<string, WorkerProposalV2>();
    const proposalSequences = new Map<string, number>();
    for (const row of proposalRows) check(() => {
      const proposal = workerProposalFromRow(row);
      const packet = packets.get(proposal.packet_id);
      requireIntegrity(Boolean(packet) && proposal.goal_id === packet!.goal_id && proposal.run_id === packet!.run_id
        && proposal.graph_revision_id === packet!.graph_revision_id
        && proposal.graph_revision_sha256 === packet!.graph_revision_sha256
        && proposal.node_id === packet!.node_id && proposal.packet_sha256 === packet!.packet_sha256
        && proposal.lease_generation === packet!.lease_generation
        && proposal.fencing_token === packet!.fencing_token && proposal.stop_generation === packet!.stop_generation,
      "Worker proposal does not rebuild from its TaskPacket");
      if (proposal.kind === "PATCH_PROPOSAL") {
        requireIntegrity(packet!.effect_ceiling === "PATCH_PROPOSAL"
          && packet!.capabilities.includes("PATCH_PROPOSE"), "Patch proposal exceeds TaskPacket capability");
      }
      assertEvent(proposal.goal_id, integer(row, "created_event_sequence"), "EXECUTION_WORKER_PROPOSAL_SUBMITTED", {
        graphId: proposal.graph_revision_id, nodeId: proposal.node_id,
        proposalId: proposal.proposal_id, kind: proposal.kind,
      });
      proposals.set(proposal.proposal_id, proposal);
      proposalSequences.set(proposal.proposal_id, integer(row, "created_event_sequence"));
    });

    const patchSetRows = this.connection.prepare("SELECT patch_set_id,proposal_id,record_sha256,created_event_sequence FROM worker_patch_sets_v2 ORDER BY patch_set_id")
      .all() as Record<string, unknown>[];
    const patchSets = new Map<string, WorkerPatchSetClosureV2>();
    const patchSetByProposal = new Map<string, WorkerPatchSetClosureV2>();
    for (const row of patchSetRows) check(() => {
      const closure = this.readWorkerPatchSetClosure(text(row, "patch_set_id"));
      requireIntegrity(Boolean(closure) && closure!.patchSet.record_sha256 === text(row, "record_sha256")
        && closure!.proposalId === text(row, "proposal_id")
        && proposalSequences.get(closure!.proposalId) === integer(row, "created_event_sequence"),
      "Worker PatchSet durable closure is invalid");
      patchSets.set(closure!.patchSet.patch_set_id, closure!);
      requireIntegrity(!patchSetByProposal.has(closure!.proposalId), "Worker proposal has multiple durable PatchSets");
      patchSetByProposal.set(closure!.proposalId, closure!);
    });
    for (const proposal of proposals.values()) requireIntegrity(
      (proposal.kind === "PATCH_PROPOSAL") === patchSetByProposal.has(proposal.proposal_id),
      "Worker proposal and durable PatchSet cardinality differ",
    );

    const attemptRows = this.connection.prepare("SELECT * FROM execution_integration_attempts_v2 ORDER BY run_id,lease_generation")
      .all() as Record<string, unknown>[];
    const attempts = new Map<string, ExecutionIntegrationAttemptV2>();
    const attemptSequences = new Map<string, number>();
    for (const row of attemptRows) check(() => {
      const attempt = integrationAttemptFromRow(row);
      const graph = graphs.get(attempt.graph_revision_id);
      const proposal = proposals.get(attempt.proposal_id);
      const patchSet = patchSets.get(attempt.patch_set_id);
      const node = graph?.nodes.find((entry) => entry.node_id === attempt.node_id);
      const payload = proposal?.payload;
      requireIntegrity(Boolean(graph) && Boolean(node) && proposal?.kind === "PATCH_PROPOSAL"
        && attempt.goal_id === graph!.goal_id && attempt.run_id === graph!.run_id
        && attempt.graph_revision_sha256 === graph!.record_sha256
        && attempt.node_spec_sha256 === node!.record_sha256
        && attempt.proposal_sha256 === proposal.record_sha256
        && attempt.authorization_sha256 === graph!.authorization_sha256
        && patchSet?.patchSet.record_sha256 === attempt.patch_set_sha256
        && patchSet.proposalId === attempt.proposal_id
        && Boolean(payload) && "patch_set_id" in payload! && payload.patch_set_id === attempt.patch_set_id
        && "patch_set_sha256" in payload && payload.patch_set_sha256 === attempt.patch_set_sha256
        && "preimage_root_sha256" in payload
        && payload.preimage_root_sha256 === patchSet.patchSet.baseline_sha256,
      "Integration attempt does not rebuild from its graph and proposal closure");
      attempts.set(attempt.integration_attempt_id, attempt);
      attemptSequences.set(attempt.integration_attempt_id, integer(row, "created_event_sequence"));
    });

    const journalRows = this.connection.prepare(`SELECT integration_attempt_id,created_event_sequence
      FROM execution_integration_journals_v2 ORDER BY integration_attempt_id`).all() as Record<string, unknown>[];
    const journals = new Map<string, ExecutionIntegrationJournalV2>();
    for (const row of journalRows) check(() => {
      const attemptId = text(row, "integration_attempt_id");
      const attempt = attempts.get(attemptId);
      const journal = this.readExecutionIntegrationJournal(attemptId);
      const patchSet = attempt ? patchSets.get(attempt.patch_set_id)?.patchSet : undefined;
      requireIntegrity(Boolean(attempt) && Boolean(journal) && Boolean(patchSet)
        && integer(row, "created_event_sequence") === attemptSequences.get(attemptId)
        && journal!.entries.length === patchSet!.entries.length
        && journal!.entries.every((entry, ordinal) => {
          const patchEntry = patchSet!.entries[ordinal];
          return Boolean(patchEntry) && entry.ordinal === ordinal && entry.path === patchEntry!.path
            && entry.operation === patchEntry!.operation
            && entry.expected_before_sha256 === patchEntry!.before_sha256
            && entry.expected_after_sha256 === patchEntry!.after_sha256
            && entry.byte_length === patchEntry!.byte_length;
        }), "Execution integration journal does not rebuild from its attempt and PatchSet");
      journals.set(attemptId, journal!);
    });
    for (const attempt of attempts.values()) requireIntegrity(
      journals.has(attempt.integration_attempt_id), "Execution integration attempt lacks one durable journal",
    );

    const transitionRows = this.connection.prepare(
      "SELECT * FROM execution_integration_transitions_v2 ORDER BY integration_attempt_id,ordinal",
    ).all() as Record<string, unknown>[];
    const transitions = new Map<string, ExecutionIntegrationTransitionV2>();
    const latestTransitionByAttempt = new Map<string, ExecutionIntegrationTransitionV2>();
    for (const row of transitionRows) check(() => {
      const transition = integrationTransitionFromRow(row);
      const attempt = attempts.get(transition.integration_attempt_id);
      const prior = latestTransitionByAttempt.get(transition.integration_attempt_id);
      requireIntegrity(Boolean(attempt), "Integration transition attempt is missing");
      if (!prior) {
        requireIntegrity(transition.ordinal === 0 && transition.state === "PREPARED"
          && transition.predecessor_transition_sha256 === null
          && transition.created_at_ms === attempt!.created_at_ms,
        "Integration initial transition is invalid");
      } else {
        const allowed = (prior.state === "PREPARED" && ["OBSERVED", "REJECTED", "FENCED"].includes(transition.state))
          || (prior.state === "OBSERVED" && ["COMMITTED", "REJECTED", "FENCED"].includes(transition.state));
        requireIntegrity(transition.ordinal === prior.ordinal + 1
          && transition.predecessor_transition_sha256 === prior.record_sha256
          && transition.created_at_ms >= prior.created_at_ms && allowed,
        "Integration transition chain is invalid");
        if (transition.state === "COMMITTED") {
          requireIntegrity(transition.postimage_root_sha256 === prior.postimage_root_sha256
            && transition.failure_sha256 === null,
          "Committed integration does not preserve its observed canonical postimage");
        }
      }
      if (transition.state === "OBSERVED") requireIntegrity(transition.postimage_root_sha256 !== null
        && transition.failure_sha256 === null,
      "Observed integration evidence is invalid");
      if (transition.state === "REJECTED" || transition.state === "FENCED") requireIntegrity(
        transition.postimage_root_sha256 === null && transition.failure_sha256 !== null,
        "Failed integration evidence is invalid",
      );
      const sequence = integer(row, "created_event_sequence");
      if (transition.ordinal === 0) assertEvent(attempt!.goal_id, sequence, "EXECUTION_INTEGRATION_PREPARED", {
        graphId: attempt!.graph_revision_id, nodeId: attempt!.node_id,
        attemptId: attempt!.integration_attempt_id, transitionId: transition.integration_transition_id,
        journalSha256: journals.get(attempt!.integration_attempt_id)?.journal_sha256,
        generation: attempt!.lease_generation, fencingToken: attempt!.fencing_token,
      });
      else assertEvent(attempt!.goal_id, sequence, "EXECUTION_INTEGRATION_TRANSITIONED", {
        attemptId: attempt!.integration_attempt_id, transitionId: transition.integration_transition_id,
        ordinal: transition.ordinal, state: transition.state,
        postimageRootSha256: transition.postimage_root_sha256,
      });
      transitions.set(transition.integration_transition_id, transition);
      latestTransitionByAttempt.set(transition.integration_attempt_id, transition);
    });
    for (const attempt of attempts.values()) requireIntegrity(
      latestTransitionByAttempt.has(attempt.integration_attempt_id), "Integration attempt has no transition",
    );
    const attemptsByPreimage = new Map<string, ExecutionIntegrationAttemptV2[]>();
    for (const attempt of attempts.values()) {
      const key = `${attempt.run_id}\0${attempt.expected_preimage_root_sha256}`;
      const members = attemptsByPreimage.get(key) ?? [];
      members.push(attempt);
      attemptsByPreimage.set(key, members);
    }
    for (const members of attemptsByPreimage.values()) {
      members.sort((left, right) => left.lease_generation - right.lease_generation);
      for (const prior of members.slice(0, -1)) requireIntegrity(
        latestTransitionByAttempt.get(prior.integration_attempt_id)?.state === "REJECTED",
        "A repeated integration preimage lacks a confirmed rejection",
      );
    }

    const oracleReceiptRows = this.connection.prepare(
      "SELECT * FROM host_oracle_receipts_v2 ORDER BY created_event_sequence,host_oracle_receipt_id",
    ).all() as Record<string, unknown>[];
    const oracleReceiptsBySha = new Map<string, HostOracleReceiptV2>();
    for (const row of oracleReceiptRows) check(() => {
      const graph = graphs.get(text(row, "execution_graph_revision_id"));
      requireIntegrity(Boolean(graph), "Host OracleReceipt graph is missing");
      const memberRows = this.connection.prepare(`SELECT * FROM host_oracle_evidence_members_v2
        WHERE host_oracle_receipt_id=? ORDER BY ordinal`).all(
        text(row, "host_oracle_receipt_id"),
      ) as Record<string, unknown>[];
      requireIntegrity(memberRows.length > 0 && memberRows.every((member, ordinal) =>
        integer(member, "ordinal") === ordinal
        && integer(member, "created_event_sequence") === integer(row, "created_event_sequence")),
      "Host OracleReceipt evidence member sequence is invalid");
      const receipt = hostOracleReceiptFromRows(row, memberRows, graph!);
      const packet = packets.get(receipt.packet_id);
      const proposal = proposals.get(receipt.proposal_id);
      requireIntegrity(Boolean(packet) && Boolean(proposal)
        && receipt.packet_sha256 === packet!.packet_sha256
        && receipt.proposal_sha256 === proposal!.record_sha256
        && receipt.node_id === proposal!.node_id && receipt.node_spec_sha256 === packet!.node_spec_sha256,
      "Host OracleReceipt does not rebuild from packet and proposal closure");
      for (const evidence of receipt.validation_evidence) {
        const authority = this.connection.prepare(`SELECT p.record_sha256 pass_sha256,p.goal_id,p.work_cell_id,
            p.evidence_requirement_id,p.attempt_id,p.terminal_transition_id,p.terminal_transition_sha256,
            p.authorization_sha256,p.postimage_root_sha256,p.environment_sha256,
            a.record_sha256 attempt_sha256,a.operation_kind,a.oracle_sha256,
            t.transition_sha256,t.state,t.postcondition,o.task_obligation_id
          FROM oracle_pass_receipts_v2 p
          JOIN operation_attempts_v1 a ON a.attempt_id=p.attempt_id
          JOIN operation_transitions_v1 t ON t.transition_id=p.terminal_transition_id AND t.attempt_id=a.attempt_id
          JOIN evidence_requirements_v2 r ON r.evidence_requirement_id=p.evidence_requirement_id
          JOIN facet_obligation_bindings_v2 b ON b.binding_id=r.binding_id
          JOIN acceptance_obligations_v2 o ON o.acceptance_obligation_id=b.acceptance_obligation_id
          WHERE p.pass_receipt_id=?`).get(evidence.oracle_pass_receipt_id) as Record<string, unknown> | undefined;
        requireIntegrity(Boolean(authority)
          && text(authority!, "pass_sha256") === evidence.oracle_pass_receipt_sha256
          && text(authority!, "goal_id") === receipt.goal_id
          && text(authority!, "work_cell_id") === graph!.work_cell_id
          && text(authority!, "evidence_requirement_id") === evidence.evidence_requirement_id
          && text(authority!, "attempt_id") === evidence.operation_attempt_id
          && text(authority!, "attempt_sha256") === evidence.operation_attempt_sha256
          && text(authority!, "terminal_transition_id") === evidence.terminal_transition_id
          && text(authority!, "terminal_transition_sha256") === evidence.terminal_transition_sha256
          && text(authority!, "transition_sha256") === evidence.terminal_transition_sha256
          && text(authority!, "authorization_sha256") === graph!.authorization_sha256
          && text(authority!, "postimage_root_sha256") === receipt.postimage_root_sha256
          && text(authority!, "environment_sha256") === receipt.environment_sha256
          && text(authority!, "operation_kind") === "VALIDATION"
          && text(authority!, "oracle_sha256") === receipt.oracle_sha256
          && ["COMMITTED", "RECONCILED"].includes(text(authority!, "state"))
          && text(authority!, "postcondition") === "PASS"
          && text(authority!, "task_obligation_id") === evidence.obligation_id,
        "Host OracleReceipt evidence authority is invalid");
      }
      const sequence = integer(row, "created_event_sequence");
      assertEvent(receipt.goal_id, sequence, "EXECUTION_HOST_ORACLE_RECEIPT_RECORDED", {
        graphId: receipt.graph_revision_id, nodeId: receipt.node_id,
        oracleReceiptId: receipt.host_oracle_receipt_id, oracleReceiptSha256: receipt.record_sha256,
        result: receipt.result, freshness: receipt.freshness,
      });
      assertPredecessor(receipt.goal_id, sequence, receipt.predecessor_authority_head_sha256);
      oracleReceiptsBySha.set(receipt.record_sha256, receipt);
    });

    const receiptRows = this.connection.prepare("SELECT * FROM host_node_receipts_v2 ORDER BY created_event_sequence,host_node_receipt_id")
      .all() as Record<string, unknown>[];
    const receipts = new Map<string, HostNodeReceiptV2>();
    for (const row of receiptRows) check(() => {
      const graph = graphs.get(text(row, "execution_graph_revision_id"));
      requireIntegrity(Boolean(graph), "Host receipt graph is missing");
      const receipt = hostReceiptFromRow(row, graph!);
      const packet = packets.get(receipt.packet_id);
      const proposal = proposals.get(receipt.proposal_id);
      requireIntegrity(Boolean(packet) && Boolean(proposal)
        && receipt.packet_sha256 === packet!.packet_sha256
        && receipt.proposal_sha256 === proposal!.record_sha256
        && receipt.node_id === proposal!.node_id && receipt.node_spec_sha256 === packet!.node_spec_sha256,
      "Host receipt does not rebuild from packet and proposal closure");
      if (receipt.kind === "PATCH_INTEGRATED") {
        const attempt = [...attempts.values()].find((entry) => entry.proposal_id === receipt.proposal_id);
        const transition = attempt ? latestTransitionByAttempt.get(attempt.integration_attempt_id) : undefined;
        requireIntegrity(transition?.state === "COMMITTED"
          && receipt.preimage_root_sha256 === attempt!.expected_preimage_root_sha256
          && receipt.postimage_root_sha256 === transition.postimage_root_sha256,
        "Patch Host receipt does not bind the committed serial integration");
      }
      if (receipt.kind === "ORACLE_PASSED") {
        const oracle = oracleReceiptsBySha.get(receipt.evidence_sha256);
        requireIntegrity(Boolean(oracle) && oracle!.goal_id === receipt.goal_id && oracle!.run_id === receipt.run_id
          && oracle!.graph_revision_id === receipt.graph_revision_id && oracle!.node_id === receipt.node_id
          && oracle!.packet_id === receipt.packet_id && oracle!.packet_sha256 === receipt.packet_sha256
          && oracle!.proposal_id === receipt.proposal_id && oracle!.proposal_sha256 === receipt.proposal_sha256
          && oracle!.stop_generation === receipt.stop_generation,
        "ORACLE_PASSED Host receipt lacks its Host OracleReceipt closure");
      }
      const sequence = integer(row, "created_event_sequence");
      assertEvent(receipt.goal_id, sequence, "EXECUTION_HOST_RECEIPT_RECORDED", {
        graphId: receipt.graph_revision_id, nodeId: receipt.node_id,
        receiptId: receipt.host_node_receipt_id, kind: receipt.kind,
      });
      assertPredecessor(receipt.goal_id, sequence, receipt.predecessor_authority_head_sha256);
      receipts.set(receipt.host_node_receipt_id, receipt);
    });

    const stopRows = this.connection.prepare("SELECT * FROM execution_stops_v2 ORDER BY run_id,stop_generation")
      .all() as Record<string, unknown>[];
    const stops = new Map<string, ExecutionStopV2>();
    for (const row of stopRows) check(() => {
      const members = this.connection.prepare(`SELECT node_id FROM execution_stop_node_members_v2
        WHERE execution_stop_id=? ORDER BY ordinal`).all(text(row, "execution_stop_id")) as Record<string, unknown>[];
      const stop: ExecutionStopV2 = {
        schema_version: 2,
        execution_stop_id: text(row, "execution_stop_id"),
        goal_id: text(row, "goal_id"),
        run_id: text(row, "run_id"),
        graph_revision_id: text(row, "execution_graph_revision_id"),
        graph_revision_sha256: text(row, "execution_graph_revision_sha256"),
        stop_generation: integer(row, "stop_generation"),
        scope: text(row, "scope") as ExecutionStopV2["scope"],
        reason: text(row, "reason") as ExecutionStopV2["reason"],
        affected_node_ids: members.map((member) => text(member, "node_id")),
        affected_node_root_sha256: text(row, "affected_node_root_sha256"),
        predecessor_authority_head_sha256: text(row, "predecessor_authority_head_sha256"),
        created_at_ms: integer(row, "created_at_ms"),
        record_sha256: text(row, "record_sha256"),
      };
      assertExecutionStopV2(stop);
      const graph = graphs.get(stop.graph_revision_id);
      requireIntegrity(Boolean(graph) && stop.goal_id === graph!.goal_id && stop.run_id === graph!.run_id
        && stop.graph_revision_sha256 === graph!.record_sha256,
      "Execution stop does not bind its graph");
      const sequence = integer(row, "created_event_sequence");
      assertEvent(stop.goal_id, sequence, "EXECUTION_STOPPED", {
        graphId: stop.graph_revision_id, stopId: stop.execution_stop_id,
        stopGeneration: stop.stop_generation, scope: stop.scope, reason: stop.reason,
      });
      assertPredecessor(stop.goal_id, sequence, stop.predecessor_authority_head_sha256);
      stops.set(stop.execution_stop_id, stop);
    });

    const terminalRows = this.connection.prepare(`SELECT * FROM execution_graph_terminal_receipts_v2
      ORDER BY created_event_sequence,execution_graph_terminal_receipt_id`).all() as Record<string, unknown>[];
    const terminalsByRun = new Map<string, ExecutionGraphTerminalReceiptV2>();
    for (const row of terminalRows) check(() => {
      const memberRows = this.connection.prepare(`SELECT * FROM execution_graph_terminal_node_members_v2
        WHERE execution_graph_terminal_receipt_id=? ORDER BY ordinal`).all(
        text(row, "execution_graph_terminal_receipt_id"),
      ) as Record<string, unknown>[];
      const members: ExecutionGraphTerminalNodeV2[] = memberRows.map((member, ordinal) => {
        requireIntegrity(integer(member, "ordinal") === ordinal
          && integer(member, "created_event_sequence") === integer(row, "created_event_sequence"),
        "Execution graph terminal member sequence is invalid");
        return {
          schema_version: 2,
          node_id: text(member, "node_id"),
          status: text(member, "status") as ExecutionGraphTerminalNodeV2["status"],
          evidence_sha256: text(member, "evidence_sha256"),
          record_sha256: text(member, "record_sha256"),
        };
      });
      const receipt: ExecutionGraphTerminalReceiptV2 = {
        schema_version: 2,
        execution_graph_terminal_receipt_id: text(row, "execution_graph_terminal_receipt_id"),
        goal_id: text(row, "goal_id"),
        run_id: text(row, "run_id"),
        graph_revision_id: text(row, "execution_graph_revision_id"),
        graph_revision_sha256: text(row, "execution_graph_revision_sha256"),
        terminal_status: text(row, "terminal_status") as ExecutionGraphTerminalReceiptV2["terminal_status"],
        reason_code: text(row, "reason_code"),
        current_postimage_root_sha256: text(row, "current_postimage_root_sha256"),
        integration_frontier_sha256: text(row, "integration_frontier_sha256"),
        node_frontier: members,
        node_frontier_root_sha256: text(row, "node_frontier_root_sha256"),
        failure_evidence_sha256: nullableText(row, "failure_evidence_sha256"),
        predecessor_authority_head_sha256: text(row, "predecessor_authority_head_sha256"),
        trust: text(row, "trust") as "HOST_DERIVED",
        created_at_ms: integer(row, "created_at_ms"),
        record_sha256: text(row, "record_sha256"),
      };
      const graph = graphs.get(receipt.graph_revision_id);
      requireIntegrity(Boolean(graph), "Execution graph terminal receipt graph is missing");
      assertExecutionGraphTerminalReceiptV2(receipt, graph!);
      const integration = this.connection.prepare("SELECT * FROM execution_integration_heads_v2 WHERE run_id=?")
        .get(receipt.run_id) as Record<string, unknown> | undefined;
      requireIntegrity(Boolean(integration)
        && integrationFrontierSha256(integration!) === receipt.integration_frontier_sha256
        && text(integration!, "current_postimage_root_sha256") === receipt.current_postimage_root_sha256,
      "Execution graph terminal integration frontier is invalid");
      const latestIntegrationSequence = integration!.latest_transition_sha256 === null ? 0 : integer(
        transitionRows.find((transition) =>
          transition.record_sha256 === integration!.latest_transition_sha256) ?? {},
        "created_event_sequence",
      );
      for (const member of members) {
        const head = this.connection.prepare(`SELECT status,latest_host_receipt_id,latest_host_receipt_sha256
          FROM execution_node_heads_v2
          WHERE execution_graph_revision_id=? AND node_id=?`).get(
          receipt.graph_revision_id, member.node_id,
        ) as Record<string, unknown> | undefined;
        requireIntegrity(Boolean(head) && text(head!, "status") === member.status,
        "Execution graph terminal node frontier is stale");
        if (["ORACLE_PASSED", "REJECTED"].includes(member.status)) {
          requireIntegrity(head!.latest_host_receipt_sha256 === member.evidence_sha256,
          "Execution graph terminal node receipt is stale");
          if (member.status === "ORACLE_PASSED") {
            const nodeReceipt = receipts.get(text(head!, "latest_host_receipt_id"));
            const oracle = nodeReceipt ? oracleReceiptsBySha.get(nodeReceipt.evidence_sha256) : undefined;
            const oracleRow = oracle ? oracleReceiptRows.find((entry) => entry.record_sha256 === oracle.record_sha256) : undefined;
            requireIntegrity(Boolean(oracle) && oracle!.postimage_root_sha256 === receipt.current_postimage_root_sha256
              && integer(oracleRow ?? {}, "created_event_sequence") > latestIntegrationSequence,
            "Execution graph terminal node oracle is not fresh for the integration frontier");
          }
        } else if (member.status === "FAILED") {
          const outcome = [...outcomes.values()].find((candidate) => candidate.graph_revision_id === receipt.graph_revision_id
            && candidate.node_id === member.node_id && candidate.record_sha256 === member.evidence_sha256
            && candidate.disposition !== "REQUEUED");
          requireIntegrity(Boolean(outcome), "Execution graph terminal failure outcome is missing");
        } else if (member.status === "STOPPED") {
          const stop = [...stops.values()].find((candidate) => candidate.graph_revision_id === receipt.graph_revision_id
            && candidate.record_sha256 === member.evidence_sha256 && candidate.affected_node_ids.includes(member.node_id));
          requireIntegrity(Boolean(stop), "Execution graph terminal stop evidence is missing");
        }
      }
      const sequence = integer(row, "created_event_sequence");
      assertEvent(receipt.goal_id, sequence, "EXECUTION_GRAPH_TERMINAL_RECORDED", {
        graphId: receipt.graph_revision_id,
        terminalReceiptId: receipt.execution_graph_terminal_receipt_id,
        terminalStatus: receipt.terminal_status,
        nodeFrontierRootSha256: receipt.node_frontier_root_sha256,
      });
      assertPredecessor(receipt.goal_id, sequence, receipt.predecessor_authority_head_sha256);
      requireIntegrity(!terminalsByRun.has(receipt.run_id), "Execution graph has multiple terminal receipts");
      terminalsByRun.set(receipt.run_id, receipt);
    });

    const graphHeadRows = this.connection.prepare("SELECT * FROM execution_graph_heads_v2 ORDER BY run_id")
      .all() as Record<string, unknown>[];
    const graphHeads = new Map<string, Record<string, unknown>>();
    for (const head of graphHeadRows) check(() => {
      const graph = graphs.get(text(head, "execution_graph_revision_id"));
      requireIntegrity(Boolean(graph) && head.run_id === graph!.run_id && head.goal_id === graph!.goal_id
        && head.work_cell_id === graph!.work_cell_id
        && head.execution_graph_revision_sha256 === graph!.record_sha256
        && integer(head, "graph_revision") === graph!.graph_revision,
      "Execution graph head hash closure is invalid");
      const runStops = [...stops.values()].filter((stop) => stop.run_id === graph!.run_id);
      const latestStop = runStops.sort((left, right) => right.stop_generation - left.stop_generation)[0];
      const terminal = terminalsByRun.get(graph!.run_id);
      requireIntegrity(terminal
        ? head.status === terminal.terminal_status
          && head.terminal_receipt_id === terminal.execution_graph_terminal_receipt_id
          && head.terminal_receipt_sha256 === terminal.record_sha256
          && integer(head, "stop_generation") === (latestStop?.stop_generation ?? graph!.stop_generation)
        : latestStop
          ? head.status === (latestStop.scope === "GRAPH_STOP" ? "STOPPED" : "RUNNING")
            && head.terminal_receipt_id === null && head.terminal_receipt_sha256 === null
            && integer(head, "stop_generation") === latestStop.stop_generation
          : head.status === "RUNNING" && head.terminal_receipt_id === null && head.terminal_receipt_sha256 === null
            && integer(head, "stop_generation") === graph!.stop_generation,
      "Execution graph head status frontier is invalid");
      graphHeads.set(text(head, "run_id"), head);
    });

    const nodeHeadRows = this.connection.prepare("SELECT * FROM execution_node_heads_v2 ORDER BY execution_graph_revision_id,node_id")
      .all() as Record<string, unknown>[];
    for (const head of nodeHeadRows) check(() => {
      const graph = graphs.get(text(head, "execution_graph_revision_id"));
      requireIntegrity(Boolean(graph?.nodes.some((node) => node.node_id === head.node_id)), "Execution node head node is missing");
      const nodePackets = packetRows.filter((row) => row.execution_graph_revision_id === head.execution_graph_revision_id
        && row.node_id === head.node_id).sort((left, right) => integer(left, "created_event_sequence") - integer(right, "created_event_sequence"));
      const nodeProposals = proposalRows.filter((row) => row.execution_graph_revision_id === head.execution_graph_revision_id
        && row.node_id === head.node_id).sort((left, right) => integer(left, "created_event_sequence") - integer(right, "created_event_sequence"));
      const nodeReceipts = receiptRows.filter((row) => row.execution_graph_revision_id === head.execution_graph_revision_id
        && row.node_id === head.node_id).sort((left, right) => integer(left, "created_event_sequence") - integer(right, "created_event_sequence"));
      const latestPacket = nodePackets.at(-1);
      const latestProposal = nodeProposals.at(-1);
      const latestReceipt = nodeReceipts.at(-1);
      const nodeStop = [...stops.values()].filter((stop) => stop.graph_revision_id === head.execution_graph_revision_id
        && stop.affected_node_ids.includes(text(head, "node_id")))
        .sort((left, right) => right.stop_generation - left.stop_generation)[0];
      if (nodeStop) {
        const preservedSuccess = nodeStop.scope === "GRAPH_STOP" && head.status === "ORACLE_PASSED";
        requireIntegrity(integer(head, "attempt_count") === nodePackets.length
          && integer(head, "stop_generation") === nodeStop.stop_generation
          && (preservedSuccess
            ? Boolean(latestPacket) && head.latest_packet_id === latestPacket!.packet_id
              && head.latest_packet_sha256 === latestPacket!.packet_sha256
              && Boolean(latestProposal) && head.latest_proposal_id === latestProposal!.proposal_id
              && head.latest_proposal_sha256 === latestProposal!.record_sha256
              && Boolean(latestReceipt) && head.latest_host_receipt_id === latestReceipt!.host_node_receipt_id
              && head.latest_host_receipt_sha256 === latestReceipt!.record_sha256
            : head.status === (nodeStop.scope === "GRAPH_STOP" ? "STOPPED" : "INVALIDATED")
              && head.latest_packet_id === null && head.latest_packet_sha256 === null
              && head.latest_proposal_id === null && head.latest_proposal_sha256 === null
              && head.latest_host_receipt_id === null && head.latest_host_receipt_sha256 === null),
        "Execution invalidated node head closure is invalid");
      } else {
        requireIntegrity(integer(head, "attempt_count") === nodePackets.length
          && (latestPacket ? head.latest_packet_id === latestPacket.packet_id
            && head.latest_packet_sha256 === latestPacket.packet_sha256
            : head.latest_packet_id === null && head.latest_packet_sha256 === null)
          && (latestProposal ? head.latest_proposal_id === latestProposal.proposal_id
            && head.latest_proposal_sha256 === latestProposal.record_sha256
            : head.latest_proposal_id === null && head.latest_proposal_sha256 === null)
          && (latestReceipt ? head.latest_host_receipt_id === latestReceipt.host_node_receipt_id
            && head.latest_host_receipt_sha256 === latestReceipt.record_sha256
            : head.latest_host_receipt_id === null && head.latest_host_receipt_sha256 === null),
        "Execution node head hash closure is invalid");
      }
    });

    const leaseHeadRows = this.connection.prepare("SELECT * FROM execution_node_lease_heads_v2 ORDER BY execution_graph_revision_id,node_id")
      .all() as Record<string, unknown>[];
    for (const head of leaseHeadRows) check(() => {
      const lease = leases.get(text(head, "execution_node_lease_id"));
      requireIntegrity(Boolean(lease) && head.execution_graph_revision_id === lease!.graph_revision_id
        && head.node_id === lease!.node_id && head.execution_node_lease_sha256 === lease!.record_sha256
        && integer(head, "generation") === lease!.generation && integer(head, "fencing_token") === lease!.fencing_token
        && integer(head, "stop_generation") === lease!.stop_generation && head.owner_hmac === lease!.owner_hmac
        && integer(head, "expires_at_ms") === lease!.expires_at_ms,
      "Execution node lease head hash closure is invalid");
    });

    const integrationHeadRows = this.connection.prepare("SELECT * FROM execution_integration_heads_v2 ORDER BY run_id")
      .all() as Record<string, unknown>[];
    for (const head of integrationHeadRows) check(() => {
      const graphHead = graphHeads.get(text(head, "run_id"));
      requireIntegrity(Boolean(graphHead)
        && head.current_postimage_root_sha256 === graphHead!.current_postimage_root_sha256,
      "Execution integration and graph postimage heads differ");
      if (head.state === "IDLE") {
        const graph = graphs.get(text(graphHead!, "execution_graph_revision_id"));
        requireIntegrity(head.integration_attempt_id === null && head.latest_transition_sha256 === null
          && integer(head, "lease_generation") === 0 && integer(head, "fencing_token") === 0
          && head.current_postimage_root_sha256 === graph?.baseline_content_root_sha256,
        "Idle integration head is invalid");
      } else {
        const attempt = attempts.get(text(head, "integration_attempt_id"));
        const transition = attempt ? latestTransitionByAttempt.get(attempt.integration_attempt_id) : undefined;
        requireIntegrity(Boolean(attempt) && Boolean(transition)
          && head.latest_transition_sha256 === transition!.record_sha256 && head.state === transition!.state
          && integer(head, "lease_generation") === attempt!.lease_generation
          && integer(head, "fencing_token") === attempt!.fencing_token,
        "Execution integration head hash closure is invalid");
        if (transition!.state === "COMMITTED") requireIntegrity(
          head.current_postimage_root_sha256 === transition!.postimage_root_sha256,
          "Committed integration head postimage is invalid",
        );
      }
    });

    if (mismatches > 0) throw new AuthorityIntegrityError(`Execution V2 integrity failed with ${mismatches} mismatch(es)`);
    return {
      available: true,
      strongSingleRollouts: rolloutRows.length,
      strongSingleWorkloadBindings: workloadBindingRows.length,
      workloadComparabilityReceipts: comparabilityRows.length,
      dynamicMultiProposals: dynamicMultiProposalRows.length,
      topologyMeasurementEvidence: count("topology_measurement_evidence_receipts_v2"),
      topologyMeasurements: count("topology_measurement_receipts_v2"),
      graphs: count("execution_graph_revisions_v2"),
      nodes: count("execution_nodes_v2"),
      packets: count("task_packets_v2"),
      leases: count("execution_node_leases_v2"),
      attemptOutcomes: count("execution_node_attempt_outcomes_v2"),
      proposals: count("worker_proposals_v2"),
      patchSets: count("worker_patch_sets_v2"),
      patchArtifacts: count("worker_patch_set_artifacts_v2"),
      hostOracleReceipts: count("host_oracle_receipts_v2"),
      hostOracleEvidence: count("host_oracle_evidence_members_v2"),
      hostReceipts: count("host_node_receipts_v2"),
      integrationAttempts: count("execution_integration_attempts_v2"),
      integrationJournals: count("execution_integration_journals_v2"),
      integrationPreimages: count("execution_integration_preimages_v2"),
      integrationTransitions: count("execution_integration_transitions_v2"),
      stops: count("execution_stops_v2"),
      graphTerminalReceipts: count("execution_graph_terminal_receipts_v2"),
      graphTerminalNodes: count("execution_graph_terminal_node_members_v2"),
      mismatches,
    };
  }
}
