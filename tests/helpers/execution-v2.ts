import { canonicalJson, canonicalJsonSha256 } from "../../src/authority/canonical-json.js";
import { ArtifactStore } from "../../src/artifacts/artifact-store.js";
import { sha256Hex } from "../../src/foundation/crypto.js";
import {
  finalizeDynamicMultiCandidateV2,
  finalizeStrongSingleBaselineV2,
  finalizeTopologyGateV2,
  finalizeTopologyMeasurementEvidenceReceiptV2,
  finalizeTopologyMeasurementReceiptV2,
} from "../../src/harness-v2/topology-gate.js";
import { finalizeExecutionGraphV2 } from "../../src/harness/execution-v2/dag.js";
import {
  executionNodeInputClosureV2,
  type ExecutionIntegrationAttemptV2,
  type ExecutionGraphRevisionV2,
  type ExecutionNodeSpecV2,
  type WorkerPatchSetV2,
} from "../../src/harness/execution-v2/domain.js";
import {
  finalizeExecutionIntegrationJournalV2,
  type ExecutionIntegrationJournalV2,
  type PreparedExecutionIntegrationJournalV2,
} from "../../src/harness/execution-v2/integration-journal.js";
import { sealHarnessRecord, type TopologyRevisionRecord } from "../../src/harness/domain.js";
import { createHarnessFixture, type HarnessFixture } from "./harness.js";

const sha = (value: string): string => sha256Hex(value);

function artifactMetadata(record: ReturnType<ArtifactStore["put"]>) {
  const { created: _created, ...metadata } = record;
  void _created;
  return metadata;
}

export function preparedExecutionIntegrationJournalFixture(
  fixture: HarnessFixture,
  patchSet: WorkerPatchSetV2,
): PreparedExecutionIntegrationJournalV2 {
  const artifacts = new ArtifactStore(fixture.authority.casPath);
  const journalArtifact = artifactMetadata(artifacts.put(canonicalJson({
    schema_version: 2,
    fixture: true,
    patch_set_id: patchSet.patch_set_id,
    patch_set_sha256: patchSet.record_sha256,
    entries: patchSet.entries,
  }), {
    mediaType: "application/vnd.pch.patch-transaction+json",
    classification: "INTERNAL",
    retentionClass: "GOAL",
  }));
  return {
    schema_version: 2,
    journal_sha256: journalArtifact.sha256,
    journal_record_sha256: sha(`fixture-journal-record:${patchSet.record_sha256}`),
    journal_artifact: journalArtifact,
    entries: patchSet.entries.map((entry, ordinal) => ({
      ordinal,
      path: entry.path,
      operation: entry.operation,
      expected_before_sha256: entry.before_sha256,
      observed_before_sha256: null,
      expected_after_sha256: entry.after_sha256,
      byte_length: entry.byte_length,
      preimage_artifact: null,
    })),
  };
}

