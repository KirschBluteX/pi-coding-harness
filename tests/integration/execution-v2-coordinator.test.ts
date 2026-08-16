import { afterEach, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ArtifactStore } from "../../src/artifacts/artifact-store.js";
import { AuthorityStore } from "../../src/authority/transactions.js";
import { canonicalJsonSha256 } from "../../src/authority/canonical-json.js";
import { hmacSha256Hex, sha256Hex } from "../../src/foundation/crypto.js";
import { idFromSha256 } from "../../src/foundation/ids.js";
import { DynamicMultiCoordinator } from "../../src/harness/execution-v2/coordinator.js";
import { createWorkerProviderDispatchAuthorityV1 } from "../../src/provider-v2/worker-plan.js";
import { sealHarnessRecord, type TopologyRevisionRecord } from "../../src/harness/domain.js";
import { finalizeExecutionGraphV2 } from "../../src/harness/execution-v2/dag.js";
import {
  executionNodeInputClosureV2,
  finalizeExecutionNodeLeaseV2,
  finalizeWorkerPatchSetV2,
  finalizeWorkerProposalV2,
  type ExecutionEdgeConditionV2,
  type ExecutionNodeSpecV2,
  type TaskPacketV2,
} from "../../src/harness/execution-v2/domain.js";
import type { WorkerAttemptResultV2 } from "../../src/harness/worker/attempt-executor-v2.js";
import {
  finalizeDynamicMultiCandidateV2,
  finalizeStrongSingleBaselineV2,
  finalizeTopologyMeasurementEvidenceReceiptV2,
  finalizeTopologyMeasurementReceiptV2,
  finalizeTopologyGateV2,
} from "../../src/harness-v2/topology-gate.js";
import { createHarnessFixture, type HarnessFixture } from "../helpers/harness.js";
import { taskFlowMemoryMigrations } from "../helpers/task-flow.js";
import { preparedExecutionIntegrationJournalFixture } from "../helpers/execution-v2.js";
import {
  sealTaskFlowRecord,
  type OperationAttemptRecord,
  type OperationTransitionRecord,
  type TaskDecisionEntryRecord,
  type WorkspaceBaselineRecord,
} from "../../src/task-flow/domain.js";

const fixtures: HarnessFixture[] = [];
const reopenedStores: AuthorityStore[] = [];
const sha = (value: string): string => sha256Hex(value);
const runtime = {
  provider: "test-provider",
  api: "test-api",
  model: "test-model",
  thinking_level: "high",
  context_window: 128_000,
} as const;

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
  for (const store of reopenedStores.splice(0)) store.close();
  for (const fixture of fixtures.splice(0)) fixture.authority.close();
});

