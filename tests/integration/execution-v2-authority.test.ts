import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { ArtifactStore } from "../../src/artifacts/artifact-store.js";
import { canonicalJsonSha256 } from "../../src/authority/canonical-json.js";
import { AuthorityStore, type TransactionFaultPoint } from "../../src/authority/transactions.js";
import { sha256Hex } from "../../src/foundation/crypto.js";
import {
  executionNodeInputClosureV2,
  finalizeExecutionIntegrationAttemptV2,
  finalizeExecutionIntegrationTransitionV2,
  finalizeExecutionNodeAttemptOutcomeV2,
  finalizeExecutionNodeLeaseV2,
  finalizeExecutionStopV2,
  finalizeHostOracleReceiptV2,
  finalizeHostNodeReceiptV2,
  finalizeWorkerProposalV2,
  finalizeWorkerPatchSetV2,
  type ExecutionNodeSpecV2,
  type TaskPacketV2,
} from "../../src/harness/execution-v2/domain.js";
import type { createTaskPacketV2 as createRawTaskPacketV2 } from "../../src/harness/execution-v2/domain.js";
import {
  sealTaskFlowRecord,
  type OperationAttemptRecord,
  type OperationTransitionRecord,
  type WorkspaceBaselineRecord,
} from "../../src/task-flow/domain.js";
import { finalizeExecutionGraphV2 } from "../../src/harness/execution-v2/dag.js";
import { DynamicMultiCoordinator } from "../../src/harness/execution-v2/coordinator.js";
import { sealHarnessRecord, type TopologyRevisionRecord } from "../../src/harness/domain.js";
import {
  finalizeDynamicMultiCandidateV2,
  finalizeStrongSingleBaselineV2,
  finalizeTopologyMeasurementEvidenceReceiptV2,
  finalizeTopologyMeasurementReceiptV2,
  finalizeTopologyGateV2,
} from "../../src/harness-v2/topology-gate.js";
import { createHarnessFixture, type HarnessFixture } from "../helpers/harness.js";
import { taskFlowMemoryMigrations } from "../helpers/task-flow.js";
import { createWorkerProviderDispatchAuthorityV1 } from "../../src/provider-v2/worker-plan.js";
import type { WorkerProviderDispatchAuthorityV1 } from "../../src/provider-v2/worker-plan.js";
import { finalizeProviderInvocationTerminalV1 } from "../../src/provider-v2/invocation.js";
import {
  executionIntegrationJournalFixture,
  preparedExecutionIntegrationJournalFixture,
} from "../helpers/execution-v2.js";

const fixtures: HarnessFixture[] = [];
const sha = (value: string): string => sha256Hex(value);
const providerDispatches = new Map<string, WorkerProviderDispatchAuthorityV1>();
const providerRuntime = {
  provider: "authority-test-provider",
  api: "authority-test-api",
  model: "authority-test-model",
  thinking_level: "high",
  context_window: 128_000,
} as const;

function createTaskPacketV2(
  input: Parameters<typeof createRawTaskPacketV2>[0],
  capabilityKey: string,
): TaskPacketV2 {
  const fixture = fixtures.find((candidate) => candidate.run.run_id === input.graph.run_id);
  const current = input.graph.nodes.find((candidate) => candidate.node_id === input.node_id);
  if (!fixture || !current) throw new TypeError("Provider test dispatch lacks its fixture or node");
  const preparation = fixture.authority.store.readExecutionV2Preparation(fixture.goalId, fixture.run.run_id);
  const dispatch = createWorkerProviderDispatchAuthorityV1({
    graph: input.graph,
    node: current,
    attempt: input.attempt,
    leaseGeneration: input.lease_generation,
    fencingToken: input.fencing_token,
    deadlineMs: input.deadline_ms,
    createdAtMs: input.created_at_ms,
    predecessorAuthorityHeadSha256: preparation.predecessorAuthorityHeadSha256,
    capabilityKey,
    runtime: { runtime: providerRuntime, source: "SUPERVISOR_INHERITED", fallback_reason: null },
  });
  providerDispatches.set(dispatch.packet.packet_id, dispatch);
  return dispatch.packet;
}

function providerLeaseAuthority(packet: TaskPacketV2) {
  const dispatch = providerDispatches.get(packet.packet_id);
  if (!dispatch) throw new TypeError("Provider test dispatch authority is missing");
  return { providerPlan: dispatch.plan, redaction: dispatch.redaction, invocation: dispatch.invocation };
}

function recordProviderTerminal(input: {
  readonly fixture: HarnessFixture;
  readonly packet: TaskPacketV2;
  readonly version: number;
  readonly successSha256?: string;
  readonly unknown?: boolean;
  readonly suffix: string;
}): number {
  const dispatch = providerDispatches.get(input.packet.packet_id);
  if (!dispatch) throw new TypeError("Provider test dispatch authority is missing");
  const unknown = input.unknown === true;
  const transition = finalizeProviderInvocationTerminalV1({
    prepared: dispatch.invocation,
    state: unknown ? "OUTCOME_UNKNOWN" : "SETTLED",
    ...(unknown ? {} : {
      request_count: 1,
      input_tokens: 1,
      output_tokens: 1,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cost_microusd: 0,
      wall_time_ms: 1,
      cache_lineage_sha256: null,
      success_evidence_sha256: input.successSha256 ?? null,
    }),
    failure_sha256: input.successSha256 === undefined ? sha(`provider-terminal:${input.suffix}`) : null,
    created_at_ms: input.fixture.authority.clock.now(),
  });
  return input.fixture.authority.store.transactExecutionV2({
    type: "RECORD_PROVIDER_INVOCATION_TRANSITION_V1",
    goalId: input.fixture.goalId,
    transition,
  }, {
    expectedVersion: input.version,
    idempotencyKey: `execution-v2:${input.suffix}:provider-terminal`,
    actor: "RUNTIME",
    lease: input.fixture.lease,
  }).goalVersion;
}

function topologyFor(gate: ReturnType<typeof finalizeTopologyGateV2>): TopologyRevisionRecord {
  return sealHarnessRecord<TopologyRevisionRecord, "record_sha256">("PCH-TOPOLOGY-REVISION-V1", {
    schema_version: 1,
    run_id: gate.run_id,
    revision: 2,
    requested_topology: gate.requested_topology,
    effective_topology: gate.effective_topology,
    reason_code: gate.reason_code,
    decision_sha256: gate.record_sha256,
    config_sha256: gate.config_sha256,
    created_at_ms: gate.created_at_ms,
  }, "record_sha256");
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.authority.close();
  providerDispatches.clear();
});

function node(
  id: string,
  obligationIds: readonly string[] = ["OBL-EXECUTION-V2"],
  oracle = sha(`node-oracle:${id}`),
  requirementIds: readonly string[] = ["REQ-EXECUTION-V2"],
  decisionRefs: readonly { readonly decision_id: string; readonly sha256: string }[] = [],
): Omit<ExecutionNodeSpecV2, "record_sha256"> {
  const patchNode = id === "NODE-A";
  const task = `Inspect the exact source and return typed evidence for ${id}`;
  const outputSchema = sha(`node-output:${id}`);
  const providerProfile = sha("provider-profile");
  return {
    schema_version: 2,
    node_id: id,
    logical_key: id.toLowerCase(),
    task,
    capabilities: patchNode ? ["SOURCE_DISCOVERY", "PATCH_PROPOSE"] : ["SOURCE_DISCOVERY"],
    effect_ceiling: patchNode ? "PATCH_PROPOSAL" : "READ_ONLY",
    requirement_ids: requirementIds,
    obligation_ids: obligationIds,
    read_roots: ["src"],
    write_roots: patchNode ? ["src"] : [],
    exact_input_refs: [],
    decision_refs: decisionRefs,
    provider_call_plan_id: null,
    provider_call_plan_sha256: null,
    input_closure_sha256: executionNodeInputClosureV2({
      task, requirement_ids: requirementIds, obligation_ids: obligationIds,
      exact_input_refs: [], decision_refs: decisionRefs, output_schema_sha256: outputSchema,
      oracle_sha256: oracle, provider_profile_sha256: providerProfile,
    }),
    output_schema_sha256: outputSchema,
    oracle_sha256: oracle,
    provider_profile_sha256: providerProfile,
    privacy_class: "INTERNAL",
    taint_classes: [],
    max_turns: 4,
    max_tool_calls: 16,
    max_input_tokens: 32_000,
    max_output_tokens: 8_000,
    max_retries: 1,
    no_progress_limit: 2,
    deadline_ms: 1_800_000_100_000,
  };
}

function committedPacketClosure(graph: ReturnType<typeof finalizeExecutionGraphV2>, nodeId: string) {
  const current = graph.nodes.find((entry) => entry.node_id === nodeId);
  if (!current) throw new TypeError(`Missing committed node ${nodeId}`);
  return {
    exact_input_refs: current.exact_input_refs,
    decision_refs: current.decision_refs,
    provider_call_plan_id: current.provider_call_plan_id,
    provider_call_plan_sha256: current.provider_call_plan_sha256,
  };
}

function coordinatorMutation(fixture: HarnessFixture) {
  return {
    transact(command: Parameters<AuthorityStore["transactExecutionV2"]>[0], idempotencyKey: string) {
      const authority = fixture.authority.store;
      return authority.transactExecutionV2(command, {
        expectedVersion: authority.readSnapshot(command.goalId).goalVersion,
        idempotencyKey,
        actor: "RUNTIME",
        lease: fixture.lease,
      });
    },
  };
}

function recordTopologyMeasurements(input: {
  readonly fixture: HarnessFixture;
  readonly preparation: ReturnType<AuthorityStore["readExecutionV2Preparation"]>;
  readonly runtimeFingerprintSha256: string;
  readonly suffix: string;
  readonly graphProposalSha256: string;
  readonly totalNodeCount: number;
  readonly independentNodeCount: number;
  readonly crossPartitionDependencyCount: number;
}) {
  const { fixture, preparation } = input;
  const store = fixture.authority.store;
  const observedAtMs = fixture.authority.clock.now();
  const topologyClosure = {
    goal_id: fixture.goalId,
    plan_revision_id: preparation.planRevisionId,
    plan_revision_sha256: preparation.planRevisionSha256,
    input_closure_sha256: preparation.inputClosureSha256,
    runtime_fingerprint_sha256: input.runtimeFingerprintSha256,
  } as const;
  const measurementClosure = {
    ...topologyClosure,
    run_id: fixture.run.run_id,
    work_cell_id: preparation.workCellId,
    config_sha256: preparation.configSha256,
    baseline_sha256: preparation.baselineSha256,
    baseline_content_root_sha256: preparation.baselineContentRootSha256,
    environment_sha256: preparation.environmentSha256,
  } as const;
  const strongSingleEvidence = finalizeTopologyMeasurementEvidenceReceiptV2({
    ...measurementClosure,
    kind: "STRONG_SINGLE",
    graph_proposal_sha256: null,
    derivation: "HOST_STRONG_SINGLE_ROLLOUT",
    source_observation_sha256: sha(`${input.suffix}:single-observation`),
    correctness: "PASS",
    quality_basis_points: 10_000,
    wall_time_ms: 10_000,
    provider_requests: 2,
    input_tokens: 8_000,
    output_tokens: 2_000,
    user_interventions: 0,
    safety_events: 0,
    predecessor_authority_head_sha256: preparation.predecessorAuthorityHeadSha256,
    observed_at_ms: observedAtMs,
  });
  const multiEvidence = finalizeTopologyMeasurementEvidenceReceiptV2({
    ...measurementClosure,
    kind: "DYNAMIC_MULTI_SIMULATION",
    graph_proposal_sha256: input.graphProposalSha256,
    derivation: "HOST_DETERMINISTIC_DAG_SIMULATION",
    source_observation_sha256: sha(`${input.suffix}:multi-observation`),
    correctness: "PASS",
    quality_basis_points: 10_000,
    wall_time_ms: 7_000,
    provider_requests: 2,
    input_tokens: 8_000,
    output_tokens: 2_000,
    user_interventions: 0,
    safety_events: 0,
    predecessor_authority_head_sha256: preparation.predecessorAuthorityHeadSha256,
    observed_at_ms: observedAtMs,
  });
  const strongSingle = finalizeTopologyMeasurementReceiptV2({
    ...measurementClosure,
    kind: "STRONG_SINGLE",
    graph_proposal_sha256: null,
    correctness: "PASS",
    quality_basis_points: 10_000,
    wall_time_ms: 10_000,
    provider_requests: 2,
    input_tokens: 8_000,
    output_tokens: 2_000,
    user_interventions: 0,
    safety_events: 0,
    source_evidence_sha256: strongSingleEvidence.record_sha256,
    predecessor_authority_head_sha256: preparation.predecessorAuthorityHeadSha256,
    observed_at_ms: observedAtMs,
  });
  const multiSimulation = finalizeTopologyMeasurementReceiptV2({
    ...measurementClosure,
    kind: "DYNAMIC_MULTI_SIMULATION",
    graph_proposal_sha256: input.graphProposalSha256,
    correctness: "PASS",
    quality_basis_points: 10_000,
    wall_time_ms: 7_000,
    provider_requests: 2,
    input_tokens: 8_000,
    output_tokens: 2_000,
    user_interventions: 0,
    safety_events: 0,
    source_evidence_sha256: multiEvidence.record_sha256,
    predecessor_authority_head_sha256: preparation.predecessorAuthorityHeadSha256,
    observed_at_ms: observedAtMs,
  });
  const recorded = store.transactExecutionV2({
    type: "RECORD_TOPOLOGY_MEASUREMENTS_V2",
    goalId: fixture.goalId,
    evidenceReceipts: [strongSingleEvidence, multiEvidence],
    receipts: [strongSingle, multiSimulation],
  }, {
    expectedVersion: store.readTaskFlowGoalVersion(fixture.goalId),
    idempotencyKey: `execution-v2:${input.suffix}:measurements`,
    actor: "RUNTIME",
    lease: fixture.lease,
  });
  const current = store.readExecutionV2Preparation(fixture.goalId, fixture.run.run_id);
  return {
    current,
    version: recorded.goalVersion,
    baseline: finalizeStrongSingleBaselineV2({
      ...topologyClosure,
      correctness: strongSingle.correctness,
      quality_basis_points: strongSingle.quality_basis_points,
      wall_time_ms: strongSingle.wall_time_ms,
      provider_requests: strongSingle.provider_requests,
      input_tokens: strongSingle.input_tokens,
      output_tokens: strongSingle.output_tokens,
      user_interventions: strongSingle.user_interventions,
      safety_events: strongSingle.safety_events,
      evidence_sha256: strongSingle.record_sha256,
      observed_at_ms: strongSingle.observed_at_ms,
    }),
    candidate: finalizeDynamicMultiCandidateV2({
      ...topologyClosure,
      graph_sha256: input.graphProposalSha256,
      total_node_count: input.totalNodeCount,
      independent_node_count: input.independentNodeCount,
      cross_partition_dependency_count: input.crossPartitionDependencyCount,
      write_scope_conflict_count: 0,
      task_packets_complete: true,
      independent_validation: true,
      estimated_quality_basis_points: multiSimulation.quality_basis_points,
      estimated_wall_time_ms: multiSimulation.wall_time_ms,
      estimated_provider_requests: multiSimulation.provider_requests,
      estimated_input_tokens: multiSimulation.input_tokens,
      estimated_output_tokens: multiSimulation.output_tokens,
      estimated_user_interventions: multiSimulation.user_interventions,
      estimated_safety_events: multiSimulation.safety_events,
      simulator_receipt_sha256: multiSimulation.record_sha256,
      estimated_at_ms: multiSimulation.observed_at_ms,
    }),
  };
}