export function executionIntegrationJournalFixture(
  fixture: HarnessFixture,
  attempt: ExecutionIntegrationAttemptV2,
  patchSet: WorkerPatchSetV2,
): ExecutionIntegrationJournalV2 {
  return finalizeExecutionIntegrationJournalV2({
    integration_attempt_id: attempt.integration_attempt_id,
    prepared: preparedExecutionIntegrationJournalFixture(fixture, patchSet),
  });
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

function providerNode(input: {
  readonly id: string;
  readonly fixture: HarnessFixture;
  readonly preparation: ReturnType<HarnessFixture["authority"]["store"]["readExecutionV2Preparation"]>;
  readonly runtimeFingerprintSha256: string;
}): Omit<ExecutionNodeSpecV2, "record_sha256"> {
  const task = `Inspect the exact source and return typed evidence for ${input.id}`;
  const outputSchemaSha256 = sha(`provider-helper-output:${input.id}`);
  const oracleSha256 = canonicalJsonSha256(input.fixture.route.work_cells[0]!.oracle);
  return {
    schema_version: 2,
    node_id: input.id,
    logical_key: input.id.toLowerCase(),
    task,
    capabilities: ["SOURCE_DISCOVERY"],
    effect_ceiling: "READ_ONLY",
    requirement_ids: input.preparation.workCellRequirementIds,
    obligation_ids: input.fixture.route.work_cells[0]!.obligation_ids,
    read_roots: ["src"],
    write_roots: [],
    exact_input_refs: [],
    decision_refs: input.preparation.workCellDecisionRefs,
    provider_call_plan_id: null,
    provider_call_plan_sha256: null,
    input_closure_sha256: executionNodeInputClosureV2({
      task,
      requirement_ids: input.preparation.workCellRequirementIds,
      obligation_ids: input.fixture.route.work_cells[0]!.obligation_ids,
      exact_input_refs: [],
      decision_refs: input.preparation.workCellDecisionRefs,
      output_schema_sha256: outputSchemaSha256,
      oracle_sha256: oracleSha256,
      provider_profile_sha256: input.runtimeFingerprintSha256,
    }),
    output_schema_sha256: outputSchemaSha256,
    oracle_sha256: oracleSha256,
    provider_profile_sha256: input.runtimeFingerprintSha256,
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

export function prepareExecutionV2GraphFixture(suffix: string, runtimeFingerprint?: string): {
  readonly fixture: HarnessFixture;
  readonly graph: ExecutionGraphRevisionV2;
  readonly version: number;
  readonly runtimeFingerprintSha256: string;
} {
  const fixture = createHarnessFixture("MULTI", suffix, { readRoots: ["src"], writeRoots: ["src"] });
  const store = fixture.authority.store;
  const preparation = store.readExecutionV2Preparation(fixture.goalId, fixture.run.run_id);
  const runtimeFingerprintSha256 = runtimeFingerprint ?? sha(`provider-helper-runtime:${suffix}`);
  const graphProposalSha256 = sha(`provider-helper-graph:${suffix}`);
  const observedAtMs = fixture.authority.clock.now();
  const measurementClosure = {
    goal_id: fixture.goalId,
    run_id: fixture.run.run_id,
    work_cell_id: preparation.workCellId,
    plan_revision_id: preparation.planRevisionId,
    plan_revision_sha256: preparation.planRevisionSha256,
    input_closure_sha256: preparation.inputClosureSha256,
    runtime_fingerprint_sha256: runtimeFingerprintSha256,
    config_sha256: preparation.configSha256,
    baseline_sha256: preparation.baselineSha256,
    baseline_content_root_sha256: preparation.baselineContentRootSha256,
    environment_sha256: preparation.environmentSha256,
  } as const;
  const metrics = {
    correctness: "PASS" as const,
    quality_basis_points: 10_000,
    provider_requests: 1,
    input_tokens: 1_000,
    output_tokens: 200,
    user_interventions: 0,
    safety_events: 0,
  };
  const strongEvidence = finalizeTopologyMeasurementEvidenceReceiptV2({
    ...measurementClosure,
    kind: "STRONG_SINGLE",
    graph_proposal_sha256: null,
    derivation: "HOST_STRONG_SINGLE_ROLLOUT",
    source_observation_sha256: sha(`provider-helper-single-observation:${suffix}`),
    ...metrics,
    wall_time_ms: 10_000,
    predecessor_authority_head_sha256: preparation.predecessorAuthorityHeadSha256,
    observed_at_ms: observedAtMs,
  });
  const multiEvidence = finalizeTopologyMeasurementEvidenceReceiptV2({
    ...measurementClosure,
    kind: "DYNAMIC_MULTI_SIMULATION",
    graph_proposal_sha256: graphProposalSha256,
    derivation: "HOST_DETERMINISTIC_DAG_SIMULATION",
    source_observation_sha256: sha(`provider-helper-multi-observation:${suffix}`),
    ...metrics,
    wall_time_ms: 7_000,
    predecessor_authority_head_sha256: preparation.predecessorAuthorityHeadSha256,
    observed_at_ms: observedAtMs,
  });
  const strongMeasurement = finalizeTopologyMeasurementReceiptV2({
    ...measurementClosure,
    kind: "STRONG_SINGLE",
    graph_proposal_sha256: null,
    ...metrics,
    wall_time_ms: strongEvidence.wall_time_ms,
    source_evidence_sha256: strongEvidence.record_sha256,
    predecessor_authority_head_sha256: preparation.predecessorAuthorityHeadSha256,
    observed_at_ms: observedAtMs,
  });
  const multiMeasurement = finalizeTopologyMeasurementReceiptV2({
    ...measurementClosure,
    kind: "DYNAMIC_MULTI_SIMULATION",
    graph_proposal_sha256: graphProposalSha256,
    ...metrics,
    wall_time_ms: multiEvidence.wall_time_ms,
    source_evidence_sha256: multiEvidence.record_sha256,
    predecessor_authority_head_sha256: preparation.predecessorAuthorityHeadSha256,
    observed_at_ms: observedAtMs,
  });
  const measured = store.transactExecutionV2({
    type: "RECORD_TOPOLOGY_MEASUREMENTS_V2",
    goalId: fixture.goalId,
    evidenceReceipts: [strongEvidence, multiEvidence],
    receipts: [strongMeasurement, multiMeasurement],
  }, {
    expectedVersion: fixture.version,
    idempotencyKey: `execution-helper:${suffix}:measurements`,
    actor: "RUNTIME",
    lease: fixture.lease,
  });
  const topologyClosure = {
    goal_id: fixture.goalId,
    plan_revision_id: preparation.planRevisionId,
    plan_revision_sha256: preparation.planRevisionSha256,
    input_closure_sha256: preparation.inputClosureSha256,
    runtime_fingerprint_sha256: runtimeFingerprintSha256,
  } as const;
  const baseline = finalizeStrongSingleBaselineV2({
    ...topologyClosure,
    ...metrics,
    wall_time_ms: strongMeasurement.wall_time_ms,
    evidence_sha256: strongMeasurement.record_sha256,
    observed_at_ms: observedAtMs,
  });
  const candidate = finalizeDynamicMultiCandidateV2({
    ...topologyClosure,
    graph_sha256: graphProposalSha256,
    total_node_count: 2,
    independent_node_count: 2,
    cross_partition_dependency_count: 0,
    write_scope_conflict_count: 0,
    task_packets_complete: true,
    independent_validation: true,
    estimated_quality_basis_points: multiMeasurement.quality_basis_points,
    estimated_wall_time_ms: multiMeasurement.wall_time_ms,
    estimated_provider_requests: multiMeasurement.provider_requests,
    estimated_input_tokens: multiMeasurement.input_tokens,
    estimated_output_tokens: multiMeasurement.output_tokens,
    estimated_user_interventions: multiMeasurement.user_interventions,
    estimated_safety_events: multiMeasurement.safety_events,
    simulator_receipt_sha256: multiMeasurement.record_sha256,
    estimated_at_ms: observedAtMs,
  });
  const postMeasurement = store.readExecutionV2Preparation(fixture.goalId, fixture.run.run_id);
  const gate = finalizeTopologyGateV2({
    ...topologyClosure,
    run_id: fixture.run.run_id,
    requested_topology: "MULTI",
    config_sha256: preparation.configSha256,
    strong_single_baseline: baseline,
    multi_candidate: candidate,
    predecessor_authority_head_sha256: postMeasurement.predecessorAuthorityHeadSha256,
    created_at_ms: fixture.authority.clock.now(),
  });
  const admitted = store.transactExecutionV2({
    type: "RECORD_TOPOLOGY_ADMISSION_V2",
    goalId: fixture.goalId,
    baseline,
    candidate,
    gate,
    topology: topologyFor(gate),
  }, {
    expectedVersion: measured.goalVersion,
    idempotencyKey: `execution-helper:${suffix}:admission`,
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
    runtime_fingerprint_sha256: runtimeFingerprintSha256,
    predecessor_authority_head_sha256: current.predecessorAuthorityHeadSha256,
    graph_revision: 1,
    stop_generation: 0,
    nodes: [
      providerNode({ id: "NODE-A", fixture, preparation: current, runtimeFingerprintSha256 }),
      providerNode({ id: "NODE-B", fixture, preparation: current, runtimeFingerprintSha256 }),
    ],
    edges: [],
    created_at_ms: fixture.authority.clock.now(),
  });
  const committed = store.transactExecutionV2({
    type: "COMMIT_EXECUTION_GRAPH_V2",
    goalId: fixture.goalId,
    graph,
  }, {
    expectedVersion: admitted.goalVersion,
    idempotencyKey: `execution-helper:${suffix}:graph`,
    actor: "RUNTIME",
    lease: fixture.lease,
  });
  return { fixture, graph, version: committed.goalVersion, runtimeFingerprintSha256 };
}
