import { canonicalJsonSha256 } from "../authority/canonical-json.js";
import type { ExecutionGraphRevisionV2, ExecutionNodeSpecV2, TaskPacketV2 } from "../harness/execution-v2/domain.js";
import { createTaskPacketV2 } from "../harness/execution-v2/domain.js";
import type { ResolvedWorkerRuntime } from "../harness/worker/runtime-policy.js";
import {
  captureProviderRuntimeProfileV1,
  finalizeProviderCallPlanV1,
  type ProviderAllowedFieldV1,
  type ProviderCallPlanV1,
} from "./domain.js";
import {
  finalizeProviderInvocationPreparedV1,
  finalizeProviderRedactionReceiptV1,
  type ProviderInvocationTransitionV1,
  type ProviderRedactionReceiptV1,
} from "./invocation.js";

export interface WorkerProviderDispatchAuthorityV1 {
  readonly packet: TaskPacketV2;
  readonly redaction: ProviderRedactionReceiptV1;
  readonly plan: ProviderCallPlanV1;
  readonly invocation: ProviderInvocationTransitionV1;
  readonly runtime: ResolvedWorkerRuntime;
}

function allowedFields(node: ExecutionNodeSpecV2, packetId: string): readonly ProviderAllowedFieldV1[] {
  const classification = node.privacy_class;
  return [
    { field_path: "/packet/capabilities", content_sha256: canonicalJsonSha256(node.capabilities), classification },
    { field_path: "/packet/decision_refs", content_sha256: canonicalJsonSha256(node.decision_refs), classification },
    { field_path: "/packet/exact_input_refs", content_sha256: canonicalJsonSha256(node.exact_input_refs), classification },
    { field_path: "/packet/node_id", content_sha256: canonicalJsonSha256(node.node_id), classification },
    { field_path: "/packet/obligation_ids", content_sha256: canonicalJsonSha256(node.obligation_ids), classification },
    { field_path: "/packet/oracle_sha256", content_sha256: canonicalJsonSha256(node.oracle_sha256), classification },
    { field_path: "/packet/output_schema_sha256", content_sha256: canonicalJsonSha256(node.output_schema_sha256), classification },
    { field_path: "/packet/packet_id", content_sha256: canonicalJsonSha256(packetId), classification },
    { field_path: "/packet/provider_profile_sha256", content_sha256: canonicalJsonSha256(node.provider_profile_sha256), classification },
    { field_path: "/packet/read_roots", content_sha256: canonicalJsonSha256(node.read_roots), classification },
    { field_path: "/packet/requirement_ids", content_sha256: canonicalJsonSha256(node.requirement_ids), classification },
    { field_path: "/packet/task", content_sha256: canonicalJsonSha256(node.task), classification },
    { field_path: "/packet/write_roots", content_sha256: canonicalJsonSha256(node.write_roots), classification },
    {
      field_path: "/tool_policy/scoped_mirror_reads",
      content_sha256: canonicalJsonSha256({
        read_roots: node.read_roots,
        exact_input_refs: node.exact_input_refs,
        privacy_class: node.privacy_class,
      }),
      classification,
    },
  ];
}