function pendingAtomicExecution(edgeCondition: "EVIDENCE_ACCEPTED" | "PATCH_INTEGRATED" | "ORACLE_PASSED" = "EVIDENCE_ACCEPTED") {
  const fixture = createHarnessFixture("MULTI", "EXECUTION-V2-ATOMIC", { readRoots: ["src"], writeRoots: ["src"] });
  fixtures.push(fixture);
  const preparation = fixture.authority.store.readExecutionV2Preparation(fixture.goalId, fixture.run.run_id);
  const runtimeFingerprint = sha("atomic-runtime-fingerprint");
  const topologyClosure = {
    goal_id: fixture.goalId,
    plan_revision_id: preparation.planRevisionId,
    plan_revision_sha256: preparation.planRevisionSha256,
    input_closure_sha256: preparation.inputClosureSha256,
    runtime_fingerprint_sha256: runtimeFingerprint,
  } as const;
  const measured = recordTopologyMeasurements({
    fixture,
    preparation,
    runtimeFingerprintSha256: runtimeFingerprint,
    suffix: "atomic",
    graphProposalSha256: sha("atomic-candidate-graph"),
    totalNodeCount: 2,
    independentNodeCount: 2,
    crossPartitionDependencyCount: 0,
  });
  const { baseline, candidate } = measured;
  const gate = finalizeTopologyGateV2({
    ...topologyClosure,
    run_id: fixture.run.run_id,
    requested_topology: "MULTI",
    config_sha256: preparation.configSha256,
    strong_single_baseline: baseline,
    multi_candidate: candidate,
    predecessor_authority_head_sha256: measured.current.predecessorAuthorityHeadSha256,
    created_at_ms: fixture.authority.clock.now(),
  });
  const graph = finalizeExecutionGraphV2({
    goal_id: fixture.goalId,
    run_id: fixture.run.run_id,
    work_cell_id: preparation.workCellId,
    plan_revision_id: preparation.planRevisionId,
    plan_revision_sha256: preparation.planRevisionSha256,
    topology_gate_receipt_id: gate.topology_gate_receipt_id,
    topology_gate_receipt_sha256: gate.record_sha256,
    authorization_id: preparation.authorizationId,
    authorization_sha256: preparation.authorizationSha256,
    baseline_sha256: preparation.baselineSha256,
    baseline_content_root_sha256: preparation.baselineContentRootSha256,
    environment_sha256: preparation.environmentSha256,
    input_closure_sha256: preparation.inputClosureSha256,
    oracle_set_sha256: preparation.oracleSetSha256,
    config_sha256: preparation.configSha256,
    runtime_fingerprint_sha256: runtimeFingerprint,
    predecessor_authority_head_sha256: measured.current.predecessorAuthorityHeadSha256,
    graph_revision: 1,
    stop_generation: 0,
    nodes: [
      node("NODE-A", fixture.route.work_cells[0]!.obligation_ids, canonicalJsonSha256(fixture.route.work_cells[0]!.oracle),
        preparation.workCellRequirementIds, preparation.workCellDecisionRefs),
      node("NODE-B", fixture.route.work_cells[0]!.obligation_ids, canonicalJsonSha256(fixture.route.work_cells[0]!.oracle),
        preparation.workCellRequirementIds, preparation.workCellDecisionRefs),
    ],
    edges: [{ from_node_id: "NODE-A", to_node_id: "NODE-B", condition: edgeCondition }],
    created_at_ms: fixture.authority.clock.now(),
  });
  return {
    fixture, baseline, candidate, gate, topology: topologyFor(gate), graph,
    preparation: measured.current, runtimeFingerprint, version: measured.version,
  };
}

function prepare(
  edgeCondition: "EVIDENCE_ACCEPTED" | "PATCH_INTEGRATED" | "ORACLE_PASSED" = "EVIDENCE_ACCEPTED",
  independentBranch = false,
):
  { fixture: HarnessFixture; graph: ReturnType<typeof finalizeExecutionGraphV2>; version: number } {
  const fixture = createHarnessFixture("MULTI", "EXECUTION-V2", { readRoots: ["src"], writeRoots: ["src"] });
  fixtures.push(fixture);
  const store = fixture.authority.store;
  const closure = store.readExecutionV2Preparation(fixture.goalId, fixture.run.run_id);
  const runtimeFingerprint = sha("runtime-fingerprint");
  const topologyClosure = {
    goal_id: fixture.goalId,
    plan_revision_id: closure.planRevisionId,
    plan_revision_sha256: closure.planRevisionSha256,
    input_closure_sha256: closure.inputClosureSha256,
    runtime_fingerprint_sha256: runtimeFingerprint,
  } as const;
  const measured = recordTopologyMeasurements({
    fixture,
    preparation: closure,
    runtimeFingerprintSha256: runtimeFingerprint,
    suffix: "standard",
    graphProposalSha256: sha("candidate-graph"),
    totalNodeCount: 2,
    independentNodeCount: 2,
    crossPartitionDependencyCount: 0,
  });
  const { baseline, candidate } = measured;
  const gate = finalizeTopologyGateV2({
    ...topologyClosure,
    run_id: fixture.run.run_id,
    requested_topology: "MULTI",
    config_sha256: closure.configSha256,
    strong_single_baseline: baseline,
    multi_candidate: candidate,
    predecessor_authority_head_sha256: measured.current.predecessorAuthorityHeadSha256,
    created_at_ms: fixture.authority.clock.now(),
  });
  const admission = store.transactExecutionV2({
    type: "RECORD_TOPOLOGY_ADMISSION_V2",
    goalId: fixture.goalId,
    baseline,
    candidate,
    gate,
    topology: topologyFor(gate),
  }, {
    expectedVersion: measured.version,
    idempotencyKey: "execution-v2:admission",
    actor: "RUNTIME",
    lease: fixture.lease,
  });
  const current = store.readExecutionV2Preparation(fixture.goalId, fixture.run.run_id);
  const graph = finalizeExecutionGraphV2({
    goal_id: fixture.goalId,
    run_id: fixture.run.run_id,
    work_cell_id: current.workCellId,
    plan_revision_id: current.planRevisionId,
    plan_revision_sha256: current.planRevisionSha256,
    topology_gate_receipt_id: gate.topology_gate_receipt_id,
    topology_gate_receipt_sha256: gate.record_sha256,
    authorization_id: current.authorizationId,
    authorization_sha256: current.authorizationSha256,
    baseline_sha256: current.baselineSha256,
    baseline_content_root_sha256: current.baselineContentRootSha256,
    environment_sha256: current.environmentSha256,
    input_closure_sha256: current.inputClosureSha256,
    oracle_set_sha256: current.oracleSetSha256,
    config_sha256: current.configSha256,
    runtime_fingerprint_sha256: runtimeFingerprint,
    predecessor_authority_head_sha256: current.predecessorAuthorityHeadSha256,
    graph_revision: 1,
    stop_generation: 0,
    nodes: [
      node("NODE-A", fixture.route.work_cells[0]!.obligation_ids, canonicalJsonSha256(fixture.route.work_cells[0]!.oracle),
        current.workCellRequirementIds, current.workCellDecisionRefs),
      node("NODE-B", fixture.route.work_cells[0]!.obligation_ids, canonicalJsonSha256(fixture.route.work_cells[0]!.oracle),
        current.workCellRequirementIds, current.workCellDecisionRefs),
      ...(independentBranch
        ? [node("NODE-C", fixture.route.work_cells[0]!.obligation_ids,
          canonicalJsonSha256(fixture.route.work_cells[0]!.oracle),
          current.workCellRequirementIds, current.workCellDecisionRefs)]
        : []),
    ],
    edges: [{ from_node_id: "NODE-A", to_node_id: independentBranch ? "NODE-C" : "NODE-B", condition: edgeCondition }],
    created_at_ms: fixture.authority.clock.now(),
  });
  const committed = store.transactExecutionV2({
    type: "COMMIT_EXECUTION_GRAPH_V2", goalId: fixture.goalId, graph,
  }, {
    expectedVersion: admission.goalVersion,
    idempotencyKey: "execution-v2:graph",
    actor: "RUNTIME",
    lease: fixture.lease,
  });
  return { fixture, graph, version: committed.goalVersion };
}

function submitPatch(
  fixture: HarnessFixture,
  graph: ReturnType<typeof finalizeExecutionGraphV2>,
  version: number,
  suffix: string,
) {
  const now = fixture.authority.clock.now();
  const packet = createTaskPacketV2({
    graph, node_id: "NODE-A", attempt: 1, lease_generation: 1, fencing_token: 1,
    ...committedPacketClosure(graph, "NODE-A"),
    deadline_ms: now + 60_000, created_at_ms: now,
  }, "capability-key");
  const lease = finalizeExecutionNodeLeaseV2({
    packet, owner_hmac: sha(`patch-owner:${suffix}`), expires_at_ms: now + 30_000, created_at_ms: now,
  });
  const leased = fixture.authority.store.transactExecutionV2({
    type: "LEASE_EXECUTION_NODE_V2", goalId: fixture.goalId, packet, lease, ...providerLeaseAuthority(packet),
  }, { expectedVersion: version, idempotencyKey: `execution-v2:${suffix}:lease`, actor: "RUNTIME", lease: fixture.lease });
  const patchContent = Buffer.from(`export const ${suffix.replaceAll("-", "_")} = true;\n`);
  const patchSet = finalizeWorkerPatchSetV2({
    packet,
    patches: [{ operation: "CREATE", path: "src/node-a.ts", beforeSha256: null, content: patchContent }],
    created_at_ms: now,
  });
  const proposal = finalizeWorkerProposalV2({
    packet,
    kind: "PATCH_PROPOSAL",
    payload: {
      patch_set_id: patchSet.patch_set_id,
      patch_set_sha256: patchSet.record_sha256,
      affected_paths: patchSet.affected_paths,
      preimage_root_sha256: patchSet.baseline_sha256,
      proposed_postimage_root_sha256: patchSet.proposed_postimage_root_sha256,
    },
    created_at_ms: now,
  });
  const { created: _created, ...artifact } = new ArtifactStore(fixture.authority.casPath).put(patchContent, {
    mediaType: "application/octet-stream", classification: "INTERNAL", retentionClass: "GOAL",
  });
  void _created;
  const terminalVersion = recordProviderTerminal({
    fixture, packet, version: leased.goalVersion, successSha256: proposal.record_sha256, suffix: `${suffix}:proposal`,
  });
  const proposed = fixture.authority.store.transactExecutionV2({
    type: "SUBMIT_WORKER_PROPOSAL_V2", goalId: fixture.goalId, proposal, patchSet, artifacts: [artifact],
  }, { expectedVersion: terminalVersion, idempotencyKey: `execution-v2:${suffix}:proposal`, actor: "RUNTIME", lease: fixture.lease });
  return { packet, proposal, patchSet, version: proposed.goalVersion };
}

function acceptEvidence(
  fixture: HarnessFixture,
  graph: ReturnType<typeof finalizeExecutionGraphV2>,
  nodeId: string,
  version: number,
  suffix: string,
) {
  const store = fixture.authority.store;
  const now = fixture.authority.clock.now();
  const packet = createTaskPacketV2({
    graph, node_id: nodeId, attempt: 1, lease_generation: 1, fencing_token: 1,
    ...committedPacketClosure(graph, nodeId),
    deadline_ms: now + 60_000, created_at_ms: now,
  }, "capability-key");
  const lease = finalizeExecutionNodeLeaseV2({
    packet, owner_hmac: sha(`evidence-owner:${suffix}`), expires_at_ms: now + 30_000, created_at_ms: now,
  });
  const leased = store.transactExecutionV2({
    type: "LEASE_EXECUTION_NODE_V2", goalId: fixture.goalId, packet, lease, ...providerLeaseAuthority(packet),
  }, { expectedVersion: version, idempotencyKey: `execution-v2:${suffix}:lease`, actor: "RUNTIME", lease: fixture.lease });
  const proposal = finalizeWorkerProposalV2({
    packet, kind: "EVIDENCE_PROPOSAL",
    payload: { artifact_refs: [{ sha256: sha(`evidence:${suffix}`), classification: "INTERNAL" }] },
    created_at_ms: now,
  });
  const terminalVersion = recordProviderTerminal({
    fixture, packet, version: leased.goalVersion, successSha256: proposal.record_sha256, suffix: `${suffix}:proposal`,
  });
  const proposed = store.transactExecutionV2({
    type: "SUBMIT_WORKER_PROPOSAL_V2", goalId: fixture.goalId, proposal, patchSet: null, artifacts: [],
  }, { expectedVersion: terminalVersion, idempotencyKey: `execution-v2:${suffix}:proposal`, actor: "RUNTIME", lease: fixture.lease });
  const closure = store.readExecutionV2Preparation(fixture.goalId, fixture.run.run_id);
  const receipt = finalizeHostNodeReceiptV2({
    graph, node_id: nodeId, packet_id: packet.packet_id, packet_sha256: packet.packet_sha256,
    proposal_id: proposal.proposal_id, proposal_sha256: proposal.record_sha256,
    kind: "EVIDENCE_ACCEPTED", evidence_sha256: sha(`host-evidence:${suffix}`),
    preimage_root_sha256: null, postimage_root_sha256: null, stop_generation: 0,
    predecessor_authority_head_sha256: closure.predecessorAuthorityHeadSha256, created_at_ms: now,
  });
  const accepted = store.transactExecutionV2({
    type: "RECORD_HOST_NODE_RECEIPT_V2", goalId: fixture.goalId, receipt,
  }, { expectedVersion: proposed.goalVersion, idempotencyKey: `execution-v2:${suffix}:receipt`, actor: "RUNTIME", lease: fixture.lease });
  return { version: accepted.goalVersion, receipt };
}

function integrationAttempt(
  fixture: HarnessFixture,
  graph: ReturnType<typeof finalizeExecutionGraphV2>,
  patch: Pick<ReturnType<typeof submitPatch>, "proposal" | "patchSet">,
  input: { readonly generation?: number; readonly fence?: number; readonly authorization?: string } = {},
) {
  const now = fixture.authority.clock.now();
  const integration = finalizeExecutionIntegrationAttemptV2({
    graph, node_id: "NODE-A", proposal: patch.proposal, patch_set: patch.patchSet,
    authorization_sha256: input.authorization ?? graph.authorization_sha256,
    expected_preimage_root_sha256: graph.baseline_content_root_sha256,
    lease_generation: input.generation ?? 1,
    fencing_token: input.fence ?? 1,
    owner_hmac: sha(`integrator:${input.generation ?? 1}:${input.fence ?? 1}`),
    expires_at_ms: now + 30_000,
    created_at_ms: now,
  });
  return {
    ...integration,
    journal: executionIntegrationJournalFixture(fixture, integration.attempt, patch.patchSet),
  };
}