function node(
  id: string,
  obligationIds: readonly string[],
  oracleSha256: string,
  requirementIds: readonly string[],
  decisionRefs: readonly { readonly decision_id: string; readonly sha256: string }[],
  patchNode = false,
): Omit<ExecutionNodeSpecV2, "record_sha256"> {
  const task = `Return typed evidence for ${id}`;
  const outputSchemaSha256 = sha(`coordinator-output:${id}`);
  const providerProfileSha256 = sha("coordinator-provider-profile");
  return {
    schema_version: 2,
    node_id: id,
    logical_key: id.toLowerCase(),
    task,
    capabilities: patchNode ? ["PATCH_PROPOSE"] : ["SOURCE_DISCOVERY"],
    effect_ceiling: patchNode ? "PATCH_PROPOSAL" : "READ_ONLY",
    requirement_ids: requirementIds,
    obligation_ids: obligationIds,
    read_roots: ["src"],
    write_roots: patchNode ? [`src/${id.toLowerCase()}`] : [],
    exact_input_refs: [],
    decision_refs: decisionRefs,
    provider_call_plan_id: null,
    provider_call_plan_sha256: null,
    input_closure_sha256: executionNodeInputClosureV2({
      task,
      requirement_ids: requirementIds,
      obligation_ids: obligationIds,
      exact_input_refs: [],
      decision_refs: decisionRefs,
      output_schema_sha256: outputSchemaSha256,
      oracle_sha256: oracleSha256,
      provider_profile_sha256: providerProfileSha256,
    }),
    output_schema_sha256: outputSchemaSha256,
    oracle_sha256: oracleSha256,
    provider_profile_sha256: providerProfileSha256,
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

function prepareGraph(input: {
  readonly suffix: string;
  readonly nodeIds: readonly string[];
  readonly authorizationTtlMs?: number;
  readonly patchNodeIds?: readonly string[];
  readonly edges?: readonly {
    readonly from: string;
    readonly to: string;
    readonly condition: ExecutionEdgeConditionV2;
  }[];
}) {
  const fixture = createHarnessFixture("MULTI", input.suffix, {
    readRoots: ["src"], writeRoots: ["src"],
    ...(input.authorizationTtlMs === undefined ? {} : { authorizationTtlMs: input.authorizationTtlMs }),
  });
  fixtures.push(fixture);
  const store = fixture.authority.store;
  const preparation = store.readExecutionV2Preparation(fixture.goalId, fixture.run.run_id);
  const runtimeFingerprintSha256 = sha(`coordinator-runtime:${input.suffix}`);
  const dependentNodeIds = new Set((input.edges ?? []).map((edge) => edge.to));
  const topologyClosure = {
    goal_id: fixture.goalId,
    plan_revision_id: preparation.planRevisionId,
    plan_revision_sha256: preparation.planRevisionSha256,
    input_closure_sha256: preparation.inputClosureSha256,
    runtime_fingerprint_sha256: runtimeFingerprintSha256,
  } as const;
  const graphProposalSha256 = sha(`coordinator-candidate:${input.suffix}`);
  const observedAtMs = fixture.authority.clock.now();
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
    source_observation_sha256: sha(`coordinator-baseline-observation:${input.suffix}`),
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
    graph_proposal_sha256: graphProposalSha256,
    derivation: "HOST_DETERMINISTIC_DAG_SIMULATION",
    source_observation_sha256: sha(`coordinator-simulator-observation:${input.suffix}`),
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
    graph_proposal_sha256: graphProposalSha256,
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
  const measurements = store.transactExecutionV2({
    type: "RECORD_TOPOLOGY_MEASUREMENTS_V2",
    goalId: fixture.goalId,
    evidenceReceipts: [strongSingleEvidence, multiEvidence],
    receipts: [strongSingle, multiSimulation],
  }, {
    expectedVersion: fixture.version,
    idempotencyKey: `coordinator:${input.suffix}:measurements`,
    actor: "RUNTIME",
    lease: fixture.lease,
  });
  const baseline = finalizeStrongSingleBaselineV2({
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
  });
  const candidate = finalizeDynamicMultiCandidateV2({
    ...topologyClosure,
    graph_sha256: graphProposalSha256,
    total_node_count: input.nodeIds.length,
    independent_node_count: input.nodeIds.filter((nodeId) => !dependentNodeIds.has(nodeId)).length,
    cross_partition_dependency_count: input.edges?.length ?? 0,
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
  });
  const measuredPreparation = store.readExecutionV2Preparation(fixture.goalId, fixture.run.run_id);
  const gate = finalizeTopologyGateV2({
    ...topologyClosure,
    run_id: fixture.run.run_id,
    requested_topology: "MULTI",
    config_sha256: preparation.configSha256,
    strong_single_baseline: baseline,
    multi_candidate: candidate,
    predecessor_authority_head_sha256: measuredPreparation.predecessorAuthorityHeadSha256,
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
    expectedVersion: measurements.goalVersion,
    idempotencyKey: `coordinator:${input.suffix}:admission`,
    actor: "RUNTIME",
    lease: fixture.lease,
  });
  const current = store.readExecutionV2Preparation(fixture.goalId, fixture.run.run_id);
  const oracleSha256 = canonicalJsonSha256(fixture.route.work_cells[0]!.oracle);
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
    runtime_fingerprint_sha256: runtimeFingerprintSha256,
    predecessor_authority_head_sha256: current.predecessorAuthorityHeadSha256,
    graph_revision: 1,
    stop_generation: 0,
    nodes: input.nodeIds.map((id) => node(
      id,
      fixture.route.work_cells[0]!.obligation_ids,
      oracleSha256,
      current.workCellRequirementIds,
      current.workCellDecisionRefs,
      input.patchNodeIds?.includes(id) ?? false,
    )),
    edges: (input.edges ?? []).map((edge) => ({
      from_node_id: edge.from,
      to_node_id: edge.to,
      condition: edge.condition,
    })),
    created_at_ms: fixture.authority.clock.now(),
  });
  const committed = store.transactExecutionV2({
    type: "COMMIT_EXECUTION_GRAPH_V2",
    goalId: fixture.goalId,
    graph,
  }, {
    expectedVersion: admission.goalVersion,
    idempotencyKey: `coordinator:${input.suffix}:graph`,
    actor: "RUNTIME",
    lease: fixture.lease,
  });
  return { fixture, graph, version: committed.goalVersion };
}

function proposedResult(fixture: HarnessFixture, packet: TaskPacketV2): WorkerAttemptResultV2 {
  const proposal = finalizeWorkerProposalV2({
    packet,
    kind: "EVIDENCE_PROPOSAL",
    payload: {
      artifact_refs: [{
        sha256: sha(`coordinator-artifact:${packet.packet_id}`),
        classification: "INTERNAL",
      }],
    },
    created_at_ms: fixture.authority.clock.now(),
  });
  return {
    status: "PROPOSED",
    proposal,
    patch_set: null,
    stopped: null,
    protocol: {
      schema_version: 2,
      reason_code: null,
      submission_count: 1,
      assistant_text_is_display_only: true,
    },
    display_text: "",
    patches: [],
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cost: 0,
      turns: 1,
      tool_calls: 1,
      wall_time_ms: 1,
    },
    runtime_resolution: {
      runtime,
      source: "SUPERVISOR_INHERITED",
      fallback_reason: null,
    },
  };
}

function proposedPatchResult(fixture: HarnessFixture, packet: TaskPacketV2): WorkerAttemptResultV2 {
  const path = `src/${packet.node_id.toLowerCase()}/change.ts`;
  const content = Buffer.from(`export const changedBy = "${packet.node_id}";\n`);
  const patchSet = finalizeWorkerPatchSetV2({
    packet,
    patches: [{ operation: "CREATE", path, beforeSha256: null, content }],
    created_at_ms: fixture.authority.clock.now(),
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
    created_at_ms: fixture.authority.clock.now(),
  });
  return {
    ...proposedResult(fixture, packet),
    proposal,
    patch_set: patchSet,
    patches: [{ operation: "CREATE", path, beforeSha256: null, content }],
  };
}

let oracleSequence = 0;