export function createWorkerProviderDispatchAuthorityV1(input: {
  readonly graph: ExecutionGraphRevisionV2;
  readonly node: ExecutionNodeSpecV2;
  readonly attempt: number;
  readonly leaseGeneration: number;
  readonly fencingToken: number;
  readonly deadlineMs: number;
  readonly createdAtMs: number;
  readonly predecessorAuthorityHeadSha256: string;
  readonly capabilityKey: string;
  readonly runtime: ResolvedWorkerRuntime;
}): WorkerProviderDispatchAuthorityV1 {
  const sourceProfileId = input.runtime.source === "SUPERVISOR_INHERITED"
    ? null : input.runtime.source_profile_id ?? null;
  if ((input.runtime.source === "SUPERVISOR_INHERITED"
      && (input.runtime.fallback_reason !== null || sourceProfileId !== null))
    || (input.runtime.source === "PI_CONFIG"
      && (input.runtime.fallback_reason !== null || sourceProfileId === null))
    || (input.runtime.source === "SUPERVISOR_FALLBACK"
      && (input.runtime.fallback_reason === null || sourceProfileId === null))) {
    throw new TypeError("Dynamic Worker provider planning requires exact Pi runtime provenance");
  }
  const packetInput = {
    graph: input.graph,
    node_id: input.node.node_id,
    attempt: input.attempt,
    lease_generation: input.leaseGeneration,
    fencing_token: input.fencingToken,
    exact_input_refs: input.node.exact_input_refs,
    decision_refs: input.node.decision_refs,
    deadline_ms: input.deadlineMs,
    created_at_ms: input.createdAtMs,
  } as const;
  const provisionalPacket = createTaskPacketV2({
    ...packetInput,
    provider_call_plan_id: null,
    provider_call_plan_sha256: null,
  }, input.capabilityKey);
  const profile = captureProviderRuntimeProfileV1({
    resolved: input.runtime,
    sourceProfileId,
    currentPiConfigSha256: input.graph.config_sha256,
    runtimeFingerprintSha256: input.node.provider_profile_sha256,
  });
  const fields = allowedFields(input.node, provisionalPacket.packet_id);
  const allowedFieldsRootSha256 = canonicalJsonSha256({
    domain: "PCH-PROVIDER-ALLOWED-FIELDS-V1",
    members: fields,
  });
  const redaction = finalizeProviderRedactionReceiptV1({
    goal_id: input.graph.goal_id,
    run_id: input.graph.run_id,
    graph_revision_id: input.graph.execution_graph_revision_id,
    node_id: input.node.node_id,
    packet_id: provisionalPacket.packet_id,
    minimum_input_closure_sha256: input.node.input_closure_sha256,
    privacy_class: input.node.privacy_class,
    allowed_fields_root_sha256: allowedFieldsRootSha256,
    predecessor_authority_head_sha256: input.predecessorAuthorityHeadSha256,
    created_at_ms: input.createdAtMs,
  });
  const nodeEvidence = canonicalJsonSha256({
    domain: "PCH-PROVIDER-WORKER-NODE-EVIDENCE-V1",
    graph: input.graph.record_sha256,
    node: input.node.record_sha256,
    topology_gate: input.graph.topology_gate_receipt_sha256,
  });
  const plan = finalizeProviderCallPlanV1({
    goal_id: input.graph.goal_id,
    run_id: input.graph.run_id,
    graph_revision_id: input.graph.execution_graph_revision_id,
    graph_revision_sha256: input.graph.record_sha256,
    node_id: input.node.node_id,
    node_spec_sha256: input.node.record_sha256,
    packet_id: provisionalPacket.packet_id,
    attempt: input.attempt,
    lease_generation: input.leaseGeneration,
    fencing_token: input.fencingToken,
    logical_request_id: provisionalPacket.packet_id,
    plan_nonce_sha256: canonicalJsonSha256({
      domain: "PCH-PROVIDER-WORKER-PLAN-NONCE-V1",
      packet: provisionalPacket.packet_id,
      predecessor: input.predecessorAuthorityHeadSha256,
    }),
    request_class: "WORKER",
    purpose_kind: "TASK_EXECUTION",
    purpose: "Execute the exact authority-bound TaskPacket and return one typed unverified Worker proposal",
    uncertainty_id: input.node.node_id,
    uncertainty_sha256: nodeEvidence,
    expected_information_gain: { basis_points: 10_000, evidence_sha256: nodeEvidence },
    expected_loss_if_skipped: { basis_points: 10_000, evidence_sha256: nodeEvidence },
    minimum_input_closure_sha256: input.node.input_closure_sha256,
    privacy_class: input.node.privacy_class,
    allowed_fields: fields,
    redaction_receipt_id: redaction.redaction_receipt_id,
    redaction_receipt_sha256: redaction.record_sha256,
    provider_profile: profile,
    request_budget: {
      budget_envelope_sha256: canonicalJsonSha256({
        domain: "PCH-PROVIDER-WORKER-BUDGET-V1",
        packet: provisionalPacket.packet_id,
        requests: input.node.max_turns,
        input_tokens: input.node.max_input_tokens,
        output_tokens: input.node.max_output_tokens,
        deadline: input.deadlineMs,
      }),
      soft_max_requests: input.node.max_turns,
      soft_max_input_tokens: input.node.max_input_tokens,
      soft_max_output_tokens: input.node.max_output_tokens,
      soft_max_cost_microusd: Number.MAX_SAFE_INTEGER,
      soft_max_latency_ms: Math.min(86_400_000, input.deadlineMs - input.createdAtMs),
      deadline_at_ms: input.deadlineMs,
    },
    admission_reason: "PARALLEL_CRITICAL_PATH",
    cache: {
      mode: "C0",
      lineage_sha256: null,
      adapter_integration_id: null,
      adapter_security_epoch: null,
      adapter_usage_semantics_id: `PCH-C0-${input.runtime.runtime.api}-USAGE-V1`,
      session_capability: "NONE",
      session_capability_sha256: null,
    },
    success_evidence: {
      kind: "TYPED_WORKER_PROPOSAL",
      output_schema_sha256: input.node.output_schema_sha256,
      evidence_requirement_sha256: canonicalJsonSha256({
        domain: "PCH-PROVIDER-WORKER-EVIDENCE-REQUIREMENT-V1",
        obligations: input.node.obligation_ids,
        oracle: input.node.oracle_sha256,
      }),
    },
    local_oracle: {
      owner: "HOST",
      oracle_sha256: input.node.oracle_sha256,
      covered_obligation_ids: input.node.obligation_ids,
    },
    fallback: { kind: "LOCAL_REPLAN", evidence_sha256: nodeEvidence },
    attempt_limit: 1,
    transport_request_limit: input.node.max_turns,
    fan_out_limit: 1,
    no_progress_limit: input.node.no_progress_limit,
    evidence_saturation_sha256: canonicalJsonSha256({
      domain: "PCH-PROVIDER-WORKER-EVIDENCE-SATURATION-V1",
      output_schema: input.node.output_schema_sha256,
      oracle: input.node.oracle_sha256,
    }),
    stop_conditions: [
      "DEADLINE_REACHED", "EVIDENCE_SATURATION", "MAX_ATTEMPTS_REACHED", "NO_PROGRESS",
      "PRIVACY_VIOLATION", "SOFT_BUDGET_EXHAUSTED", "SUCCESS_EVIDENCE_OBSERVED",
    ],
    predecessor_authority_head_sha256: input.predecessorAuthorityHeadSha256,
    created_at_ms: input.createdAtMs,
  });
  const packet = createTaskPacketV2({
    ...packetInput,
    provider_call_plan_id: plan.provider_call_plan_id,
    provider_call_plan_sha256: plan.record_sha256,
  }, input.capabilityKey);
  if (packet.packet_id !== provisionalPacket.packet_id) {
    throw new TypeError("Provider plan changed the stable TaskPacket identity");
  }
  const invocation = finalizeProviderInvocationPreparedV1({
    provider_call_plan_id: plan.provider_call_plan_id,
    provider_call_plan_sha256: plan.record_sha256,
    goal_id: packet.goal_id,
    run_id: packet.run_id,
    graph_revision_id: packet.graph_revision_id,
    node_id: packet.node_id,
    packet_id: packet.packet_id,
    packet_sha256: packet.packet_sha256,
    attempt: packet.attempt,
    lease_generation: packet.lease_generation,
    fencing_token: packet.fencing_token,
    created_at_ms: input.createdAtMs,
  });
  return { packet, redaction, plan, invocation, runtime: input.runtime };
}