function recordValidationEvidence(
  fixture: HarnessFixture,
  version: number,
  postimageRootSha256: string,
  suffix: string,
) {
  const store = fixture.authority.store;
  const now = fixture.authority.clock.now();
  const cell = fixture.route.work_cells[0]!;
  const attempt = sealTaskFlowRecord<OperationAttemptRecord, "record_sha256">("PCH-OPERATION-ATTEMPT-V1", {
    schema_version: 1,
    attempt_id: `ATTEMPT-EXECUTION-V2-${suffix}`,
    operation_id: `OPERATION-EXECUTION-V2-${suffix}`,
    goal_id: fixture.goalId,
    work_cell_id: cell.work_cell_id,
    authorization_id: fixture.authorization.authorization_id,
    attempt_number: 1,
    operation_kind: "VALIDATION",
    normalized_target_hmac: sha(`oracle-target:${suffix}`),
    normalized_payload_sha256: sha(`oracle-payload:${suffix}`),
    execution_fingerprint_sha256: sha(`oracle-execution:${suffix}`),
    baseline_sha256: fixture.baseline.record_sha256,
    environment_sha256: fixture.baseline.environment_sha256,
    oracle_sha256: canonicalJsonSha256(cell.oracle),
    idempotency_key_hmac: sha(`oracle-idempotency:${suffix}`),
    created_at_ms: now,
  }, "record_sha256");
  const prepared = sealTaskFlowRecord<OperationTransitionRecord, "transition_sha256">(
    "PCH-OPERATION-TRANSITION-V1",
    {
      schema_version: 1,
      transition_id: `TRANSITION-EXECUTION-V2-${suffix}-0`,
      attempt_id: attempt.attempt_id,
      ordinal: 0,
      state: "PREPARED",
      output_sha256: null,
      readback_sha256: null,
      failure_signature_sha256: null,
      postcondition: "UNKNOWN",
      predecessor_sha256: null,
      created_at_ms: now,
    },
    "transition_sha256",
  );
  let result = store.transactTaskFlow({
    type: "PREPARE_OPERATION", goalId: fixture.goalId, attempt, prepared, reconcileLocator: null,
    oracleExecution: { command: "npm test", policySha256: sha(`oracle-policy:${suffix}`) },
  }, { expectedVersion: version, idempotencyKey: `execution-v2:${suffix}:oracle:prepare`, actor: "RUNTIME", lease: fixture.lease });
  let predecessor = prepared.transition_sha256;
  let terminalTransitionId = "";
  for (const [ordinal, state] of [[1, "DISPATCHED"], [2, "OBSERVED"], [3, "COMMITTED"]] as const) {
    const transition = sealTaskFlowRecord<OperationTransitionRecord, "transition_sha256">(
      "PCH-OPERATION-TRANSITION-V1",
      {
        schema_version: 1,
        transition_id: `TRANSITION-EXECUTION-V2-${suffix}-${ordinal}`,
        attempt_id: attempt.attempt_id,
        ordinal,
        state,
        output_sha256: state === "COMMITTED" ? sha(`oracle-output:${suffix}`) : null,
        readback_sha256: state === "OBSERVED" || state === "COMMITTED" ? sha(`oracle-readback:${suffix}`) : null,
        failure_signature_sha256: null,
        postcondition: state === "COMMITTED" ? "PASS" : "UNKNOWN",
        predecessor_sha256: predecessor,
        created_at_ms: now,
      },
      "transition_sha256",
    );
    result = store.transactTaskFlow({ type: "TRANSITION_OPERATION", goalId: fixture.goalId, transition }, {
      expectedVersion: result.goalVersion,
      idempotencyKey: `execution-v2:${suffix}:oracle:transition:${ordinal}`,
      actor: "RUNTIME",
      lease: fixture.lease,
    });
    predecessor = transition.transition_sha256;
    if (state === "COMMITTED") terminalTransitionId = transition.transition_id;
  }
  const postimage = sealTaskFlowRecord<WorkspaceBaselineRecord, "record_sha256">("PCH-WORKSPACE-BASELINE-V1", {
    schema_version: 1,
    baseline_id: `BASELINE-EXECUTION-V2-${suffix}`,
    workspace_id: fixture.baseline.workspace_id,
    goal_id: fixture.goalId,
    filesystem_identity_hmac: fixture.baseline.filesystem_identity_hmac,
    content_root_sha256: postimageRootSha256,
    environment_sha256: fixture.baseline.environment_sha256,
    oracle_set_sha256: fixture.baseline.oracle_set_sha256,
    scope_manifest: fixture.baseline.scope_manifest,
    created_at_ms: now,
  }, "record_sha256");
  result = store.transactTaskFlow({ type: "RECORD_WORKSPACE_BASELINE", goalId: fixture.goalId, baseline: postimage }, {
    expectedVersion: result.goalVersion,
    idempotencyKey: `execution-v2:${suffix}:oracle:postimage`,
    actor: "RUNTIME",
    lease: fixture.lease,
  });
  result = store.transactTaskFlow({
    type: "DERIVE_ACCEPTANCE_EVIDENCE_V2", goalId: fixture.goalId,
    attemptId: attempt.attempt_id, terminalTransitionId,
  }, {
    expectedVersion: result.goalVersion,
    idempotencyKey: `execution-v2:${suffix}:oracle:evidence`,
    actor: "RUNTIME",
    lease: fixture.lease,
  });
  const read = new DatabaseSync(fixture.authority.databasePath, { readOnly: true });
  try {
    const evidence = read.prepare(`SELECT o.task_obligation_id obligation_id,
        p.pass_receipt_id oracle_pass_receipt_id,p.record_sha256 oracle_pass_receipt_sha256,
        p.evidence_requirement_id,p.attempt_id operation_attempt_id,a.record_sha256 operation_attempt_sha256,
        p.terminal_transition_id,p.terminal_transition_sha256
      FROM oracle_pass_receipts_v2 p
      JOIN operation_attempts_v1 a ON a.attempt_id=p.attempt_id
      JOIN evidence_requirements_v2 r ON r.evidence_requirement_id=p.evidence_requirement_id
      JOIN facet_obligation_bindings_v2 b ON b.binding_id=r.binding_id
      JOIN acceptance_obligations_v2 o ON o.acceptance_obligation_id=b.acceptance_obligation_id
      WHERE p.goal_id=? AND p.attempt_id=? ORDER BY o.task_obligation_id,p.pass_receipt_id`)
      .all(fixture.goalId, attempt.attempt_id) as Array<{
        obligation_id: string;
        oracle_pass_receipt_id: string;
        oracle_pass_receipt_sha256: string;
        evidence_requirement_id: string;
        operation_attempt_id: string;
        operation_attempt_sha256: string;
        terminal_transition_id: string;
        terminal_transition_sha256: string;
      }>;
    return { version: result.goalVersion, evidence };
  } finally {
    read.close();
  }
}

let coordinatorOracleSequence = 0;

function coordinatorOracle(fixture: HarnessFixture) {
  return {
    async validate(input: { readonly packet: TaskPacketV2; readonly postimage_root_sha256: string }) {
      const validation = recordValidationEvidence(
        fixture,
        fixture.authority.store.readSnapshot(fixture.goalId).goalVersion,
        input.postimage_root_sha256,
        `COORDINATOR-${input.packet.node_id}-${coordinatorOracleSequence += 1}`,
      );
      return { validation_evidence: validation.evidence };
    },
  };
}

const beforeCommitFaults: readonly TransactionFaultPoint[] = [
  "before-begin", "after-begin", "after-idempotency", "after-version-check", "after-domain-write",
  "after-event-write", "after-projection-write", "after-outbox-write", "after-receipt-write", "before-commit",
];