function recordValidationEvidence(
  fixture: HarnessFixture,
  postimageRootSha256: string,
  nodeId: string,
  store: AuthorityStore = fixture.authority.store,
) {
  const now = fixture.authority.clock.now();
  const cell = fixture.route.work_cells[0]!;
  const suffix = `${nodeId}-${oracleSequence += 1}`;
  const attempt = sealTaskFlowRecord<OperationAttemptRecord, "record_sha256">("PCH-OPERATION-ATTEMPT-V1", {
    schema_version: 1,
    attempt_id: `ATTEMPT-COORDINATOR-${suffix}`,
    operation_id: `OPERATION-COORDINATOR-${suffix}`,
    goal_id: fixture.goalId,
    work_cell_id: cell.work_cell_id,
    authorization_id: fixture.authorization.authorization_id,
    attempt_number: 1,
    operation_kind: "VALIDATION",
    normalized_target_hmac: sha(`coordinator-oracle-target:${suffix}`),
    normalized_payload_sha256: sha(`coordinator-oracle-payload:${suffix}`),
    execution_fingerprint_sha256: sha(`coordinator-oracle-execution:${suffix}`),
    baseline_sha256: fixture.baseline.record_sha256,
    environment_sha256: fixture.baseline.environment_sha256,
    oracle_sha256: canonicalJsonSha256(cell.oracle),
    idempotency_key_hmac: sha(`coordinator-oracle-idempotency:${suffix}`),
    created_at_ms: now,
  }, "record_sha256");
  const prepared = sealTaskFlowRecord<OperationTransitionRecord, "transition_sha256">(
    "PCH-OPERATION-TRANSITION-V1",
    {
      schema_version: 1,
      transition_id: `TRANSITION-COORDINATOR-${suffix}-0`,
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
    oracleExecution: { command: "npm test", policySha256: sha(`coordinator-oracle-policy:${suffix}`) },
  }, {
    expectedVersion: store.readSnapshot(fixture.goalId).goalVersion,
    idempotencyKey: `coordinator:${suffix}:oracle:prepare`, actor: "RUNTIME", lease: fixture.lease,
  });
  let predecessor = prepared.transition_sha256;
  let terminalTransitionId = "";
  for (const [ordinal, state] of [[1, "DISPATCHED"], [2, "OBSERVED"], [3, "COMMITTED"]] as const) {
    const transition = sealTaskFlowRecord<OperationTransitionRecord, "transition_sha256">(
      "PCH-OPERATION-TRANSITION-V1",
      {
        schema_version: 1,
        transition_id: `TRANSITION-COORDINATOR-${suffix}-${ordinal}`,
        attempt_id: attempt.attempt_id,
        ordinal,
        state,
        output_sha256: state === "COMMITTED" ? sha(`coordinator-oracle-output:${suffix}`) : null,
        readback_sha256: state === "OBSERVED" || state === "COMMITTED"
          ? sha(`coordinator-oracle-readback:${suffix}`) : null,
        failure_signature_sha256: null,
        postcondition: state === "COMMITTED" ? "PASS" : "UNKNOWN",
        predecessor_sha256: predecessor,
        created_at_ms: now,
      },
      "transition_sha256",
    );
    result = store.transactTaskFlow({ type: "TRANSITION_OPERATION", goalId: fixture.goalId, transition }, {
      expectedVersion: result.goalVersion,
      idempotencyKey: `coordinator:${suffix}:oracle:transition:${ordinal}`,
      actor: "RUNTIME",
      lease: fixture.lease,
    });
    predecessor = transition.transition_sha256;
    if (state === "COMMITTED") terminalTransitionId = transition.transition_id;
  }
  const postimage = sealTaskFlowRecord<WorkspaceBaselineRecord, "record_sha256">("PCH-WORKSPACE-BASELINE-V1", {
    schema_version: 1,
    baseline_id: `BASELINE-COORDINATOR-${suffix}`,
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
    idempotencyKey: `coordinator:${suffix}:oracle:postimage`, actor: "RUNTIME", lease: fixture.lease,
  });
  store.transactTaskFlow({
    type: "DERIVE_ACCEPTANCE_EVIDENCE_V2", goalId: fixture.goalId,
    attemptId: attempt.attempt_id, terminalTransitionId,
  }, {
    expectedVersion: result.goalVersion,
    idempotencyKey: `coordinator:${suffix}:oracle:evidence`, actor: "RUNTIME", lease: fixture.lease,
  });
  const read = new DatabaseSync(fixture.authority.databasePath, { readOnly: true });
  try {
    return read.prepare(`SELECT o.task_obligation_id obligation_id,
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
  } finally {
    read.close();
  }
}

function coordinatorFor(
  fixture: HarnessFixture,
  overrides: Partial<ConstructorParameters<typeof DynamicMultiCoordinator>[0]> = {},
): DynamicMultiCoordinator {
  const authority = overrides.authority ?? fixture.authority.store;
  const mutation = overrides.mutation ?? {
    transact(command: Parameters<AuthorityStore["transactExecutionV2"]>[0], idempotencyKey: string) {
      return authority.transactExecutionV2(command, {
        expectedVersion: authority.readSnapshot(command.goalId).goalVersion,
        idempotencyKey,
        actor: "RUNTIME",
        lease: fixture.lease,
      });
    },
  };
  return new DynamicMultiCoordinator({
    authority,
    mutation,
    runId: fixture.run.run_id,
    workspace: fixture.authority.directory,
    capabilityKey: "coordinator-capability-key",
    supervisorRuntime: runtime,
    now: () => fixture.authority.clock.now(),
    worker: { execute: async ({ packet }) => proposedResult(fixture, packet) },
    evidence: {
      accept: async ({ proposal }) => ({ evidence_sha256: sha(`coordinator-evidence:${proposal.proposal_id}`) }),
    },
    oracle: {
      validate: async ({ packet, postimage_root_sha256 }) => ({
        validation_evidence: recordValidationEvidence(fixture, postimage_root_sha256, packet.node_id, authority),
      }),
    },
    ...overrides,
  });
}

async function settleWithin<T>(promise: Promise<T>, milliseconds = 250): Promise<
  | { readonly kind: "RESOLVED"; readonly value: T }
  | { readonly kind: "REJECTED"; readonly error: unknown }
  | { readonly kind: "TIMEOUT" }
> {
  return Promise.race([
    promise.then(
      (value) => ({ kind: "RESOLVED" as const, value }),
      (error: unknown) => ({ kind: "REJECTED" as const, error }),
    ),
    new Promise<{ readonly kind: "TIMEOUT" }>((resolveTimeout) => {
      setTimeout(() => resolveTimeout({ kind: "TIMEOUT" }), milliseconds);
    }),
  ]);
}

describe("DynamicMultiCoordinator fault and recovery contract", () => {
  it("settles start when the first dispatch fails before a Worker is launched", async () => {
    const { fixture } = prepareGraph({ suffix: "COORD-START-FAULT", nodeIds: ["NODE-A", "NODE-B"] });
    const coordinator = coordinatorFor(fixture, {
      packetClosure: () => { throw new Error("packet-closure-fault"); },
    });

    const outcome = await settleWithin(coordinator.start(1));

    expect(outcome.kind).not.toBe("TIMEOUT");
    expect(coordinator.poll()).toMatchObject({
      state: "FAILED",
      active_worker_count: 0,
      error: "packet-closure-fault",
    });
  });

  it.each([1, 2, 4, 8] as const)("admits no more than %i active Worker slots", async (slots) => {
    const nodeIds = Array.from({ length: 8 }, (_, index) => `NODE-${String(index + 1).padStart(2, "0")}`);
    const { fixture } = prepareGraph({ suffix: `COORD-SLOTS-${slots}`, nodeIds });
    const started: string[] = [];
    let observedActive = 0;
    let observedPeak = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    const coordinator = coordinatorFor(fixture, {
      worker: {
        async execute({ packet }) {
          started.push(packet.node_id);
          observedActive += 1;
          observedPeak = Math.max(observedPeak, observedActive);
          await gate;
          observedActive -= 1;
          return proposedResult(fixture, packet);
        },
      },
    });

    const startedView = await coordinator.start(slots);
    expect(started).toHaveLength(slots);
    expect(startedView).toMatchObject({ active_worker_count: slots, peak_worker_count: slots });
    release();
    const finalView = await coordinator.wait();

    expect(finalView.error).toBeNull();
    expect(finalView).toMatchObject({
      state: "SUCCEEDED",
      graph_status: "CLOSED",
      completed_node_ids: nodeIds,
      peak_worker_count: slots,
      error: null,
    });
    expect(observedPeak).toBeLessThanOrEqual(slots);
    expect(fixture.authority.store.verifyExecutionV2Integrity()).toMatchObject({
      packets: 8,
      leases: 8,
      proposals: 8,
      hostOracleReceipts: 8,
      hostReceipts: 16,
      graphTerminalReceipts: 1,
      mismatches: 0,
    });
  });

  it("keeps a locally active Worker leased until its TaskPacket deadline", async () => {
    const { fixture } = prepareGraph({
      suffix: "COORD-LIVE-WORKER", nodeIds: ["NODE-A", "NODE-B"], authorizationTtlMs: 3_600_000,
    });
    const attempts: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    const coordinator = coordinatorFor(fixture, {
      schedulerTickMs: 1,
      worker: {
        async execute({ packet }) {
          attempts.push(`${packet.node_id}:${packet.attempt}`);
          await gate;
          return proposedResult(fixture, packet);
        },
      },
    });

    await coordinator.start(2);
    fixture.authority.clock.advance(61_000);
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));

    expect(attempts.toSorted()).toEqual(["NODE-A:1", "NODE-B:1"]);
    expect(coordinator.poll()).toMatchObject({
      state: "RUNNING",
      active_node_ids: ["NODE-A", "NODE-B"],
      active_worker_count: 2,
    });
    release();
    const terminal = await coordinator.wait();
    expect(terminal.error).toBeNull();
    expect(terminal).toMatchObject({
      state: "SUCCEEDED",
      graph_status: "CLOSED",
      completed_node_ids: ["NODE-A", "NODE-B"],
    });
    expect(attempts.toSorted()).toEqual(["NODE-A:1", "NODE-B:1"]);
  });

  it("commits a graph stop before abort and fences a late Worker proposal", async () => {
    const { fixture } = prepareGraph({ suffix: "COORD-LATE-ABORT", nodeIds: ["NODE-A", "NODE-B"] });
    let authorityAtAbort: string | null = null;
    const coordinator = coordinatorFor(fixture, {
      worker: {
        execute(input) {
          if (input.packet.node_id === "NODE-B") {
            return Promise.resolve(proposedResult(fixture, input.packet));
          }
          return new Promise((resolveResult) => {
            input.signal?.addEventListener("abort", () => {
              authorityAtAbort = fixture.authority.store.readExecutionV2(fixture.run.run_id, 1)?.status ?? null;
              resolveResult(proposedResult(fixture, input.packet));
            }, { once: true });
          });
        },
      },
    });
    await coordinator.start(1);

    const stopped = await coordinator.stop();
    const settled = await coordinator.wait();

    expect(authorityAtAbort).toBe("STOPPED");
    expect(stopped).toMatchObject({ state: "STOPPED", graph_status: "STOPPED", active_worker_count: 0 });
    expect(settled).toMatchObject({ state: "STOPPED", graph_status: "STOPPED" });
    expect(fixture.authority.store.verifyExecutionV2Integrity()).toMatchObject({
      stops: 1,
      proposals: 0,
      hostReceipts: 0,
      mismatches: 0,
    });
  });

  it("unlocks an ORACLE_PASSED edge only after the Host validation chain", async () => {
    const { fixture } = prepareGraph({
      suffix: "COORD-NO-PROGRESS",
      nodeIds: ["NODE-A", "NODE-B", "NODE-C"],
      edges: [{ from: "NODE-A", to: "NODE-C", condition: "ORACLE_PASSED" }],
    });
    const coordinator = coordinatorFor(fixture);

    await coordinator.start(1);
    const finalView = await coordinator.wait();

    expect(finalView.error).toBeNull();
    expect(finalView).toMatchObject({
      state: "SUCCEEDED",
      graph_status: "CLOSED",
      completed_node_ids: ["NODE-A", "NODE-B", "NODE-C"],
      active_worker_count: 0,
    });
    expect(fixture.authority.store.verifyExecutionV2Integrity()).toMatchObject({
      stops: 0,
      hostOracleReceipts: 3,
      hostReceipts: 6,
      graphTerminalReceipts: 1,
      mismatches: 0,
    });
  });

  it("revalidates an earlier node after a later PatchSet changes the canonical postimage", async () => {
    const { fixture, graph } = prepareGraph({
      suffix: "COORD-FRESH-POSTIMAGE",
      nodeIds: ["NODE-A", "NODE-B"],
      patchNodeIds: ["NODE-A", "NODE-B"],
    });
    const workerCalls: string[] = [];
    const integrationRoots: string[] = [];
    const oracleRoots: Array<{ readonly nodeId: string; readonly root: string }> = [];
    let expectedPreimage = graph.baseline_content_root_sha256;
    const coordinator = coordinatorFor(fixture, {
      artifactStore: new ArtifactStore(fixture.authority.casPath),
      worker: {
        async execute({ packet }) {
          workerCalls.push(packet.node_id);
          return proposedPatchResult(fixture, packet);
        },
      },
      integration: {
        async prepare({ patch_set }) {
          return preparedExecutionIntegrationJournalFixture(fixture, patch_set);
        },
        async integrate({ expected_preimage_root_sha256, proposal, artifacts }) {
          expect(expected_preimage_root_sha256).toBe(expectedPreimage);
          expect(artifacts).toHaveLength(1);
          const root = sha(`coordinator-integrated:${integrationRoots.length}:${proposal.node_id}`);
          integrationRoots.push(root);
          expectedPreimage = root;
          return { status: "APPLIED", postimage_root_sha256: root };
        },
        async observe() {
          throw new TypeError("Normal integration must not enter reconciliation");
        },
      },
      oracle: {
        async validate({ packet, postimage_root_sha256 }) {
          oracleRoots.push({ nodeId: packet.node_id, root: postimage_root_sha256 });
          return {
            validation_evidence: recordValidationEvidence(
              fixture,
              postimage_root_sha256,
              packet.node_id,
            ),
          };
        },
      },
    });

    await coordinator.start(2);
    const result = await coordinator.wait();
    const finalRoot = integrationRoots.at(-1)!;

    expect(result).toMatchObject({
      state: "SUCCEEDED",
      graph_status: "CLOSED",
      completed_node_ids: ["NODE-A", "NODE-B"],
      oracle_pending_node_ids: [],
    });
    expect(workerCalls.toSorted()).toEqual(["NODE-A", "NODE-B"]);
    expect(integrationRoots).toHaveLength(2);
    expect(oracleRoots).toHaveLength(3);
    expect(oracleRoots.filter((entry) => entry.root === finalRoot)).toHaveLength(2);
    expect(fixture.authority.store.verifyExecutionV2Integrity()).toMatchObject({
      hostOracleReceipts: 3,
      hostReceipts: 5,
      integrationAttempts: 2,
      graphTerminalReceipts: 1,
      mismatches: 0,
    });
  });

  it.each(["AFTER_PREPARE", "AFTER_DISPATCH", "AFTER_OBSERVE", "AFTER_COMMIT"] as const)(
    "reconciles an integration crash at %s from durable workspace observation",
    async (faultPoint) => {
      const { fixture, graph } = prepareGraph({
        suffix: `COORD-INTEGRATION-${faultPoint}`,
        nodeIds: ["NODE-A", "NODE-B", "NODE-C"],
        patchNodeIds: ["NODE-A"],
        edges: [{ from: "NODE-A", to: "NODE-C", condition: "PATCH_INTEGRATED" }],
      });
      const postimage = sha(`coordinator-recovered-postimage:${faultPoint}`);
      let effectApplied = false;
      let faultArmed = true;
      let replacementStarted = false;
      let observedBeforeReplacement = false;
      const attempts: number[] = [];
      const worker = {
        execute({ packet }: { readonly packet: TaskPacketV2 }) {
          if (packet.node_id === "NODE-A") {
            attempts.push(packet.attempt);
            return Promise.resolve(proposedPatchResult(fixture, packet));
          }
          return Promise.resolve(proposedResult(fixture, packet));
        },
      };
      const integration = {
        async prepare({ patch_set }: { readonly patch_set: Parameters<typeof preparedExecutionIntegrationJournalFixture>[1] }) {
          return preparedExecutionIntegrationJournalFixture(fixture, patch_set);
        },
        async integrate() {
          effectApplied = true;
          return { status: "APPLIED" as const, postimage_root_sha256: postimage };
        },
        async observe({ expected_preimage_root_sha256 }: { readonly expected_preimage_root_sha256: string }) {
          if (!replacementStarted) observedBeforeReplacement = true;
          return effectApplied
            ? { status: "APPLIED" as const, postimage_root_sha256: postimage }
            : {
              status: "NOT_APPLIED" as const,
              current_postimage_root_sha256: expected_preimage_root_sha256,
              failure_sha256: sha(`coordinator-not-applied:${faultPoint}`),
            };
        },
      };
      const first = coordinatorFor(fixture, {
        artifactStore: new ArtifactStore(fixture.authority.casPath),
        worker,
        integration,
        onIntegrationFault(point) {
          if (faultArmed && point === faultPoint) throw new Error(`CRASH:${point}`);
        },
      });
      await first.start(1);
      await expect(first.wait()).resolves.toMatchObject({ state: "FAILED", graph_status: "RUNNING" });
      expect(observedBeforeReplacement).toBe(false);

      faultArmed = false;
      replacementStarted = true;
      const replacement = coordinatorFor(fixture, {
        artifactStore: new ArtifactStore(fixture.authority.casPath),
        worker,
        integration,
      });
      await replacement.start(1);
      const replacementResult = await replacement.wait();
      expect({
        error: replacementResult.error,
        state: replacementResult.state,
        graphStatus: replacementResult.graph_status,
        projection: fixture.authority.store.readExecutionV2(fixture.run.run_id, 1),
      }).toMatchObject({ error: null, state: "SUCCEEDED", graphStatus: "CLOSED" });
      expect(attempts).toEqual(faultPoint === "AFTER_PREPARE" ? [1, 2] : [1]);
      expect(fixture.authority.store.readExecutionV2(fixture.run.run_id, 1)).toMatchObject({
        currentPostimageRootSha256: postimage,
        integrationState: "COMMITTED",
        completedNodeIds: ["NODE-A", "NODE-B", "NODE-C"],
      });
      expect(fixture.authority.store.verifyExecutionV2Integrity()).toMatchObject({
        integrationAttempts: faultPoint === "AFTER_PREPARE" ? 2 : 1,
        integrationTransitions: faultPoint === "AFTER_PREPARE" ? 5 : 3,
        graphTerminalReceipts: 1,
        mismatches: 0,
      });
      expect(graph.baseline_content_root_sha256).not.toBe(postimage);
    },
  );

  it("fences an unknown integration whose workspace observation conflicts instead of replaying it", async () => {
    const { fixture } = prepareGraph({
      suffix: "COORD-INTEGRATION-CONFLICT",
      nodeIds: ["NODE-A", "NODE-B", "NODE-C"],
      patchNodeIds: ["NODE-A"],
      edges: [{ from: "NODE-A", to: "NODE-C", condition: "PATCH_INTEGRATED" }],
    });
    let integrateCalls = 0;
    let observeCalls = 0;
    const coordinator = coordinatorFor(fixture, {
      artifactStore: new ArtifactStore(fixture.authority.casPath),
      worker: {
        execute({ packet }) {
          return Promise.resolve(packet.node_id === "NODE-A"
            ? proposedPatchResult(fixture, packet)
            : proposedResult(fixture, packet));
        },
      },
      integration: {
        async prepare({ patch_set }) {
          return preparedExecutionIntegrationJournalFixture(fixture, patch_set);
        },
        async integrate() {
          integrateCalls += 1;
          return { status: "OUTCOME_UNKNOWN", failure_sha256: sha("integration-unknown") };
        },
        async observe() {
          observeCalls += 1;
          return {
            status: "CONFLICT",
            current_postimage_root_sha256: sha("unexpected-workspace-postimage"),
            failure_sha256: sha("integration-observation-conflict"),
          };
        },
      },
    });
    await coordinator.start(1);
    const settled = await settleWithin(coordinator.wait(), 1_000);
    expect({
      settled,
      poll: coordinator.poll(),
      authority: fixture.authority.store.readExecutionV2(fixture.run.run_id, 1),
    }).toMatchObject({
      settled: { kind: "RESOLVED", value: { state: "FAILED", graph_status: "FAILED" } },
      poll: { state: "FAILED", graph_status: "FAILED", completed_node_ids: [] },
      authority: { status: "FAILED", integrationState: "FENCED" },
    });
    expect({ integrateCalls, observeCalls }).toEqual({ integrateCalls: 1, observeCalls: 1 });
    expect(fixture.authority.store.verifyExecutionV2Integrity()).toMatchObject({
      integrationAttempts: 1,
      integrationTransitions: 2,
      stops: 1,
      graphTerminalReceipts: 1,
      hostReceipts: 0,
      mismatches: 0,
    });
  });

  it("fences an integration when the workspace observer throws instead of replaying the effect", async () => {
    const { fixture } = prepareGraph({
      suffix: "COORD-INTEGRATION-OBSERVE-THROW",
      nodeIds: ["NODE-A", "NODE-B", "NODE-C"],
      patchNodeIds: ["NODE-A"],
      edges: [{ from: "NODE-A", to: "NODE-C", condition: "PATCH_INTEGRATED" }],
    });
    let integrateCalls = 0;
    let observeCalls = 0;
    const coordinator = coordinatorFor(fixture, {
      artifactStore: new ArtifactStore(fixture.authority.casPath),
      worker: { execute: async ({ packet }) => proposedPatchResult(fixture, packet) },
      integration: {
        async prepare({ patch_set }) {
          return preparedExecutionIntegrationJournalFixture(fixture, patch_set);
        },
        async integrate() {
          integrateCalls += 1;
          return { status: "OUTCOME_UNKNOWN", failure_sha256: sha("observer-throw-unknown") };
        },
        async observe() {
          observeCalls += 1;
          throw new Error("workspace-observer-unavailable");
        },
      },
    });

    await coordinator.start(1);
    await expect(coordinator.wait()).resolves.toMatchObject({ state: "FAILED", graph_status: "FAILED" });
    expect(fixture.authority.store.readExecutionV2(fixture.run.run_id, 1)).toMatchObject({
      integrationState: "FENCED",
      completedNodeIds: [],
    });
    expect({ integrateCalls, observeCalls }).toEqual({ integrateCalls: 1, observeCalls: 1 });
    expect(fixture.authority.store.verifyExecutionV2Integrity()).toMatchObject({
      integrationAttempts: 1,
      integrationTransitions: 2,
      stops: 1,
      graphTerminalReceipts: 1,
      mismatches: 0,
    });
  });

  it("fences an expired unresolved integration without calling the workspace observer", async () => {
    const { fixture } = prepareGraph({
      suffix: "COORD-INTEGRATION-EXPIRED",
      nodeIds: ["NODE-A", "NODE-B", "NODE-C"],
      patchNodeIds: ["NODE-A"],
      edges: [{ from: "NODE-A", to: "NODE-C", condition: "PATCH_INTEGRATED" }],
    });
    let faultArmed = true;
    let observeCalls = 0;
    const integration = {
      async prepare({ patch_set }: { readonly patch_set: Parameters<typeof preparedExecutionIntegrationJournalFixture>[1] }) {
        return preparedExecutionIntegrationJournalFixture(fixture, patch_set);
      },
      async integrate() {
        return { status: "OUTCOME_UNKNOWN" as const, failure_sha256: sha("expired-unknown") };
      },
      async observe() {
        observeCalls += 1;
        return { status: "CONFLICT" as const, current_postimage_root_sha256: sha("expired-conflict"), failure_sha256: sha("expired-observation") };
      },
    };
    const first = coordinatorFor(fixture, {
      artifactStore: new ArtifactStore(fixture.authority.casPath),
      worker: { execute: async ({ packet }) => proposedPatchResult(fixture, packet) },
      integration,
      onIntegrationFault(point) {
        if (faultArmed && point === "AFTER_DISPATCH") throw new Error("simulated-process-crash");
      },
    });

    await first.start(1);
    await expect(first.wait()).resolves.toMatchObject({ state: "FAILED", graph_status: "RUNNING" });
    faultArmed = false;
    fixture.authority.clock.advance(60_001);
    const replacement = coordinatorFor(fixture, {
      artifactStore: new ArtifactStore(fixture.authority.casPath),
      worker: { execute: async ({ packet }) => proposedPatchResult(fixture, packet) },
      integration,
    });

    await replacement.start(1);
    await expect(replacement.wait()).resolves.toMatchObject({ state: "FAILED", graph_status: "FAILED" });
    expect(observeCalls).toBe(0);
    expect(fixture.authority.store.readExecutionV2(fixture.run.run_id, 1)).toMatchObject({
      integrationState: "FENCED",
      completedNodeIds: [],
    });
    expect(fixture.authority.store.verifyExecutionV2Integrity()).toMatchObject({
      integrationAttempts: 1,
      integrationTransitions: 2,
      stops: 1,
      graphTerminalReceipts: 1,
      mismatches: 0,
    });
  });

  it("fences unresolved integration authority after revocation without observing the workspace", async () => {
    const { fixture } = prepareGraph({
      suffix: "COORD-INTEGRATION-AUTHORIZATION-REVOKED",
      nodeIds: ["NODE-A", "NODE-B", "NODE-C"],
      patchNodeIds: ["NODE-A"],
      edges: [{ from: "NODE-A", to: "NODE-C", condition: "PATCH_INTEGRATED" }],
    });
    let faultArmed = true;
    let observeCalls = 0;
    const integration = {
      async prepare({ patch_set }: { readonly patch_set: Parameters<typeof preparedExecutionIntegrationJournalFixture>[1] }) {
        return preparedExecutionIntegrationJournalFixture(fixture, patch_set);
      },
      async integrate() {
        return { status: "OUTCOME_UNKNOWN" as const, failure_sha256: sha("revoked-unknown") };
      },
      async observe() {
        observeCalls += 1;
        return { status: "APPLIED" as const, postimage_root_sha256: sha("revoked-postimage") };
      },
    };
    const first = coordinatorFor(fixture, {
      artifactStore: new ArtifactStore(fixture.authority.casPath),
      worker: { execute: async ({ packet }) => proposedPatchResult(fixture, packet) },
      integration,
      onIntegrationFault(point) {
        if (faultArmed && point === "AFTER_DISPATCH") throw new Error("simulated-process-crash");
      },
    });

    await first.start(1);
    await expect(first.wait()).resolves.toMatchObject({ state: "FAILED", graph_status: "RUNNING" });
    faultArmed = false;
    const view = fixture.authority.store.readTaskFlowView(fixture.goalId)!;
    const selection = {
      action: "PAUSE" as const,
      reason_sha256: sha("coordinator-revoke"),
      prior_status: view.status,
      prior_next_action: view.nextActionCode,
    };
    const bindingSha256 = canonicalJsonSha256({
      goal: fixture.goalId,
      selection,
      version: fixture.authority.store.readTaskFlowGoalVersion(fixture.goalId),
    });
    const decision = sealTaskFlowRecord<TaskDecisionEntryRecord, "record_sha256">("PCH-TASK-DECISION-V1", {
      schema_version: 1,
      decision_entry_id: idFromSha256("DECISION", sha(`coordinator-revoke:${bindingSha256}`)),
      goal_id: fixture.goalId,
      contract_id: view.contract?.contract_id ?? null,
      route_id: view.route?.route_id ?? null,
      decision_key: "USER_CONTROL",
      authority_actor: "USER",
      materiality: "HIGH",
      reversible: true,
      privacy_related: false,
      question_hmac: hmacSha256Hex("coordinator-capability-key", "USER_CONTROL:PAUSE"),
      recommendation: { recommended: "PAUSE" },
      selection,
      state: "RESOLVED",
      binding_sha256: bindingSha256,
      created_at_ms: fixture.authority.clock.now(),
      expires_at_ms: null,
    }, "record_sha256");
    fixture.authority.store.transactTaskFlow({
      type: "CONTROL_TASK_FLOW", goalId: fixture.goalId, action: "PAUSE", decision,
    }, {
      expectedVersion: fixture.authority.store.readTaskFlowGoalVersion(fixture.goalId),
      idempotencyKey: "coordinator:authorization-revoked:pause",
      actor: "RUNTIME",
      lease: fixture.lease,
    });
    const replacement = coordinatorFor(fixture, {
      artifactStore: new ArtifactStore(fixture.authority.casPath),
      worker: { execute: async ({ packet }) => proposedPatchResult(fixture, packet) },
      integration,
    });

    await replacement.start(1);
    await expect(replacement.wait()).resolves.toMatchObject({ state: "FAILED", graph_status: "FAILED" });
    expect(observeCalls).toBe(0);
    expect(fixture.authority.store.readExecutionV2(fixture.run.run_id, 1)).toMatchObject({
      integrationState: "FENCED",
      completedNodeIds: [],
    });
    expect(fixture.authority.store.verifyExecutionV2Integrity()).toMatchObject({
      integrationAttempts: 1,
      integrationTransitions: 2,
      stops: 1,
      graphTerminalReceipts: 1,
      mismatches: 0,
    });
  });

  it("does not declare no-progress while a durable Worker lease is still active after restart", async () => {
    const { fixture, graph, version } = prepareGraph({
      suffix: "COORD-LIVE-LEASE-RESTART",
      nodeIds: ["NODE-A", "NODE-B"],
    });
    const now = fixture.authority.clock.now();
    let currentVersion = version;
    for (const node of graph.nodes) {
      const preparation = fixture.authority.store.readExecutionV2Preparation(fixture.goalId, fixture.run.run_id);
      const provider = createWorkerProviderDispatchAuthorityV1({
        graph,
        node,
        attempt: 1,
        leaseGeneration: 1,
        fencingToken: 1,
        deadlineMs: now + 60_000,
        createdAtMs: now,
        predecessorAuthorityHeadSha256: preparation.predecessorAuthorityHeadSha256,
        capabilityKey: "coordinator-capability-key",
        runtime: { runtime, source: "SUPERVISOR_INHERITED", fallback_reason: null },
      });
      const packet = provider.packet;
      const lease = finalizeExecutionNodeLeaseV2({
        packet,
        owner_hmac: sha(`coordinator-live-restart-owner:${node.node_id}`),
        expires_at_ms: now + 30_000,
        created_at_ms: now,
      });
      currentVersion = fixture.authority.store.transactExecutionV2({
        type: "LEASE_EXECUTION_NODE_V2",
        goalId: fixture.goalId,
        packet,
        lease,
        providerPlan: provider.plan,
        redaction: provider.redaction,
        invocation: provider.invocation,
      }, {
        expectedVersion: currentVersion,
        idempotencyKey: `coordinator:live-restart:lease:${node.node_id}`,
        actor: "RUNTIME",
        lease: fixture.lease,
      }).goalVersion;
    }
    let launches = 0;
    const replacement = coordinatorFor(fixture, {
      worker: {
        execute(input) {
          launches += 1;
          return Promise.resolve(proposedResult(fixture, input.packet));
        },
      },
      schedulerTickMs: 1,
    });

    expect(await replacement.start(1)).toMatchObject({
      state: "RUNNING",
      graph_status: "RUNNING",
      active_node_ids: ["NODE-A", "NODE-B"],
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
    expect(replacement.poll()).toMatchObject({ state: "RUNNING", graph_status: "RUNNING" });
    expect(launches).toBe(0);
    await replacement.stop();
  });

  it("reclaims an expired lease after reopen and fences the old Worker's late result", async () => {
    const { fixture } = prepareGraph({ suffix: "COORD-RESTART", nodeIds: ["NODE-A", "NODE-B"] });
    let releaseOld!: () => void;
    const oldCoordinator = coordinatorFor(fixture, {
      nodeLeaseTtlMs: 1_000,
      worker: {
        execute({ packet }) {
          return new Promise((resolveResult) => {
            releaseOld = () => resolveResult(proposedResult(fixture, packet));
          });
        },
      },
    });
    await oldCoordinator.start(1);
    expect(fixture.authority.store.readExecutionV2(fixture.run.run_id, 1)).toMatchObject({
      activeNodeIds: ["NODE-A"],
      readyNodeIds: ["NODE-B"],
    });
    fixture.authority.clock.advance(1_001);

    const reopened = AuthorityStore.open({
      databasePath: fixture.authority.databasePath,
      migrationPath: resolve("schemas", "sql", "001_core.sql"),
      memoryMigrations: taskFlowMemoryMigrations,
      taskFlowMigrationPath: resolve("schemas", "sql", "011_task_flow_kernel_v1.sql"),
      inputContextMigrationPath: resolve("schemas", "sql", "012_input_context_v1.sql"),
      harnessMigrationPath: resolve("schemas", "sql", "013_coding_harness_v1.sql"),
      clock: fixture.authority.clock,
    });
    reopenedStores.push(reopened);
    const attempts: number[] = [];
    const replacement = coordinatorFor(fixture, {
      authority: reopened,
      worker: {
        execute({ packet }) {
          attempts.push(packet.attempt);
          return Promise.resolve(proposedResult(fixture, packet));
        },
      },
    });

    await replacement.start(1);
    const replacementResult = await replacement.wait();
    expect(replacementResult.error).toBeNull();
    expect(replacementResult).toMatchObject({ state: "SUCCEEDED", graph_status: "CLOSED" });
    expect(attempts).toEqual([2, 1]);

    releaseOld();
    await oldCoordinator.wait();

    expect(reopened.verifyExecutionV2Integrity()).toMatchObject({
      packets: 3,
      leases: 3,
      attemptOutcomes: 1,
      proposals: 2,
      hostOracleReceipts: 2,
      hostReceipts: 4,
      graphTerminalReceipts: 1,
      mismatches: 0,
    });
  });
});