describe("Dynamic Multi Execution V2 authority", () => {
  it("denies admission when a Strong Single hash lacks durable same-closure measurement provenance", () => {
    const pending = pendingAtomicExecution();
    const forgedBaseline = finalizeStrongSingleBaselineV2({
      goal_id: pending.baseline.goal_id,
      plan_revision_id: pending.baseline.plan_revision_id,
      plan_revision_sha256: pending.baseline.plan_revision_sha256,
      input_closure_sha256: pending.baseline.input_closure_sha256,
      runtime_fingerprint_sha256: pending.baseline.runtime_fingerprint_sha256,
      correctness: pending.baseline.correctness,
      quality_basis_points: pending.baseline.quality_basis_points,
      wall_time_ms: pending.baseline.wall_time_ms,
      provider_requests: pending.baseline.provider_requests,
      input_tokens: pending.baseline.input_tokens,
      output_tokens: pending.baseline.output_tokens,
      user_interventions: pending.baseline.user_interventions,
      safety_events: pending.baseline.safety_events,
      evidence_sha256: sha("forged-strong-single-evidence"),
      observed_at_ms: pending.baseline.observed_at_ms,
    });
    const gate = finalizeTopologyGateV2({
      goal_id: pending.fixture.goalId,
      run_id: pending.fixture.run.run_id,
      plan_revision_id: pending.preparation.planRevisionId,
      plan_revision_sha256: pending.preparation.planRevisionSha256,
      input_closure_sha256: pending.preparation.inputClosureSha256,
      runtime_fingerprint_sha256: pending.runtimeFingerprint,
      requested_topology: "MULTI",
      config_sha256: pending.preparation.configSha256,
      strong_single_baseline: forgedBaseline,
      multi_candidate: pending.candidate,
      predecessor_authority_head_sha256: pending.preparation.predecessorAuthorityHeadSha256,
      created_at_ms: pending.fixture.authority.clock.now(),
    });

    expect(() => pending.fixture.authority.store.transactExecutionV2({
      type: "RECORD_TOPOLOGY_ADMISSION_V2",
      goalId: pending.fixture.goalId,
      baseline: forgedBaseline,
      candidate: pending.candidate,
      gate,
      topology: topologyFor(gate),
    }, {
      expectedVersion: pending.version,
      idempotencyKey: "execution-v2:forged-measurement-admission",
      actor: "RUNTIME",
      lease: pending.fixture.lease,
    })).toThrow(/measurement provenance/u);
    expect(pending.fixture.authority.store.readExecutionV2(pending.fixture.run.run_id, 2)).toBeNull();
  });

  it("atomically records admission and commits its graph at one authority sequence", () => {
    const { fixture, baseline, candidate, gate, topology, graph, version } = pendingAtomicExecution();
    const result = fixture.authority.store.transactExecutionV2({
      type: "ADMIT_AND_COMMIT_EXECUTION_GRAPH_V2",
      goalId: fixture.goalId,
      baseline,
      candidate,
      gate,
      topology,
      graph,
    }, {
      expectedVersion: version,
      idempotencyKey: "execution-v2:atomic-admit-and-commit",
      actor: "RUNTIME",
      lease: fixture.lease,
    });

    expect(result).toMatchObject({
      goalVersion: version + 1,
      eventSequence: version + 1,
      eventType: "EXECUTION_GRAPH_COMMITTED",
      reused: false,
    });
    expect(fixture.authority.store.readExecutionV2(fixture.run.run_id, 2)).toMatchObject({
      graph: { execution_graph_revision_id: graph.execution_graph_revision_id },
      status: "RUNNING",
      readyNodeIds: ["NODE-A"],
    });
    expect(fixture.authority.store.verifyExecutionV2Integrity()).toMatchObject({
      graphs: 1,
      nodes: 2,
      mismatches: 0,
    });

    const database = new DatabaseSync(fixture.authority.databasePath, { readOnly: true });
    try {
      const sequences = database.prepare(`SELECT
          (SELECT created_event_sequence FROM strong_single_baselines_v2 WHERE strong_single_baseline_id=?) baseline_sequence,
          (SELECT created_event_sequence FROM dynamic_multi_candidates_v2 WHERE multi_candidate_id=?) candidate_sequence,
          (SELECT created_event_sequence FROM topology_gate_receipts_v2 WHERE topology_gate_receipt_id=?) gate_sequence,
          (SELECT created_event_sequence FROM execution_graph_revisions_v2 WHERE execution_graph_revision_id=?) graph_sequence`)
        .get(baseline.strong_single_baseline_id, candidate.multi_candidate_id,
          gate.topology_gate_receipt_id, graph.execution_graph_revision_id);
      expect(sequences).toEqual({
        baseline_sequence: result.eventSequence,
        candidate_sequence: result.eventSequence,
        gate_sequence: result.eventSequence,
        graph_sequence: result.eventSequence,
      });
      const event = database.prepare("SELECT event_type,payload_json FROM events WHERE goal_id=? AND sequence=?")
        .get(fixture.goalId, result.eventSequence) as { event_type: string; payload_json: string };
      expect(event.event_type).toBe("EXECUTION_GRAPH_COMMITTED");
      expect(JSON.parse(event.payload_json)).toMatchObject({
        gateId: gate.topology_gate_receipt_id,
        gateSha256: gate.record_sha256,
        graphId: graph.execution_graph_revision_id,
        graphSha256: graph.record_sha256,
      });
    } finally {
      database.close();
    }
  });

  it("rolls back the admission in full when graph commitment fails", () => {
    const { fixture, baseline, candidate, gate, topology, graph, version } = pendingAtomicExecution();
    const invalidGraph = finalizeExecutionGraphV2({
      goal_id: graph.goal_id,
      run_id: graph.run_id,
      work_cell_id: graph.work_cell_id,
      plan_revision_id: graph.plan_revision_id,
      plan_revision_sha256: graph.plan_revision_sha256,
      topology_gate_receipt_id: graph.topology_gate_receipt_id,
      topology_gate_receipt_sha256: graph.topology_gate_receipt_sha256,
      authorization_id: graph.authorization_id,
      authorization_sha256: graph.authorization_sha256,
      baseline_sha256: graph.baseline_sha256,
      baseline_content_root_sha256: graph.baseline_content_root_sha256,
      environment_sha256: graph.environment_sha256,
      input_closure_sha256: graph.input_closure_sha256,
      oracle_set_sha256: graph.oracle_set_sha256,
      config_sha256: graph.config_sha256,
      runtime_fingerprint_sha256: graph.runtime_fingerprint_sha256,
      predecessor_authority_head_sha256: graph.predecessor_authority_head_sha256,
      graph_revision: graph.graph_revision,
      stop_generation: graph.stop_generation,
      nodes: [node("NODE-A", ["OBLIGATION-OUTSIDE-WORK-CELL"], graph.nodes[0]!.oracle_sha256)],
      edges: [],
      created_at_ms: graph.created_at_ms,
    });

    expect(() => fixture.authority.store.transactExecutionV2({
      type: "ADMIT_AND_COMMIT_EXECUTION_GRAPH_V2",
      goalId: fixture.goalId,
      baseline,
      candidate,
      gate,
      topology,
      graph: invalidGraph,
    }, {
      expectedVersion: version,
      idempotencyKey: "execution-v2:atomic-graph-failure",
      actor: "RUNTIME",
      lease: fixture.lease,
    })).toThrow(/WorkCell authority/u);
    expect(fixture.authority.store.readTaskFlowGoalVersion(fixture.goalId)).toBe(version);
    expect(fixture.authority.store.readExecutionV2(fixture.run.run_id, 2)).toBeNull();

    const database = new DatabaseSync(fixture.authority.databasePath, { readOnly: true });
    try {
      expect(database.prepare(`SELECT
          (SELECT COUNT(*) FROM strong_single_baselines_v2) baselines,
          (SELECT COUNT(*) FROM dynamic_multi_candidates_v2) candidates,
          (SELECT COUNT(*) FROM topology_gate_receipts_v2) gates,
          (SELECT COUNT(*) FROM execution_graph_revisions_v2) graphs,
          (SELECT COUNT(*) FROM events WHERE goal_id=? AND sequence>?) later_events,
          (SELECT COUNT(*) FROM outbox WHERE goal_id=? AND created_event_sequence>?) later_outbox,
          (SELECT COUNT(*) FROM command_receipts WHERE goal_id=? AND committed_event_sequence>?) later_receipts`)
        .get(
          fixture.goalId, version,
          fixture.goalId, version,
          fixture.goalId, version,
        )).toEqual({
        baselines: 0,
        candidates: 0,
        gates: 0,
        graphs: 0,
        later_events: 0,
        later_outbox: 0,
        later_receipts: 0,
      });
    } finally {
      database.close();
    }
  });

  it("rejects mismatched atomic admission and graph identities before either write", () => {
    const { fixture, baseline, candidate, gate, topology, graph, version } = pendingAtomicExecution();
    const mismatches: readonly {
      readonly label: string;
      readonly mismatchedGate: typeof gate;
      readonly mismatchedGraph: typeof graph;
    }[] = [
      { label: "gate-goal", mismatchedGate: { ...gate, goal_id: "GOAL-OTHER" }, mismatchedGraph: graph },
      { label: "graph-goal", mismatchedGate: gate, mismatchedGraph: { ...graph, goal_id: "GOAL-OTHER" } },
      { label: "run", mismatchedGate: gate, mismatchedGraph: { ...graph, run_id: "RUN-OTHER" } },
      {
        label: "gate-id",
        mismatchedGate: gate,
        mismatchedGraph: { ...graph, topology_gate_receipt_id: "TOPOLOGY-GATE-OTHER" },
      },
      {
        label: "gate-hash",
        mismatchedGate: gate,
        mismatchedGraph: { ...graph, topology_gate_receipt_sha256: sha("other-topology-gate") },
      },
      {
        label: "gate-created-at",
        mismatchedGate: { ...gate, created_at_ms: gate.created_at_ms + 1 },
        mismatchedGraph: graph,
      },
      {
        label: "graph-created-at",
        mismatchedGate: gate,
        mismatchedGraph: { ...graph, created_at_ms: graph.created_at_ms + 1 },
      },
    ];

    for (const mismatch of mismatches) {
      expect(() => fixture.authority.store.transactExecutionV2({
        type: "ADMIT_AND_COMMIT_EXECUTION_GRAPH_V2",
        goalId: fixture.goalId,
        baseline,
        candidate,
        gate: mismatch.mismatchedGate,
        topology,
        graph: mismatch.mismatchedGraph,
      }, {
        expectedVersion: version,
        idempotencyKey: `execution-v2:atomic-identity:${mismatch.label}`,
        actor: "RUNTIME",
        lease: fixture.lease,
      })).toThrow(/Atomic topology admission and execution graph identity is invalid/u);
    }
    expect(fixture.authority.store.readTaskFlowGoalVersion(fixture.goalId)).toBe(version);
    expect(fixture.authority.store.verifyExecutionV2Integrity()).toMatchObject({ graphs: 0, mismatches: 0 });
    const database = new DatabaseSync(fixture.authority.databasePath, { readOnly: true });
    try {
      expect(database.prepare(`SELECT
          (SELECT COUNT(*) FROM topology_gate_receipts_v2) gates,
          (SELECT COUNT(*) FROM execution_graph_revisions_v2) graphs`).get()).toEqual({ gates: 0, graphs: 0 });
    } finally {
      database.close();
    }
  });

  it("initializes serial integration from the workspace content root rather than the baseline record hash", () => {
    const { fixture } = prepare();
    expect(fixture.authority.store.readExecutionV2(fixture.run.run_id, 1)?.currentPostimageRootSha256)
      .toBe(fixture.baseline.content_root_sha256);
  });

  it("advances typed edges only from Host-derived receipts and continuously exposes ready nodes", () => {
    const { fixture, graph, version } = prepare();
    const store = fixture.authority.store;
    expect(store.readExecutionV2(fixture.run.run_id, 2)).toMatchObject({
      status: "RUNNING", readyNodeIds: ["NODE-A"], activeNodeIds: [], completedNodeIds: [],
    });
    const packet = createTaskPacketV2({
      graph,
      node_id: "NODE-A",
      attempt: 1,
      lease_generation: 1,
      fencing_token: 1,
      ...committedPacketClosure(graph, "NODE-A"),
      deadline_ms: fixture.authority.clock.now() + 60_000,
      created_at_ms: fixture.authority.clock.now(),
    }, "capability-key");
    const lease = finalizeExecutionNodeLeaseV2({
      packet,
      owner_hmac: sha("worker-owner"),
      expires_at_ms: fixture.authority.clock.now() + 30_000,
      created_at_ms: fixture.authority.clock.now(),
    });
    const leased = store.transactExecutionV2({
      type: "LEASE_EXECUTION_NODE_V2", goalId: fixture.goalId, packet, lease, ...providerLeaseAuthority(packet),
    }, { expectedVersion: version, idempotencyKey: "execution-v2:lease-a", actor: "RUNTIME", lease: fixture.lease });
    const proposal = finalizeWorkerProposalV2({
      packet,
      kind: "EVIDENCE_PROPOSAL",
      payload: { artifact_refs: [{ sha256: sha("worker-artifact"), classification: "INTERNAL" }] },
      created_at_ms: fixture.authority.clock.now(),
    });
    const providerTerminalVersion = recordProviderTerminal({
      fixture, packet, version: leased.goalVersion, successSha256: proposal.record_sha256, suffix: "typed-edge-a",
    });
    const proposed = store.transactExecutionV2({
      type: "SUBMIT_WORKER_PROPOSAL_V2", goalId: fixture.goalId, proposal, patchSet: null, artifacts: [],
    }, { expectedVersion: providerTerminalVersion, idempotencyKey: "execution-v2:proposal-a", actor: "RUNTIME", lease: fixture.lease });
    expect(store.readExecutionV2(fixture.run.run_id, 2)).toMatchObject({
      readyNodeIds: [], activeNodeIds: ["NODE-A"], completedNodeIds: [],
    });
    const closure = store.readExecutionV2Preparation(fixture.goalId, fixture.run.run_id);
    const receipt = finalizeHostNodeReceiptV2({
      graph,
      node_id: "NODE-A",
      packet_id: packet.packet_id,
      packet_sha256: packet.packet_sha256,
      proposal_id: proposal.proposal_id,
      proposal_sha256: proposal.record_sha256,
      kind: "EVIDENCE_ACCEPTED",
      evidence_sha256: sha("host-evidence"),
      preimage_root_sha256: null,
      postimage_root_sha256: null,
      stop_generation: 0,
      predecessor_authority_head_sha256: closure.predecessorAuthorityHeadSha256,
      created_at_ms: fixture.authority.clock.now(),
    });
    store.transactExecutionV2({
      type: "RECORD_HOST_NODE_RECEIPT_V2", goalId: fixture.goalId, receipt,
    }, { expectedVersion: proposed.goalVersion, idempotencyKey: "execution-v2:receipt-a", actor: "RUNTIME", lease: fixture.lease });
    expect(store.readExecutionV2(fixture.run.run_id, 2)).toMatchObject({
      readyNodeIds: ["NODE-B"], activeNodeIds: [], completedNodeIds: [], oraclePendingNodeIds: ["NODE-A"],
    });
    expect(store.verifyExecutionV2Integrity()).toMatchObject({
      available: true, graphs: 1, nodes: 2, packets: 1, proposals: 1, hostReceipts: 1, mismatches: 0,
    });
  });

  it("durably requeues a failed node attempt and advances its lease fence after restart", () => {
    const { fixture, graph, version } = prepare();
    const store = fixture.authority.store;
    const now = fixture.authority.clock.now();
    const packet = createTaskPacketV2({
      graph, node_id: "NODE-A", attempt: 1, lease_generation: 1, fencing_token: 1,
      ...committedPacketClosure(graph, "NODE-A"),
      deadline_ms: now + 60_000, created_at_ms: now,
    }, "capability-key");
    const lease = finalizeExecutionNodeLeaseV2({
      packet, owner_hmac: sha("retry-worker-1"), expires_at_ms: now + 30_000, created_at_ms: now,
    });
    const leased = store.transactExecutionV2({
      type: "LEASE_EXECUTION_NODE_V2", goalId: fixture.goalId, packet, lease, ...providerLeaseAuthority(packet),
    }, { expectedVersion: version, idempotencyKey: "execution-v2:retry:lease-1", actor: "RUNTIME", lease: fixture.lease });
    const providerTerminalVersion = recordProviderTerminal({
      fixture, packet, version: leased.goalVersion, suffix: "retry-outcome-1",
    });
    const outcome = finalizeExecutionNodeAttemptOutcomeV2({
      graph, packet, lease, basis: "WORKER_FAILURE", disposition: "REQUEUED", reason_code: "WORKER_PROTOCOL_FAILURE",
      failure_sha256: sha("retryable-worker-failure"),
      predecessor_authority_head_sha256: store.readExecutionV2Preparation(
        fixture.goalId, fixture.run.run_id,
      ).predecessorAuthorityHeadSha256,
      created_at_ms: now,
    });
    const requeued = store.transactExecutionV2({
      type: "RECORD_EXECUTION_NODE_ATTEMPT_OUTCOME_V2", goalId: fixture.goalId, outcome,
    }, { expectedVersion: providerTerminalVersion, idempotencyKey: "execution-v2:retry:outcome-1", actor: "RUNTIME", lease: fixture.lease });

    expect(store.readExecutionV2(fixture.run.run_id, 1)).toMatchObject({
      status: "RUNNING", readyNodeIds: ["NODE-A"], activeNodeIds: [], completedNodeIds: [],
      readyDispatches: [{ nodeId: "NODE-A", attempt: 2, leaseGeneration: 2, fencingToken: 2, stopGeneration: 0 }],
    });

    const retryPacket = createTaskPacketV2({
      graph, node_id: "NODE-A", attempt: 2, lease_generation: 2, fencing_token: 2,
      ...committedPacketClosure(graph, "NODE-A"),
      deadline_ms: now + 60_000, created_at_ms: now,
    }, "capability-key");
    const retryLease = finalizeExecutionNodeLeaseV2({
      packet: retryPacket, owner_hmac: sha("retry-worker-2"), expires_at_ms: now + 30_000, created_at_ms: now,
    });
    expect(() => store.transactExecutionV2({
      type: "LEASE_EXECUTION_NODE_V2", goalId: fixture.goalId, packet: retryPacket, lease: retryLease, ...providerLeaseAuthority(retryPacket),
    }, { expectedVersion: requeued.goalVersion, idempotencyKey: "execution-v2:retry:lease-2", actor: "RUNTIME", lease: fixture.lease }))
      .not.toThrow();
  });

  it("reclaims an expired lease through a durable typed outcome and exact next fence", () => {
    const { fixture, graph, version } = prepare();
    const store = fixture.authority.store;
    const now = fixture.authority.clock.now();
    const packet = createTaskPacketV2({
      graph, node_id: "NODE-A", attempt: 1, lease_generation: 1, fencing_token: 1,
      ...committedPacketClosure(graph, "NODE-A"),
      deadline_ms: now + 60_000, created_at_ms: now,
    }, "capability-key");
    const lease = finalizeExecutionNodeLeaseV2({
      packet, owner_hmac: sha("expiring-worker"), expires_at_ms: now + 10, created_at_ms: now,
    });
    const leased = store.transactExecutionV2({
      type: "LEASE_EXECUTION_NODE_V2", goalId: fixture.goalId, packet, lease, ...providerLeaseAuthority(packet),
    }, { expectedVersion: version, idempotencyKey: "execution-v2:expiry:lease", actor: "RUNTIME", lease: fixture.lease });
    const early = finalizeExecutionNodeAttemptOutcomeV2({
      graph, packet, lease, basis: "LEASE_EXPIRED", disposition: "REQUEUED", reason_code: "LEASE_TTL_ELAPSED",
      failure_sha256: sha("expired-lease"), predecessor_authority_head_sha256: leased.eventSha256,
      created_at_ms: now,
    });
    expect(() => store.transactExecutionV2({
      type: "RECORD_EXECUTION_NODE_ATTEMPT_OUTCOME_V2", goalId: fixture.goalId, outcome: early,
    }, { expectedVersion: leased.goalVersion, idempotencyKey: "execution-v2:expiry:early", actor: "RUNTIME", lease: fixture.lease }))
      .toThrow(/not expired/u);
    fixture.authority.clock.advance(11);
    expect(store.readExpiredExecutionNodeAttempts(fixture.run.run_id)).toMatchObject([{
      packet: { packet_id: packet.packet_id }, lease: { execution_node_lease_id: lease.execution_node_lease_id },
    }]);
    const providerTerminalVersion = recordProviderTerminal({
      fixture, packet, version: leased.goalVersion, unknown: true, suffix: "expired-outcome",
    });
    const expired = finalizeExecutionNodeAttemptOutcomeV2({
      graph, packet, lease, basis: "LEASE_EXPIRED", disposition: "REQUEUED", reason_code: "LEASE_TTL_ELAPSED",
      failure_sha256: sha("expired-lease"),
      predecessor_authority_head_sha256: store.readExecutionV2Preparation(
        fixture.goalId, fixture.run.run_id,
      ).predecessorAuthorityHeadSha256,
      created_at_ms: fixture.authority.clock.now(),
    });
    const requeued = store.transactExecutionV2({
      type: "RECORD_EXECUTION_NODE_ATTEMPT_OUTCOME_V2", goalId: fixture.goalId, outcome: expired,
    }, { expectedVersion: providerTerminalVersion, idempotencyKey: "execution-v2:expiry:reconcile", actor: "RUNTIME", lease: fixture.lease });
    expect(store.readExecutionV2(fixture.run.run_id, 1)).toMatchObject({
      readyDispatches: [{ nodeId: "NODE-A", attempt: 2, leaseGeneration: 2, fencingToken: 2, stopGeneration: 0 }],
    });
    const jumpedPacket = createTaskPacketV2({
      graph, node_id: "NODE-A", attempt: 2, lease_generation: 3, fencing_token: 3,
      ...committedPacketClosure(graph, "NODE-A"),
      deadline_ms: fixture.authority.clock.now() + 60_000, created_at_ms: fixture.authority.clock.now(),
    }, "capability-key");
    const jumpedLease = finalizeExecutionNodeLeaseV2({
      packet: jumpedPacket, owner_hmac: sha("jumped-worker"), expires_at_ms: fixture.authority.clock.now() + 30_000,
      created_at_ms: fixture.authority.clock.now(),
    });
    expect(() => store.transactExecutionV2({
      type: "LEASE_EXECUTION_NODE_V2", goalId: fixture.goalId, packet: jumpedPacket, lease: jumpedLease, ...providerLeaseAuthority(jumpedPacket),
    }, { expectedVersion: requeued.goalVersion, idempotencyKey: "execution-v2:expiry:jump", actor: "RUNTIME", lease: fixture.lease }))
      .toThrow(/non-contiguous/u);
  });

  it("keeps independent work runnable after one node exhausts its local attempts", () => {
    const { fixture, graph, version } = prepare("EVIDENCE_ACCEPTED", true);
    const store = fixture.authority.store;
    const now = fixture.authority.clock.now();
    const packet = createTaskPacketV2({
      graph, node_id: "NODE-A", attempt: 1, lease_generation: 1, fencing_token: 1,
      ...committedPacketClosure(graph, "NODE-A"),
      deadline_ms: now + 60_000, created_at_ms: now,
    }, "capability-key");
    const lease = finalizeExecutionNodeLeaseV2({
      packet, owner_hmac: sha("failed-node-worker"), expires_at_ms: now + 30_000, created_at_ms: now,
    });
    const leased = store.transactExecutionV2({
      type: "LEASE_EXECUTION_NODE_V2", goalId: fixture.goalId, packet, lease, ...providerLeaseAuthority(packet),
    }, { expectedVersion: version, idempotencyKey: "execution-v2:failed-node:lease", actor: "RUNTIME", lease: fixture.lease });
    const providerTerminalVersion = recordProviderTerminal({
      fixture, packet, version: leased.goalVersion, suffix: "failed-node-outcome",
    });
    const outcome = finalizeExecutionNodeAttemptOutcomeV2({
      graph, packet, lease, basis: "WORKER_FAILURE", disposition: "FAILED", reason_code: "LOCAL_ATTEMPTS_EXHAUSTED",
      failure_sha256: sha("terminal-local-node-failure"),
      predecessor_authority_head_sha256: store.readExecutionV2Preparation(
        fixture.goalId, fixture.run.run_id,
      ).predecessorAuthorityHeadSha256,
      created_at_ms: now,
    });
    store.transactExecutionV2({
      type: "RECORD_EXECUTION_NODE_ATTEMPT_OUTCOME_V2", goalId: fixture.goalId, outcome,
    }, { expectedVersion: providerTerminalVersion, idempotencyKey: "execution-v2:failed-node:outcome", actor: "RUNTIME", lease: fixture.lease });
    expect(store.readExecutionV2(fixture.run.run_id, 3)).toMatchObject({
      status: "RUNNING", readyNodeIds: ["NODE-B"], activeNodeIds: [], completedNodeIds: [],
    });
  });

  it("persists a durable stop generation and rejects a late proposal from the old fence", () => {
    const { fixture, graph, version } = prepare();
    const store = fixture.authority.store;
    const packet = createTaskPacketV2({
      graph, node_id: "NODE-A", attempt: 1, lease_generation: 1, fencing_token: 1,
      ...committedPacketClosure(graph, "NODE-A"),
      deadline_ms: fixture.authority.clock.now() + 60_000, created_at_ms: fixture.authority.clock.now(),
    }, "capability-key");
    const lease = finalizeExecutionNodeLeaseV2({
      packet, owner_hmac: sha("late-worker"), expires_at_ms: fixture.authority.clock.now() + 30_000,
      created_at_ms: fixture.authority.clock.now(),
    });
    const leased = store.transactExecutionV2({
      type: "LEASE_EXECUTION_NODE_V2", goalId: fixture.goalId, packet, lease, ...providerLeaseAuthority(packet),
    }, { expectedVersion: version, idempotencyKey: "execution-v2:late-lease", actor: "RUNTIME", lease: fixture.lease });
    const closure = store.readExecutionV2Preparation(fixture.goalId, fixture.run.run_id);
    const stop = finalizeExecutionStopV2({
      graph,
      stop_generation: 1,
      scope: "GRAPH_STOP",
      reason: "USER_CANCEL",
      affected_node_ids: ["NODE-A", "NODE-B"],
      predecessor_authority_head_sha256: closure.predecessorAuthorityHeadSha256,
      created_at_ms: fixture.authority.clock.now(),
    });
    const stopped = store.transactExecutionV2({
      type: "STOP_EXECUTION_V2", goalId: fixture.goalId, stop,
    }, { expectedVersion: leased.goalVersion, idempotencyKey: "execution-v2:stop", actor: "RUNTIME", lease: fixture.lease });
    expect(store.readExecutionV2(fixture.run.run_id, 2)).toMatchObject({
      status: "STOPPED", stopGeneration: 1, readyNodeIds: [], activeNodeIds: [],
    });
    const late = finalizeWorkerProposalV2({
      packet,
      kind: "EVIDENCE_PROPOSAL",
      payload: { artifact_refs: [{ sha256: sha("late-artifact"), classification: "INTERNAL" }] },
      created_at_ms: fixture.authority.clock.now(),
    });
    expect(() => store.transactExecutionV2({
      type: "SUBMIT_WORKER_PROPOSAL_V2", goalId: fixture.goalId, proposal: late, patchSet: null, artifacts: [],
    }, { expectedVersion: stopped.goalVersion, idempotencyKey: "execution-v2:late-proposal", actor: "RUNTIME", lease: fixture.lease }))
      .toThrow(/fenced by current execution authority/u);
    expect(store.verifyExecutionV2Integrity()).toMatchObject({ stops: 1, proposals: 0, mismatches: 0 });
  });

  it("invalidates only the material-change dependency closure while independent work continues", () => {
    const { fixture, graph, version } = prepare("EVIDENCE_ACCEPTED", true);
    const store = fixture.authority.store;
    const now = fixture.authority.clock.now();
    const dispatch = (nodeId: "NODE-A" | "NODE-B", owner: string, expectedVersion: number) => {
      const packet = createTaskPacketV2({
        graph, node_id: nodeId, attempt: 1, lease_generation: 1, fencing_token: 1,
        ...committedPacketClosure(graph, nodeId),
        deadline_ms: now + 60_000, created_at_ms: now,
      }, "capability-key");
      const lease = finalizeExecutionNodeLeaseV2({
        packet, owner_hmac: sha(owner), expires_at_ms: now + 30_000, created_at_ms: now,
      });
      const result = store.transactExecutionV2({
        type: "LEASE_EXECUTION_NODE_V2", goalId: fixture.goalId, packet, lease, ...providerLeaseAuthority(packet),
      }, { expectedVersion, idempotencyKey: `execution-v2:partial:${nodeId}:lease`, actor: "RUNTIME", lease: fixture.lease });
      return { packet, result };
    };
    const a = dispatch("NODE-A", "partial-a", version);
    const b = dispatch("NODE-B", "partial-b", a.result.goalVersion);
    const stopClosure = store.readExecutionV2Preparation(fixture.goalId, fixture.run.run_id);
    const stop = finalizeExecutionStopV2({
      graph, stop_generation: 1, scope: "PARTIAL_INVALIDATION", reason: "MATERIAL_CHANGE",
      affected_node_ids: ["NODE-A", "NODE-C"],
      predecessor_authority_head_sha256: stopClosure.predecessorAuthorityHeadSha256,
      created_at_ms: now,
    });
    const stopped = store.transactExecutionV2({
      type: "STOP_EXECUTION_V2", goalId: fixture.goalId, stop,
    }, { expectedVersion: b.result.goalVersion, idempotencyKey: "execution-v2:partial:stop", actor: "RUNTIME", lease: fixture.lease });
    expect(store.readExecutionV2(fixture.run.run_id, 3)).toMatchObject({
      status: "RUNNING", stopGeneration: 1, readyNodeIds: [], activeNodeIds: ["NODE-B"], completedNodeIds: [],
    });
    const lateA = finalizeWorkerProposalV2({
      packet: a.packet, kind: "EVIDENCE_PROPOSAL",
      payload: { artifact_refs: [{ sha256: sha("partial-late-a"), classification: "INTERNAL" }] },
      created_at_ms: now,
    });
    expect(() => store.transactExecutionV2({
      type: "SUBMIT_WORKER_PROPOSAL_V2", goalId: fixture.goalId, proposal: lateA, patchSet: null, artifacts: [],
    }, { expectedVersion: stopped.goalVersion, idempotencyKey: "execution-v2:partial:late-a", actor: "RUNTIME", lease: fixture.lease }))
      .toThrow(/fenced/u);
    const proposalB = finalizeWorkerProposalV2({
      packet: b.packet, kind: "EVIDENCE_PROPOSAL",
      payload: { artifact_refs: [{ sha256: sha("partial-b-evidence"), classification: "INTERNAL" }] },
      created_at_ms: now,
    });
    const providerTerminalVersion = recordProviderTerminal({
      fixture, packet: b.packet, version: stopped.goalVersion,
      successSha256: proposalB.record_sha256, suffix: "partial-b-proposal",
    });
    const proposedB = store.transactExecutionV2({
      type: "SUBMIT_WORKER_PROPOSAL_V2", goalId: fixture.goalId, proposal: proposalB, patchSet: null, artifacts: [],
    }, { expectedVersion: providerTerminalVersion, idempotencyKey: "execution-v2:partial:b:proposal", actor: "RUNTIME", lease: fixture.lease });
    const receiptClosure = store.readExecutionV2Preparation(fixture.goalId, fixture.run.run_id);
    const receiptB = finalizeHostNodeReceiptV2({
      graph, node_id: "NODE-B", packet_id: b.packet.packet_id, packet_sha256: b.packet.packet_sha256,
      proposal_id: proposalB.proposal_id, proposal_sha256: proposalB.record_sha256,
      kind: "EVIDENCE_ACCEPTED", evidence_sha256: sha("partial-host-b"),
      preimage_root_sha256: null, postimage_root_sha256: null, stop_generation: 0,
      predecessor_authority_head_sha256: receiptClosure.predecessorAuthorityHeadSha256,
      created_at_ms: now,
    });
    store.transactExecutionV2({
      type: "RECORD_HOST_NODE_RECEIPT_V2", goalId: fixture.goalId, receipt: receiptB,
    }, { expectedVersion: proposedB.goalVersion, idempotencyKey: "execution-v2:partial:b:receipt", actor: "RUNTIME", lease: fixture.lease });
    expect(store.readExecutionV2(fixture.run.run_id, 3)).toMatchObject({
      status: "RUNNING", stopGeneration: 1, readyNodeIds: [], activeNodeIds: [],
      completedNodeIds: [], oraclePendingNodeIds: ["NODE-B"],
    });
    expect(store.verifyExecutionV2Integrity()).toMatchObject({ stops: 1, hostReceipts: 1, mismatches: 0 });
  });

  it("keeps accepted evidence intermediate until every node has a fresh Host oracle", () => {
    const { fixture, graph, version } = prepare();
    const store = fixture.authority.store;
    expect(() => store.readExecutionGraphTerminalPreparation(fixture.run.run_id)).toThrow(/not terminal/u);
    const a = acceptEvidence(fixture, graph, "NODE-A", version, "terminal-a");
    acceptEvidence(fixture, graph, "NODE-B", a.version, "terminal-b");
    expect(store.readExecutionV2(fixture.run.run_id, 2)?.completedNodeIds).toEqual([]);
    expect(() => store.readExecutionGraphTerminalPreparation(fixture.run.run_id)).toThrow(/not terminal/u);
  });

  it("continuously backfills a capability DAG before the current worker wave settles", async () => {
    const { fixture, graph } = prepare("EVIDENCE_ACCEPTED", true);
    const started: string[] = [];
    let bReleased = false;
    let releaseB: () => void = () => { throw new Error("NODE-B was not started"); };
    const runtime = {
      provider: "test-provider", api: "test-api", model: "test-model",
      thinking_level: "high", context_window: 128_000,
    } as const;
    const resultFor = (packet: ReturnType<typeof createTaskPacketV2>) => {
      const proposal = finalizeWorkerProposalV2({
        packet, kind: "EVIDENCE_PROPOSAL",
        payload: { artifact_refs: [{ sha256: sha(`coordinator:${packet.node_id}`), classification: "INTERNAL" }] },
        created_at_ms: fixture.authority.clock.now(),
      });
      return {
        status: "PROPOSED" as const,
        proposal,
        patch_set: null,
        stopped: null,
        protocol: {
          schema_version: 2 as const, reason_code: null, submission_count: 1,
          assistant_text_is_display_only: true as const,
        },
        display_text: "",
        patches: [],
        usage: {
          input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0,
          cost: 0, turns: 1, tool_calls: 1, wall_time_ms: 1,
        },
        runtime_resolution: { runtime, source: "SUPERVISOR_INHERITED" as const, fallback_reason: null },
      };
    };
    const coordinator = new DynamicMultiCoordinator({
      authority: fixture.authority.store,
      mutation: coordinatorMutation(fixture),
      runId: fixture.run.run_id,
      workspace: fixture.authority.directory,
      capabilityKey: "coordinator-capability-key",
      supervisorRuntime: runtime,
      now: () => fixture.authority.clock.now(),
      worker: {
        execute(input) {
          started.push(input.packet.node_id);
          if (input.packet.node_id !== "NODE-B") return Promise.resolve(resultFor(input.packet));
          return new Promise((resolveB) => {
            releaseB = () => {
              bReleased = true;
              resolveB(resultFor(input.packet));
            };
          });
        },
      },
      evidence: {
        accept: async ({ proposal }) => ({ evidence_sha256: sha(`accepted:${proposal.proposal_id}`) }),
      },
      oracle: coordinatorOracle(fixture),
    });
    await coordinator.start(2);
    for (let attempt = 0; attempt < 100 && !started.includes("NODE-C"); attempt += 1) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 5));
    }
    expect(started.slice(0, 3)).toEqual(["NODE-A", "NODE-B", "NODE-C"]);
    expect(bReleased).toBe(false);
    expect(coordinator.poll()).toMatchObject({ active_worker_count: 1, peak_worker_count: 2 });
    releaseB();
    await expect(coordinator.wait()).resolves.toMatchObject({
      state: "SUCCEEDED", graph_status: "CLOSED", completed_node_ids: ["NODE-A", "NODE-B", "NODE-C"],
      peak_worker_count: 2,
    });
    expect(fixture.authority.store.verifyExecutionV2Integrity()).toMatchObject({
      hostOracleReceipts: 3, hostReceipts: 6, graphTerminalReceipts: 1, mismatches: 0,
    });
    void graph;
  });

  it("integrates a durable PatchSet through the serial Host authority before backfilling its successor", async () => {
    const { fixture, graph } = prepare("PATCH_INTEGRATED");
    const runtime = {
      provider: "test-provider", api: "test-api", model: "test-model",
      thinking_level: "high", context_window: 128_000,
    } as const;
    const started: string[] = [];
    const postimage = sha("coordinator-patch-postimage");
    const coordinator = new DynamicMultiCoordinator({
      authority: fixture.authority.store,
      mutation: coordinatorMutation(fixture),
      runId: fixture.run.run_id,
      workspace: fixture.authority.directory,
      capabilityKey: "coordinator-capability-key",
      supervisorRuntime: runtime,
      artifactStore: new ArtifactStore(fixture.authority.casPath),
      now: () => fixture.authority.clock.now(),
      worker: {
        async execute(input) {
          started.push(input.packet.node_id);
          if (input.packet.node_id === "NODE-A") {
            const content = Buffer.from("export const coordinatorPatch = true;\n");
            const patchSet = finalizeWorkerPatchSetV2({
              packet: input.packet,
              patches: [{ operation: "CREATE", path: "src/coordinator-patch.ts", beforeSha256: null, content }],
              created_at_ms: fixture.authority.clock.now(),
            });
            const proposal = finalizeWorkerProposalV2({
              packet: input.packet,
              kind: "PATCH_PROPOSAL",
              payload: {
                patch_set_id: patchSet.patch_set_id,
                patch_set_sha256: patchSet.record_sha256,
                affected_paths: patchSet.affected_paths,
                preimage_root_sha256: patchSet.baseline_sha256,
                proposed_postimage_root_sha256: patchSet.proposed_postimage_root_sha256,
              },
              created_at_ms: fixture.authority.clock.now(),
            });
            return {
              status: "PROPOSED" as const, proposal, patch_set: patchSet, stopped: null,
              protocol: { schema_version: 2 as const, reason_code: null, submission_count: 1, assistant_text_is_display_only: true as const },
              display_text: "", patches: [{ operation: "CREATE" as const, path: "src/coordinator-patch.ts", beforeSha256: null, content }],
              usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, cost: 0, turns: 1, tool_calls: 1, wall_time_ms: 1 },
              runtime_resolution: { runtime, source: "SUPERVISOR_INHERITED" as const, fallback_reason: null },
            };
          }
          const proposal = finalizeWorkerProposalV2({
            packet: input.packet,
            kind: "EVIDENCE_PROPOSAL",
            payload: { artifact_refs: [{ sha256: sha("coordinator-patch-successor"), classification: "INTERNAL" }] },
            created_at_ms: fixture.authority.clock.now(),
          });
          return {
            status: "PROPOSED" as const, proposal, patch_set: null, stopped: null,
            protocol: { schema_version: 2 as const, reason_code: null, submission_count: 1, assistant_text_is_display_only: true as const },
            display_text: "", patches: [],
            usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, cost: 0, turns: 1, tool_calls: 1, wall_time_ms: 1 },
            runtime_resolution: { runtime, source: "SUPERVISOR_INHERITED" as const, fallback_reason: null },
          };
        },
      },
      evidence: { accept: async ({ proposal }) => ({ evidence_sha256: sha(`accepted:${proposal.proposal_id}`) }) },
      oracle: coordinatorOracle(fixture),
      integration: {
        async prepare({ patch_set }) {
          return preparedExecutionIntegrationJournalFixture(fixture, patch_set);
        },
        async integrate(input) {
          expect(input.expected_preimage_root_sha256).toBe(graph.baseline_content_root_sha256);
          expect(input.artifacts).toHaveLength(1);
          expect(Buffer.from(input.artifacts[0]!.bytes).toString("utf8")).toContain("coordinatorPatch");
          return { status: "APPLIED" as const, postimage_root_sha256: postimage };
        },
        async observe() {
          throw new TypeError("Normal integration must not enter reconciliation");
        },
      },
    });
    await coordinator.start(2);
    await expect(coordinator.wait()).resolves.toMatchObject({
      state: "SUCCEEDED", graph_status: "CLOSED", completed_node_ids: ["NODE-A", "NODE-B"],
    });
    expect(started).toEqual(["NODE-A", "NODE-B"]);
    expect(fixture.authority.store.readExecutionV2(fixture.run.run_id, 1)).toMatchObject({
      currentPostimageRootSha256: postimage, integrationState: "COMMITTED",
    });
    expect(fixture.authority.store.verifyExecutionV2Integrity()).toMatchObject({
      patchSets: 1, patchArtifacts: 1, integrationAttempts: 1, integrationTransitions: 3,
      hostOracleReceipts: 2, hostReceipts: 4, graphTerminalReceipts: 1, mismatches: 0,
    });
  });

  it("serializes PREPARED to OBSERVED to COMMITTED and unlocks a successor only after the Host receipt", () => {
    const { fixture, graph, version } = prepare("PATCH_INTEGRATED");
    const store = fixture.authority.store;
    const patch = submitPatch(fixture, graph, version, "serial");
    const { attempt, prepared, journal } = integrationAttempt(fixture, graph, patch);
    const preparedResult = store.transactExecutionV2({
      type: "PREPARE_EXECUTION_INTEGRATION_V2", goalId: fixture.goalId, attempt, prepared, journal,
    }, { expectedVersion: patch.version, idempotencyKey: "execution-v2:serial:prepare", actor: "RUNTIME", lease: fixture.lease });
    expect(store.readExecutionV2(fixture.run.run_id, 2)?.readyNodeIds).toEqual([]);

    const postimage = sha("serial-postimage");
    const observed = finalizeExecutionIntegrationTransitionV2({
      attempt, ordinal: 1, state: "OBSERVED", predecessor_transition_sha256: prepared.record_sha256,
      postimage_root_sha256: postimage, failure_sha256: null,
      created_at_ms: fixture.authority.clock.now(),
    });
    const observedResult = store.transactExecutionV2({
      type: "TRANSITION_EXECUTION_INTEGRATION_V2", goalId: fixture.goalId, transition: observed,
    }, { expectedVersion: preparedResult.goalVersion, idempotencyKey: "execution-v2:serial:observe", actor: "RUNTIME", lease: fixture.lease });
    const committed = finalizeExecutionIntegrationTransitionV2({
      attempt, ordinal: 2, state: "COMMITTED", predecessor_transition_sha256: observed.record_sha256,
      postimage_root_sha256: postimage, failure_sha256: null,
      created_at_ms: fixture.authority.clock.now(),
    });
    const committedResult = store.transactExecutionV2({
      type: "TRANSITION_EXECUTION_INTEGRATION_V2", goalId: fixture.goalId, transition: committed,
    }, { expectedVersion: observedResult.goalVersion, idempotencyKey: "execution-v2:serial:commit", actor: "RUNTIME", lease: fixture.lease });
    expect(store.readExecutionV2(fixture.run.run_id, 2)).toMatchObject({
      readyNodeIds: [], activeNodeIds: ["NODE-A"], completedNodeIds: [],
    });

    const closure = store.readExecutionV2Preparation(fixture.goalId, fixture.run.run_id);
    const receipt = finalizeHostNodeReceiptV2({
      graph, node_id: "NODE-A", packet_id: patch.packet.packet_id, packet_sha256: patch.packet.packet_sha256,
      proposal_id: patch.proposal.proposal_id, proposal_sha256: patch.proposal.record_sha256,
      kind: "PATCH_INTEGRATED", evidence_sha256: sha("host-integration-evidence"),
      preimage_root_sha256: graph.baseline_content_root_sha256, postimage_root_sha256: postimage,
      stop_generation: 0,
      predecessor_authority_head_sha256: closure.predecessorAuthorityHeadSha256,
      created_at_ms: fixture.authority.clock.now(),
    });
    store.transactExecutionV2({
      type: "RECORD_HOST_NODE_RECEIPT_V2", goalId: fixture.goalId, receipt,
    }, { expectedVersion: committedResult.goalVersion, idempotencyKey: "execution-v2:serial:receipt", actor: "RUNTIME", lease: fixture.lease });
    expect(store.readExecutionV2(fixture.run.run_id, 2)).toMatchObject({
      readyNodeIds: ["NODE-B"], activeNodeIds: [], completedNodeIds: [], oraclePendingNodeIds: ["NODE-A"],
    });
    expect(store.verifyExecutionV2Integrity()).toMatchObject({
      packets: 1, proposals: 1, hostReceipts: 1, integrationAttempts: 1, integrationTransitions: 3, mismatches: 0,
    });
  });

  it("retains every current-proposal edge receipt after a later Host oracle receipt", () => {
    const { fixture, graph, version } = prepare("PATCH_INTEGRATED");
    const store = fixture.authority.store;
    const patch = submitPatch(fixture, graph, version, "receipt-history");
    const integration = integrationAttempt(fixture, graph, patch);
    let result = store.transactExecutionV2({
      type: "PREPARE_EXECUTION_INTEGRATION_V2", goalId: fixture.goalId, ...integration,
    }, { expectedVersion: patch.version, idempotencyKey: "execution-v2:receipt-history:prepare", actor: "RUNTIME", lease: fixture.lease });
    const postimage = sha("receipt-history-postimage");
    const observed = finalizeExecutionIntegrationTransitionV2({
      attempt: integration.attempt, ordinal: 1, state: "OBSERVED",
      predecessor_transition_sha256: integration.prepared.record_sha256,
      postimage_root_sha256: postimage, failure_sha256: null, created_at_ms: fixture.authority.clock.now(),
    });
    result = store.transactExecutionV2({
      type: "TRANSITION_EXECUTION_INTEGRATION_V2", goalId: fixture.goalId, transition: observed,
    }, { expectedVersion: result.goalVersion, idempotencyKey: "execution-v2:receipt-history:observe", actor: "RUNTIME", lease: fixture.lease });
    const committed = finalizeExecutionIntegrationTransitionV2({
      attempt: integration.attempt, ordinal: 2, state: "COMMITTED",
      predecessor_transition_sha256: observed.record_sha256,
      postimage_root_sha256: postimage, failure_sha256: null, created_at_ms: fixture.authority.clock.now(),
    });
    result = store.transactExecutionV2({
      type: "TRANSITION_EXECUTION_INTEGRATION_V2", goalId: fixture.goalId, transition: committed,
    }, { expectedVersion: result.goalVersion, idempotencyKey: "execution-v2:receipt-history:commit", actor: "RUNTIME", lease: fixture.lease });
    let authority = store.readExecutionV2Preparation(fixture.goalId, fixture.run.run_id);
    const integrated = finalizeHostNodeReceiptV2({
      graph, node_id: "NODE-A", packet_id: patch.packet.packet_id, packet_sha256: patch.packet.packet_sha256,
      proposal_id: patch.proposal.proposal_id, proposal_sha256: patch.proposal.record_sha256,
      kind: "PATCH_INTEGRATED", evidence_sha256: committed.record_sha256,
      preimage_root_sha256: graph.baseline_content_root_sha256, postimage_root_sha256: postimage,
      stop_generation: 0, predecessor_authority_head_sha256: authority.predecessorAuthorityHeadSha256,
      created_at_ms: fixture.authority.clock.now(),
    });
    result = store.transactExecutionV2({
      type: "RECORD_HOST_NODE_RECEIPT_V2", goalId: fixture.goalId, receipt: integrated,
    }, { expectedVersion: result.goalVersion, idempotencyKey: "execution-v2:receipt-history:integrated", actor: "RUNTIME", lease: fixture.lease });
    const staleValidation = recordValidationEvidence(
      fixture, result.goalVersion, graph.baseline_content_root_sha256, "RECEIPT-HISTORY-STALE",
    );
    authority = store.readExecutionV2Preparation(fixture.goalId, fixture.run.run_id);
    const staleOracle = finalizeHostOracleReceiptV2({
      graph, node_id: "NODE-A", packet_id: patch.packet.packet_id, packet_sha256: patch.packet.packet_sha256,
      proposal_id: patch.proposal.proposal_id, proposal_sha256: patch.proposal.record_sha256,
      postimage_root_sha256: graph.baseline_content_root_sha256,
      covered_obligation_ids: graph.nodes[0]!.obligation_ids,
      validation_evidence: staleValidation.evidence,
      predecessor_authority_head_sha256: authority.predecessorAuthorityHeadSha256,
      created_at_ms: fixture.authority.clock.now(),
    });
    expect(() => store.transactExecutionV2({
      type: "RECORD_HOST_ORACLE_RECEIPT_V2", goalId: fixture.goalId, receipt: staleOracle,
    }, { expectedVersion: staleValidation.version, idempotencyKey: "execution-v2:receipt-history:stale-oracle", actor: "RUNTIME", lease: fixture.lease }))
      .toThrow(/current postimage/u);
    const validation = recordValidationEvidence(fixture, staleValidation.version, postimage, "RECEIPT-HISTORY");
    authority = store.readExecutionV2Preparation(fixture.goalId, fixture.run.run_id);
    const oracle = finalizeHostOracleReceiptV2({
      graph, node_id: "NODE-A", packet_id: patch.packet.packet_id, packet_sha256: patch.packet.packet_sha256,
      proposal_id: patch.proposal.proposal_id, proposal_sha256: patch.proposal.record_sha256,
      postimage_root_sha256: postimage, covered_obligation_ids: graph.nodes[0]!.obligation_ids,
      validation_evidence: validation.evidence,
      predecessor_authority_head_sha256: authority.predecessorAuthorityHeadSha256,
      created_at_ms: fixture.authority.clock.now(),
    });
    result = store.transactExecutionV2({
      type: "RECORD_HOST_ORACLE_RECEIPT_V2", goalId: fixture.goalId, receipt: oracle,
    }, { expectedVersion: validation.version, idempotencyKey: "execution-v2:receipt-history:oracle", actor: "RUNTIME", lease: fixture.lease });
    authority = store.readExecutionV2Preparation(fixture.goalId, fixture.run.run_id);
    const passed = finalizeHostNodeReceiptV2({
      graph, node_id: "NODE-A", packet_id: patch.packet.packet_id, packet_sha256: patch.packet.packet_sha256,
      proposal_id: patch.proposal.proposal_id, proposal_sha256: patch.proposal.record_sha256,
      kind: "ORACLE_PASSED", evidence_sha256: oracle.record_sha256,
      preimage_root_sha256: null, postimage_root_sha256: null, stop_generation: 0,
      predecessor_authority_head_sha256: authority.predecessorAuthorityHeadSha256,
      created_at_ms: fixture.authority.clock.now(),
    });
    store.transactExecutionV2({
      type: "RECORD_HOST_NODE_RECEIPT_V2", goalId: fixture.goalId, receipt: passed,
    }, { expectedVersion: result.goalVersion, idempotencyKey: "execution-v2:receipt-history:passed", actor: "RUNTIME", lease: fixture.lease });
    expect(store.readExecutionV2(fixture.run.run_id, 1)?.readyNodeIds).toEqual(["NODE-B"]);
  });

  it("deduplicates CAS content while preserving one durable artifact reference per patched path", () => {
    const { fixture, graph, version } = prepare("PATCH_INTEGRATED");
    const store = fixture.authority.store;
    const now = fixture.authority.clock.now();
    const packet = createTaskPacketV2({
      graph, node_id: "NODE-A", attempt: 1, lease_generation: 1, fencing_token: 1,
      ...committedPacketClosure(graph, "NODE-A"),
      deadline_ms: now + 60_000, created_at_ms: now,
    }, "capability-key");
    const lease = finalizeExecutionNodeLeaseV2({
      packet, owner_hmac: sha("deduplicated-patch-worker"), expires_at_ms: now + 30_000, created_at_ms: now,
    });
    const leased = store.transactExecutionV2({
      type: "LEASE_EXECUTION_NODE_V2", goalId: fixture.goalId, packet, lease, ...providerLeaseAuthority(packet),
    }, { expectedVersion: version, idempotencyKey: "execution-v2:deduplicated:lease", actor: "RUNTIME", lease: fixture.lease });
    const content = Buffer.from("export const shared = true;\n");
    const patchSet = finalizeWorkerPatchSetV2({
      packet,
      patches: [
        { operation: "CREATE", path: "src/node-a.ts", beforeSha256: null, content },
        { operation: "CREATE", path: "src/node-a-copy.ts", beforeSha256: null, content },
      ],
      created_at_ms: now,
    });
    const proposal = finalizeWorkerProposalV2({
      packet, kind: "PATCH_PROPOSAL",
      payload: {
        patch_set_id: patchSet.patch_set_id, patch_set_sha256: patchSet.record_sha256,
        affected_paths: patchSet.affected_paths, preimage_root_sha256: patchSet.baseline_sha256,
        proposed_postimage_root_sha256: patchSet.proposed_postimage_root_sha256,
      },
      created_at_ms: now,
    });
    const { created: _created, ...artifact } = new ArtifactStore(fixture.authority.casPath).put(content, {
      mediaType: "application/octet-stream", classification: "INTERNAL", retentionClass: "GOAL",
    });
    void _created;
    const providerTerminalVersion = recordProviderTerminal({
      fixture, packet, version: leased.goalVersion, successSha256: proposal.record_sha256,
      suffix: "deduplicated-proposal",
    });
    store.transactExecutionV2({
      type: "SUBMIT_WORKER_PROPOSAL_V2", goalId: fixture.goalId, proposal, patchSet, artifacts: [artifact],
    }, { expectedVersion: providerTerminalVersion, idempotencyKey: "execution-v2:deduplicated:proposal", actor: "RUNTIME", lease: fixture.lease });
    const reopened = store.readWorkerPatchSetClosure(patchSet.patch_set_id);
    expect(reopened?.artifacts).toHaveLength(2);
    expect(new Set(reopened?.artifacts.map((member) => member.artifact.sha256))).toEqual(new Set([artifact.sha256]));
    expect(store.verifyExecutionV2Integrity()).toMatchObject({ patchSets: 1, patchArtifacts: 2, mismatches: 0 });
    const restarted = AuthorityStore.open({
      databasePath: fixture.authority.databasePath,
      migrationPath: resolve("schemas", "sql", "001_core.sql"),
      memoryMigrations: taskFlowMemoryMigrations,
      taskFlowMigrationPath: resolve("schemas", "sql", "011_task_flow_kernel_v1.sql"),
      inputContextMigrationPath: resolve("schemas", "sql", "012_input_context_v1.sql"),
      harnessMigrationPath: resolve("schemas", "sql", "013_coding_harness_v1.sql"),
      clock: fixture.authority.clock,
    });
    try {
      expect(restarted.readWorkerPatchSetClosure(patchSet.patch_set_id)?.patchSet.record_sha256)
        .toBe(patchSet.record_sha256);
    } finally { restarted.close(); }
    const attacker = new DatabaseSync(fixture.authority.databasePath, { timeout: 5_000 });
    try {
      attacker.exec("DROP TRIGGER no_update_worker_patch_set_artifacts_v2");
      attacker.prepare(`UPDATE worker_patch_set_artifacts_v2 SET byte_length=byte_length+1
        WHERE patch_set_id=? AND path=?`).run(patchSet.patch_set_id, "src/node-a.ts");
    } finally { attacker.close(); }
    expect(() => store.verifyExecutionV2Integrity()).toThrow(/integrity|PatchSet/u);
  });

  it("rejects integration when the durable PatchSet sidecar is missing", () => {
    const { fixture, graph, version } = prepare("PATCH_INTEGRATED");
    const patch = submitPatch(fixture, graph, version, "missing-sidecar");
    const attacker = new DatabaseSync(fixture.authority.databasePath, { timeout: 5_000 });
    try {
      attacker.exec("PRAGMA foreign_keys=OFF");
      attacker.exec("DROP TRIGGER no_delete_worker_patch_set_artifacts_v2");
      attacker.exec("DROP TRIGGER no_delete_worker_patch_sets_v2");
      attacker.prepare("DELETE FROM worker_patch_set_artifacts_v2 WHERE patch_set_id=?")
        .run(patch.patchSet.patch_set_id);
      attacker.prepare("DELETE FROM worker_patch_sets_v2 WHERE patch_set_id=?")
        .run(patch.patchSet.patch_set_id);
    } finally { attacker.close(); }
    const integration = integrationAttempt(fixture, graph, patch);
    expect(() => fixture.authority.store.transactExecutionV2({
      type: "PREPARE_EXECUTION_INTEGRATION_V2", goalId: fixture.goalId, ...integration,
    }, { expectedVersion: patch.version, idempotencyKey: "execution-v2:missing-sidecar:prepare", actor: "RUNTIME", lease: fixture.lease }))
      .toThrow(/integration|PatchSet|constraint/u);
    expect(() => fixture.authority.store.verifyExecutionV2Integrity()).toThrow(/integrity|PatchSet/u);
  });

  it("rejects an ORACLE_PASSED receipt that cites only a Worker-selected hash", () => {
    const { fixture, graph, version } = prepare("ORACLE_PASSED");
    const store = fixture.authority.store;
    const now = fixture.authority.clock.now();
    const packet = createTaskPacketV2({
      graph, node_id: "NODE-A", attempt: 1, lease_generation: 1, fencing_token: 1,
      ...committedPacketClosure(graph, "NODE-A"),
      deadline_ms: now + 60_000, created_at_ms: now,
    }, "capability-key");
    const lease = finalizeExecutionNodeLeaseV2({
      packet, owner_hmac: sha("oracle-worker"), expires_at_ms: now + 30_000, created_at_ms: now,
    });
    const leased = store.transactExecutionV2({
      type: "LEASE_EXECUTION_NODE_V2", goalId: fixture.goalId, packet, lease, ...providerLeaseAuthority(packet),
    }, { expectedVersion: version, idempotencyKey: "execution-v2:oracle:lease", actor: "RUNTIME", lease: fixture.lease });
    const proposal = finalizeWorkerProposalV2({
      packet, kind: "EVIDENCE_PROPOSAL",
      payload: { artifact_refs: [{ sha256: sha("oracle-candidate"), classification: "INTERNAL" }] },
      created_at_ms: now,
    });
    const providerTerminalVersion = recordProviderTerminal({
      fixture, packet, version: leased.goalVersion, successSha256: proposal.record_sha256,
      suffix: "oracle-proposal",
    });
    const proposed = store.transactExecutionV2({
      type: "SUBMIT_WORKER_PROPOSAL_V2", goalId: fixture.goalId, proposal, patchSet: null, artifacts: [],
    }, { expectedVersion: providerTerminalVersion, idempotencyKey: "execution-v2:oracle:proposal", actor: "RUNTIME", lease: fixture.lease });
    const acceptedClosure = store.readExecutionV2Preparation(fixture.goalId, fixture.run.run_id);
    const accepted = finalizeHostNodeReceiptV2({
      graph, node_id: "NODE-A", packet_id: packet.packet_id, packet_sha256: packet.packet_sha256,
      proposal_id: proposal.proposal_id, proposal_sha256: proposal.record_sha256,
      kind: "EVIDENCE_ACCEPTED", evidence_sha256: sha("host-evidence"),
      preimage_root_sha256: null, postimage_root_sha256: null,
      stop_generation: 0, predecessor_authority_head_sha256: acceptedClosure.predecessorAuthorityHeadSha256,
      created_at_ms: now,
    });
    const acceptedResult = store.transactExecutionV2({
      type: "RECORD_HOST_NODE_RECEIPT_V2", goalId: fixture.goalId, receipt: accepted,
    }, { expectedVersion: proposed.goalVersion, idempotencyKey: "execution-v2:oracle:accepted", actor: "RUNTIME", lease: fixture.lease });
    const oracleClosure = store.readExecutionV2Preparation(fixture.goalId, fixture.run.run_id);
    const unprovenOracle = finalizeHostNodeReceiptV2({
      graph, node_id: "NODE-A", packet_id: packet.packet_id, packet_sha256: packet.packet_sha256,
      proposal_id: proposal.proposal_id, proposal_sha256: proposal.record_sha256,
      kind: "ORACLE_PASSED", evidence_sha256: sha("arbitrary-oracle-evidence"),
      preimage_root_sha256: null, postimage_root_sha256: null,
      stop_generation: 0,
      predecessor_authority_head_sha256: oracleClosure.predecessorAuthorityHeadSha256,
      created_at_ms: now,
    });
    expect(() => store.transactExecutionV2({
      type: "RECORD_HOST_NODE_RECEIPT_V2", goalId: fixture.goalId, receipt: unprovenOracle,
    }, { expectedVersion: acceptedResult.goalVersion, idempotencyKey: "execution-v2:oracle:unproven", actor: "RUNTIME", lease: fixture.lease }))
      .toThrow(/Host OracleReceipt/u);
  });

  it("unlocks ORACLE_PASSED only from a durable current Host validation closure", () => {
    const { fixture, graph, version } = prepare("ORACLE_PASSED");
    const store = fixture.authority.store;
    const now = fixture.authority.clock.now();
    const packet = createTaskPacketV2({
      graph, node_id: "NODE-A", attempt: 1, lease_generation: 1, fencing_token: 1,
      ...committedPacketClosure(graph, "NODE-A"),
      deadline_ms: now + 60_000, created_at_ms: now,
    }, "capability-key");
    const lease = finalizeExecutionNodeLeaseV2({
      packet, owner_hmac: sha("real-oracle-worker"), expires_at_ms: now + 30_000, created_at_ms: now,
    });
    const leased = store.transactExecutionV2({
      type: "LEASE_EXECUTION_NODE_V2", goalId: fixture.goalId, packet, lease, ...providerLeaseAuthority(packet),
    }, { expectedVersion: version, idempotencyKey: "execution-v2:real-oracle:lease", actor: "RUNTIME", lease: fixture.lease });
    const proposal = finalizeWorkerProposalV2({
      packet, kind: "EVIDENCE_PROPOSAL",
      payload: { artifact_refs: [{ sha256: sha("real-oracle-candidate"), classification: "INTERNAL" }] },
      created_at_ms: now,
    });
    const providerTerminalVersion = recordProviderTerminal({
      fixture, packet, version: leased.goalVersion, successSha256: proposal.record_sha256,
      suffix: "real-oracle-proposal",
    });
    const proposed = store.transactExecutionV2({
      type: "SUBMIT_WORKER_PROPOSAL_V2", goalId: fixture.goalId, proposal, patchSet: null, artifacts: [],
    }, { expectedVersion: providerTerminalVersion, idempotencyKey: "execution-v2:real-oracle:proposal", actor: "RUNTIME", lease: fixture.lease });
    const acceptedClosure = store.readExecutionV2Preparation(fixture.goalId, fixture.run.run_id);
    const accepted = finalizeHostNodeReceiptV2({
      graph, node_id: "NODE-A", packet_id: packet.packet_id, packet_sha256: packet.packet_sha256,
      proposal_id: proposal.proposal_id, proposal_sha256: proposal.record_sha256,
      kind: "EVIDENCE_ACCEPTED", evidence_sha256: sha("real-host-evidence"),
      preimage_root_sha256: null, postimage_root_sha256: null,
      stop_generation: 0, predecessor_authority_head_sha256: acceptedClosure.predecessorAuthorityHeadSha256,
      created_at_ms: now,
    });
    const acceptedResult = store.transactExecutionV2({
      type: "RECORD_HOST_NODE_RECEIPT_V2", goalId: fixture.goalId, receipt: accepted,
    }, { expectedVersion: proposed.goalVersion, idempotencyKey: "execution-v2:real-oracle:accepted", actor: "RUNTIME", lease: fixture.lease });
    const validation = recordValidationEvidence(
      fixture, acceptedResult.goalVersion, fixture.baseline.content_root_sha256, "REAL-ORACLE",
    );
    const oracleClosure = store.readExecutionV2Preparation(fixture.goalId, fixture.run.run_id);
    const oracle = finalizeHostOracleReceiptV2({
      graph, node_id: "NODE-A", packet_id: packet.packet_id, packet_sha256: packet.packet_sha256,
      proposal_id: proposal.proposal_id, proposal_sha256: proposal.record_sha256,
      postimage_root_sha256: fixture.baseline.content_root_sha256,
      covered_obligation_ids: graph.nodes[0]!.obligation_ids,
      validation_evidence: validation.evidence,
      predecessor_authority_head_sha256: oracleClosure.predecessorAuthorityHeadSha256,
      created_at_ms: now,
    });
    const oracleResult = store.transactExecutionV2({
      type: "RECORD_HOST_ORACLE_RECEIPT_V2", goalId: fixture.goalId, receipt: oracle,
    }, { expectedVersion: validation.version, idempotencyKey: "execution-v2:real-oracle:receipt", actor: "RUNTIME", lease: fixture.lease });
    const passedClosure = store.readExecutionV2Preparation(fixture.goalId, fixture.run.run_id);
    const passed = finalizeHostNodeReceiptV2({
      graph, node_id: "NODE-A", packet_id: packet.packet_id, packet_sha256: packet.packet_sha256,
      proposal_id: proposal.proposal_id, proposal_sha256: proposal.record_sha256,
      kind: "ORACLE_PASSED", evidence_sha256: oracle.record_sha256,
      preimage_root_sha256: null, postimage_root_sha256: null,
      stop_generation: 0, predecessor_authority_head_sha256: passedClosure.predecessorAuthorityHeadSha256,
      created_at_ms: now,
    });
    store.transactExecutionV2({
      type: "RECORD_HOST_NODE_RECEIPT_V2", goalId: fixture.goalId, receipt: passed,
    }, { expectedVersion: oracleResult.goalVersion, idempotencyKey: "execution-v2:real-oracle:passed", actor: "RUNTIME", lease: fixture.lease });
    expect(store.readExecutionV2(fixture.run.run_id, 2)).toMatchObject({
      readyNodeIds: ["NODE-B"], activeNodeIds: [], completedNodeIds: ["NODE-A"],
    });
    expect(store.verifyExecutionV2Integrity()).toMatchObject({
      hostOracleReceipts: 1, hostOracleEvidence: validation.evidence.length, hostReceipts: 2, mismatches: 0,
    });
    const attacker = new DatabaseSync(fixture.authority.databasePath, { timeout: 5_000 });
    try {
      attacker.exec("DROP TRIGGER no_update_host_oracle_evidence_members_v2");
      attacker.prepare(`UPDATE host_oracle_evidence_members_v2 SET record_sha256=?
        WHERE host_oracle_receipt_id=? AND ordinal=0`).run(sha("tampered-oracle-member"), oracle.host_oracle_receipt_id);
    } finally { attacker.close(); }
    expect(() => store.verifyExecutionV2Integrity()).toThrow(/integrity/u);
  });

  it("grants serial authority to one live attempt and permits retry only after confirmed rejection", () => {
    const { fixture, graph, version } = prepare("PATCH_INTEGRATED");
    const store = fixture.authority.store;
    const patch = submitPatch(fixture, graph, version, "cas");

    const wrongAuthorization = integrationAttempt(fixture, graph, patch, { authorization: sha("stale-authorization") });
    expect(() => store.transactExecutionV2({
      type: "PREPARE_EXECUTION_INTEGRATION_V2", goalId: fixture.goalId,
      attempt: wrongAuthorization.attempt, prepared: wrongAuthorization.prepared, journal: wrongAuthorization.journal,
    }, { expectedVersion: patch.version, idempotencyKey: "execution-v2:cas:authorization", actor: "RUNTIME", lease: fixture.lease }))
      .toThrow(/authority CAS/u);

    const wrongFence = integrationAttempt(fixture, graph, patch, { generation: 2, fence: 2 });
    expect(() => store.transactExecutionV2({
      type: "PREPARE_EXECUTION_INTEGRATION_V2", goalId: fixture.goalId,
      attempt: wrongFence.attempt, prepared: wrongFence.prepared, journal: wrongFence.journal,
    }, { expectedVersion: patch.version, idempotencyKey: "execution-v2:cas:fence", actor: "RUNTIME", lease: fixture.lease }))
      .toThrow(/authority CAS/u);

    const first = integrationAttempt(fixture, graph, patch);
    const preparedResult = store.transactExecutionV2({
      type: "PREPARE_EXECUTION_INTEGRATION_V2", goalId: fixture.goalId, ...first,
    }, { expectedVersion: patch.version, idempotencyKey: "execution-v2:cas:first", actor: "RUNTIME", lease: fixture.lease });
    const rejected = finalizeExecutionIntegrationTransitionV2({
      attempt: first.attempt, ordinal: 1, state: "REJECTED", predecessor_transition_sha256: first.prepared.record_sha256,
      postimage_root_sha256: null, failure_sha256: sha("integration-rejected"),
      created_at_ms: fixture.authority.clock.now(),
    });
    const rejectedResult = store.transactExecutionV2({
      type: "TRANSITION_EXECUTION_INTEGRATION_V2", goalId: fixture.goalId, transition: rejected,
    }, { expectedVersion: preparedResult.goalVersion, idempotencyKey: "execution-v2:cas:reject", actor: "RUNTIME", lease: fixture.lease });
    const duplicatePreimage = integrationAttempt(fixture, graph, patch, { generation: 2, fence: 2 });
    store.transactExecutionV2({
      type: "PREPARE_EXECUTION_INTEGRATION_V2", goalId: fixture.goalId, ...duplicatePreimage,
    }, { expectedVersion: rejectedResult.goalVersion, idempotencyKey: "execution-v2:cas:duplicate", actor: "RUNTIME", lease: fixture.lease });
    expect(store.verifyExecutionV2Integrity()).toMatchObject({ integrationAttempts: 2, integrationTransitions: 3, mismatches: 0 });
  });

  it("fences integration transitions immediately after authorization revocation", () => {
    const { fixture, graph, version } = prepare("PATCH_INTEGRATED");
    const patch = submitPatch(fixture, graph, version, "revoked");
    const integration = integrationAttempt(fixture, graph, patch);
    const prepared = fixture.authority.store.transactExecutionV2({
      type: "PREPARE_EXECUTION_INTEGRATION_V2", goalId: fixture.goalId, ...integration,
    }, { expectedVersion: patch.version, idempotencyKey: "execution-v2:revoked:prepare", actor: "RUNTIME", lease: fixture.lease });
    const attacker = new DatabaseSync(fixture.authority.databasePath, { timeout: 5_000 });
    try {
      attacker.prepare("UPDATE execution_authorizations_v1 SET revoked_at_ms=? WHERE authorization_id=?")
        .run(fixture.authority.clock.now(), graph.authorization_id);
    } finally { attacker.close(); }
    const observed = finalizeExecutionIntegrationTransitionV2({
      attempt: integration.attempt, ordinal: 1, state: "OBSERVED",
      predecessor_transition_sha256: integration.prepared.record_sha256,
      postimage_root_sha256: sha("revoked-postimage"), failure_sha256: null,
      created_at_ms: fixture.authority.clock.now(),
    });
    expect(() => fixture.authority.store.transactExecutionV2({
      type: "TRANSITION_EXECUTION_INTEGRATION_V2", goalId: fixture.goalId, transition: observed,
    }, { expectedVersion: prepared.goalVersion, idempotencyKey: "execution-v2:revoked:observe", actor: "RUNTIME", lease: fixture.lease }))
      .toThrow(/authorization|fenced/u);
  });

  it.each(["GRAPH_STOP", "AUTHORIZATION_REVOKE"] as const)(
    "rejects a late Host evidence receipt after %s without persisting it",
    (trigger) => {
      const { fixture, graph, version } = prepare();
      const store = fixture.authority.store;
      const now = fixture.authority.clock.now();
      const packet = createTaskPacketV2({
        graph, node_id: "NODE-A", attempt: 1, lease_generation: 1, fencing_token: 1,
        ...committedPacketClosure(graph, "NODE-A"),
        deadline_ms: now + 60_000, created_at_ms: now,
      }, "capability-key");
      const lease = finalizeExecutionNodeLeaseV2({
        packet, owner_hmac: sha(`late-receipt:${trigger}`), expires_at_ms: now + 30_000, created_at_ms: now,
      });
      const leased = store.transactExecutionV2({
        type: "LEASE_EXECUTION_NODE_V2", goalId: fixture.goalId, packet, lease, ...providerLeaseAuthority(packet),
      }, {
        expectedVersion: version, idempotencyKey: `execution-v2:late:${trigger}:lease`,
        actor: "RUNTIME", lease: fixture.lease,
      });
      const proposal = finalizeWorkerProposalV2({
        packet, kind: "EVIDENCE_PROPOSAL",
        payload: { artifact_refs: [{ sha256: sha(`late:${trigger}`), classification: "INTERNAL" }] },
        created_at_ms: now,
      });
      const providerTerminalVersion = recordProviderTerminal({
        fixture, packet, version: leased.goalVersion, successSha256: proposal.record_sha256,
        suffix: `late-${trigger}-proposal`,
      });
      const proposed = store.transactExecutionV2({
        type: "SUBMIT_WORKER_PROPOSAL_V2", goalId: fixture.goalId,
        proposal, patchSet: null, artifacts: [],
      }, {
        expectedVersion: providerTerminalVersion, idempotencyKey: `execution-v2:late:${trigger}:proposal`,
        actor: "RUNTIME", lease: fixture.lease,
      });
      let expectedVersion = proposed.goalVersion;
      let receiptPredecessor = store.readExecutionV2Preparation(
        fixture.goalId, fixture.run.run_id,
      ).predecessorAuthorityHeadSha256;
      if (trigger === "GRAPH_STOP") {
        const stopClosure = store.readExecutionV2Preparation(fixture.goalId, fixture.run.run_id);
        const stop = finalizeExecutionStopV2({
          graph, stop_generation: 1, scope: "GRAPH_STOP", reason: "USER_CANCEL",
          affected_node_ids: graph.nodes.map((node) => node.node_id),
          predecessor_authority_head_sha256: stopClosure.predecessorAuthorityHeadSha256,
          created_at_ms: now,
        });
        expectedVersion = store.transactExecutionV2({
          type: "STOP_EXECUTION_V2", goalId: fixture.goalId, stop,
        }, {
          expectedVersion, idempotencyKey: "execution-v2:late:stop",
          actor: "RUNTIME", lease: fixture.lease,
        }).goalVersion;
        receiptPredecessor = store.readExecutionV2Preparation(
          fixture.goalId, fixture.run.run_id,
        ).predecessorAuthorityHeadSha256;
      } else {
        const writer = new DatabaseSync(fixture.authority.databasePath, { timeout: 5_000 });
        try {
          writer.prepare("UPDATE execution_authorizations_v1 SET revoked_at_ms=? WHERE authorization_id=?")
            .run(now, graph.authorization_id);
        } finally { writer.close(); }
      }
      const receipt = finalizeHostNodeReceiptV2({
        graph, node_id: "NODE-A", packet_id: packet.packet_id, packet_sha256: packet.packet_sha256,
        proposal_id: proposal.proposal_id, proposal_sha256: proposal.record_sha256,
        kind: "EVIDENCE_ACCEPTED", evidence_sha256: sha(`late-host:${trigger}`),
        preimage_root_sha256: null, postimage_root_sha256: null, stop_generation: 0,
        predecessor_authority_head_sha256: receiptPredecessor,
        created_at_ms: now,
      });
      expect(() => store.transactExecutionV2({
        type: "RECORD_HOST_NODE_RECEIPT_V2", goalId: fixture.goalId, receipt,
      }, {
        expectedVersion, idempotencyKey: `execution-v2:late:${trigger}:receipt`,
        actor: "RUNTIME", lease: fixture.lease,
      })).toThrow(/authority|authorization|current graph/u);
      const read = new DatabaseSync(fixture.authority.databasePath, { readOnly: true });
      try {
        expect(Number((read.prepare("SELECT count(*) count FROM host_node_receipts_v2").get() as { count: number }).count))
          .toBe(0);
      } finally { read.close(); }
    },
  );

  it("rebuilds all execution records after reopen and detects direct SQL tamper", () => {
    const { fixture, graph, version } = prepare();
    const store = fixture.authority.store;
    const packet = createTaskPacketV2({
      graph, node_id: "NODE-A", attempt: 1, lease_generation: 1, fencing_token: 1,
      ...committedPacketClosure(graph, "NODE-A"),
      deadline_ms: fixture.authority.clock.now() + 60_000, created_at_ms: fixture.authority.clock.now(),
    }, "capability-key");
    const lease = finalizeExecutionNodeLeaseV2({
      packet, owner_hmac: sha("restart-owner"), expires_at_ms: fixture.authority.clock.now() + 30_000,
      created_at_ms: fixture.authority.clock.now(),
    });
    store.transactExecutionV2({ type: "LEASE_EXECUTION_NODE_V2", goalId: fixture.goalId, packet, lease, ...providerLeaseAuthority(packet) }, {
      expectedVersion: version, idempotencyKey: "execution-v2:restart:lease", actor: "RUNTIME", lease: fixture.lease,
    });
    const reopened = AuthorityStore.open({
      databasePath: fixture.authority.databasePath,
      migrationPath: resolve("schemas", "sql", "001_core.sql"),
      memoryMigrations: taskFlowMemoryMigrations,
      taskFlowMigrationPath: resolve("schemas", "sql", "011_task_flow_kernel_v1.sql"),
      inputContextMigrationPath: resolve("schemas", "sql", "012_input_context_v1.sql"),
      harnessMigrationPath: resolve("schemas", "sql", "013_coding_harness_v1.sql"),
      clock: fixture.authority.clock,
    });
    try {
      expect(reopened.readExecutionV2(fixture.run.run_id, 2)).toMatchObject({ activeNodeIds: ["NODE-A"] });
      expect(reopened.verifyExecutionV2Integrity()).toMatchObject({ packets: 1, leases: 1, mismatches: 0 });
    } finally { reopened.close(); }

    const attacker = new DatabaseSync(fixture.authority.databasePath, { timeout: 5_000 });
    try {
      expect(() => attacker.prepare("UPDATE task_packets_v2 SET packet_sha256=? WHERE packet_id=?")
        .run(sha("tampered-packet"), packet.packet_id)).toThrow(/immutable/u);
      attacker.prepare(`UPDATE execution_node_heads_v2 SET latest_packet_sha256=?
        WHERE execution_graph_revision_id=? AND node_id=?`).run(
        sha("tampered-head"), graph.execution_graph_revision_id, "NODE-A",
      );
    } finally { attacker.close(); }
    expect(() => store.verifyExecutionV2Integrity()).toThrow(/integrity/u);
  });

  it("rolls back integration authority, event and receipt at every pre-commit transaction fault", () => {
    const { fixture, graph, version } = prepare("PATCH_INTEGRATED");
    const patch = submitPatch(fixture, graph, version, "fault");
    const integration = integrationAttempt(fixture, graph, patch);
    const command = {
      type: "PREPARE_EXECUTION_INTEGRATION_V2" as const, goalId: fixture.goalId, ...integration,
    };
    for (const faultPoint of beforeCommitFaults) {
      expect(() => fixture.authority.store.transactExecutionV2(command, {
        expectedVersion: patch.version, idempotencyKey: `execution-v2:fault:${faultPoint}`,
        actor: "RUNTIME", lease: fixture.lease,
      }, (point) => {
        if (point === faultPoint) throw new Error(`FAULT:${point}`);
      })).toThrow(`FAULT:${faultPoint}`);
      expect(fixture.authority.store.verifyExecutionV2Integrity()).toMatchObject({
        integrationAttempts: 0, integrationTransitions: 0, mismatches: 0,
      });
    }
    fixture.authority.store.transactExecutionV2(command, {
      expectedVersion: patch.version, idempotencyKey: "execution-v2:fault:commit", actor: "RUNTIME", lease: fixture.lease,
    });
    expect(fixture.authority.store.verifyExecutionV2Integrity()).toMatchObject({
      integrationAttempts: 1, integrationTransitions: 1, mismatches: 0,
    });
  });

  it("atomically rolls back proposal, PatchSet and artifact metadata at every pre-commit fault", () => {
    const { fixture, graph, version } = prepare("PATCH_INTEGRATED");
    const now = fixture.authority.clock.now();
    const packet = createTaskPacketV2({
      graph, node_id: "NODE-A", attempt: 1, lease_generation: 1, fencing_token: 1,
      ...committedPacketClosure(graph, "NODE-A"),
      deadline_ms: now + 60_000, created_at_ms: now,
    }, "capability-key");
    const lease = finalizeExecutionNodeLeaseV2({
      packet, owner_hmac: sha("proposal-fault-worker"), expires_at_ms: now + 30_000, created_at_ms: now,
    });
    const leased = fixture.authority.store.transactExecutionV2({
      type: "LEASE_EXECUTION_NODE_V2", goalId: fixture.goalId, packet, lease, ...providerLeaseAuthority(packet),
    }, { expectedVersion: version, idempotencyKey: "execution-v2:proposal-fault:lease", actor: "RUNTIME", lease: fixture.lease });
    const content = Buffer.from("export const faultAtomic = true;\n");
    const patchSet = finalizeWorkerPatchSetV2({
      packet, patches: [{ operation: "CREATE", path: "src/fault-atomic.ts", beforeSha256: null, content }],
      created_at_ms: now,
    });
    const proposal = finalizeWorkerProposalV2({
      packet, kind: "PATCH_PROPOSAL",
      payload: {
        patch_set_id: patchSet.patch_set_id, patch_set_sha256: patchSet.record_sha256,
        affected_paths: patchSet.affected_paths, preimage_root_sha256: patchSet.baseline_sha256,
        proposed_postimage_root_sha256: patchSet.proposed_postimage_root_sha256,
      },
      created_at_ms: now,
    });
    const { created: _created, ...artifact } = new ArtifactStore(fixture.authority.casPath).put(content, {
      mediaType: "application/octet-stream", classification: "INTERNAL", retentionClass: "GOAL",
    });
    void _created;
    const providerTerminalVersion = recordProviderTerminal({
      fixture, packet, version: leased.goalVersion, successSha256: proposal.record_sha256,
      suffix: "proposal-fault",
    });
    const command = {
      type: "SUBMIT_WORKER_PROPOSAL_V2" as const, goalId: fixture.goalId,
      proposal, patchSet, artifacts: [artifact],
    };
    for (const faultPoint of beforeCommitFaults) {
      expect(() => fixture.authority.store.transactExecutionV2(command, {
        expectedVersion: providerTerminalVersion, idempotencyKey: `execution-v2:proposal-fault:${faultPoint}`,
        actor: "RUNTIME", lease: fixture.lease,
      }, (point) => {
        if (point === faultPoint) throw new Error(`FAULT:${point}`);
      })).toThrow(`FAULT:${faultPoint}`);
      expect(fixture.authority.store.verifyExecutionV2Integrity()).toMatchObject({
        proposals: 0, patchSets: 0, patchArtifacts: 0, mismatches: 0,
      });
    }
    fixture.authority.store.transactExecutionV2(command, {
      expectedVersion: providerTerminalVersion, idempotencyKey: "execution-v2:proposal-fault:commit",
      actor: "RUNTIME", lease: fixture.lease,
    });
    expect(fixture.authority.store.verifyExecutionV2Integrity()).toMatchObject({
      proposals: 1, patchSets: 1, patchArtifacts: 1, mismatches: 0,
    });
  });
});
