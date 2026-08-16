import { describe, expect, it } from "vitest";
import {
  finalizeDynamicMultiCandidateV2, finalizeStrongSingleBaselineV2, finalizeTopologyGateV2,
} from "../../src/harness-v2/topology-gate.js";
import { sha256Hex } from "../../src/foundation/crypto.js";

describe("Topology Gate V2", () => {
  const closure = {
    goal_id: "GOAL-TOPOLOGY-GATE-001",
    plan_revision_id: "PLAN-REVISION-TOPOLOGY-GATE-001",
    plan_revision_sha256: sha256Hex("plan"),
    input_closure_sha256: sha256Hex("closure"),
    runtime_fingerprint_sha256: sha256Hex("runtime"),
  } as const;

  it("keeps a requested Multi run on Strong Single when baseline evidence is absent", () => {
    const receipt = finalizeTopologyGateV2({
      ...closure,
      run_id: "RUN-TOPOLOGY-GATE-001",
      requested_topology: "MULTI",
      config_sha256: sha256Hex("config"),
      strong_single_baseline: null,
      multi_candidate: null,
      predecessor_authority_head_sha256: sha256Hex("predecessor"),
      created_at_ms: 1_785_370_000_000,
    });

    expect(receipt).toMatchObject({
      requested_topology: "MULTI",
      effective_topology: "SINGLE",
      verdict: "DENY",
      reason_code: "STRONG_SINGLE_BASELINE_REQUIRED",
      strong_single_baseline_id: null,
      multi_candidate_id: null,
    });
  });

  it("admits Multi only when a same-closure candidate improves without cost or safety regression", () => {
    const baseline = finalizeStrongSingleBaselineV2({
      ...closure, correctness: "PASS", quality_basis_points: 10_000, wall_time_ms: 10_000,
      provider_requests: 2, input_tokens: 8_000, output_tokens: 2_000, user_interventions: 1, safety_events: 0,
      evidence_sha256: sha256Hex("single-evidence"), observed_at_ms: 1_785_369_900_000,
    });
    const candidate = finalizeDynamicMultiCandidateV2({
      ...closure, graph_sha256: sha256Hex("graph"), total_node_count: 3, independent_node_count: 2,
      cross_partition_dependency_count: 1, write_scope_conflict_count: 0,
      task_packets_complete: true, independent_validation: true,
      estimated_quality_basis_points: 10_000, estimated_wall_time_ms: 7_000,
      estimated_provider_requests: 2, estimated_input_tokens: 8_000, estimated_output_tokens: 2_000,
      estimated_user_interventions: 1, estimated_safety_events: 0,
      simulator_receipt_sha256: sha256Hex("simulator"), estimated_at_ms: 1_785_369_950_000,
    });

    expect(finalizeTopologyGateV2({
      ...closure, run_id: "RUN-TOPOLOGY-GATE-ALLOW", requested_topology: "MULTI",
      config_sha256: sha256Hex("config"), strong_single_baseline: baseline, multi_candidate: candidate,
      predecessor_authority_head_sha256: sha256Hex("predecessor"),
      created_at_ms: 1_785_370_000_000,
    })).toMatchObject({
      effective_topology: "MULTI", verdict: "ALLOW", reason_code: "MULTI_NET_BENEFIT_PROVEN",
      strong_single_baseline_id: baseline.strong_single_baseline_id,
      multi_candidate_id: candidate.multi_candidate_id,
    });
  });

  it("denies a faster candidate when provider cost regresses", () => {
    const baseline = finalizeStrongSingleBaselineV2({
      ...closure, correctness: "PASS", quality_basis_points: 10_000, wall_time_ms: 10_000,
      provider_requests: 1, input_tokens: 8_000, output_tokens: 2_000, user_interventions: 0, safety_events: 0,
      evidence_sha256: sha256Hex("single-cost-evidence"), observed_at_ms: 1_785_369_900_000,
    });
    const candidate = finalizeDynamicMultiCandidateV2({
      ...closure, graph_sha256: sha256Hex("cost-regression"), total_node_count: 2, independent_node_count: 2,
      cross_partition_dependency_count: 0, write_scope_conflict_count: 0,
      task_packets_complete: true, independent_validation: true,
      estimated_quality_basis_points: 10_000, estimated_wall_time_ms: 5_000,
      estimated_provider_requests: 2, estimated_input_tokens: 8_000, estimated_output_tokens: 2_000,
      estimated_user_interventions: 0, estimated_safety_events: 0,
      simulator_receipt_sha256: sha256Hex("cost-simulator"), estimated_at_ms: 1_785_369_950_000,
    });
    expect(finalizeTopologyGateV2({
      ...closure, run_id: "RUN-TOPOLOGY-GATE-COST", requested_topology: "MULTI",
      config_sha256: sha256Hex("config"), strong_single_baseline: baseline, multi_candidate: candidate,
      predecessor_authority_head_sha256: sha256Hex("predecessor"),
      created_at_ms: 1_785_370_000_000,
    })).toMatchObject({
      effective_topology: "SINGLE", verdict: "DENY", reason_code: "COST_OR_SAFETY_REGRESSION",
    });
  });

  it("rejects stale baseline and candidate closures instead of comparing them", () => {
    const stale = finalizeStrongSingleBaselineV2({
      ...closure, input_closure_sha256: sha256Hex("stale"), correctness: "PASS",
      quality_basis_points: 10_000, wall_time_ms: 10_000, provider_requests: 1,
      input_tokens: 1, output_tokens: 1, user_interventions: 0, safety_events: 0,
      evidence_sha256: sha256Hex("stale-evidence"), observed_at_ms: 1_785_369_900_000,
    });
    expect(() => finalizeTopologyGateV2({
      ...closure, run_id: "RUN-TOPOLOGY-GATE-STALE", requested_topology: "MULTI",
      config_sha256: sha256Hex("config"), strong_single_baseline: stale, multi_candidate: null,
      predecessor_authority_head_sha256: sha256Hex("predecessor"),
      created_at_ms: 1_785_370_000_000,
    })).toThrow(/does not bind the current topology closure/u);
  });

  it("rejects caller shape substitution and SINGLE evidence that SQL cannot persist", () => {
    const baseline = finalizeStrongSingleBaselineV2({
      ...closure, correctness: "PASS", quality_basis_points: 10_000, wall_time_ms: 10_000,
      provider_requests: 1, input_tokens: 8_000, output_tokens: 2_000, user_interventions: 0, safety_events: 0,
      evidence_sha256: sha256Hex("single-shape-evidence"), observed_at_ms: 1_785_369_900_000,
    });
    expect(() => finalizeTopologyGateV2({
      ...closure, run_id: "RUN-TOPOLOGY-GATE-SINGLE-EVIDENCE", requested_topology: "SINGLE",
      config_sha256: sha256Hex("config"), strong_single_baseline: baseline, multi_candidate: null,
      predecessor_authority_head_sha256: sha256Hex("predecessor"), created_at_ms: 1_785_370_000_000,
    })).toThrow(/SINGLE topology cannot carry/u);
    expect(() => finalizeStrongSingleBaselineV2({
      ...closure, correctness: "PASS", quality_basis_points: 10_000, wall_time_ms: 10_000,
      provider_requests: 1, input_tokens: 8_000, output_tokens: 2_000, user_interventions: 0, safety_events: 0,
      evidence_sha256: sha256Hex("single-shape-evidence"), observed_at_ms: 1_785_369_900_000,
      strong_single_baseline_id: "FORGED",
    } as never)).toThrow(/unexpected field/u);
  });

  it("denies high coordination and wall-time regression despite an isolated token improvement", () => {
    const baseline = finalizeStrongSingleBaselineV2({
      ...closure, correctness: "PASS", quality_basis_points: 10_000, wall_time_ms: 10_000,
      provider_requests: 1, input_tokens: 8_000, output_tokens: 2_000, user_interventions: 0, safety_events: 0,
      evidence_sha256: sha256Hex("single-coordination-evidence"), observed_at_ms: 1_785_369_900_000,
    });
    const candidate = finalizeDynamicMultiCandidateV2({
      ...closure, graph_sha256: sha256Hex("coordination-graph"), total_node_count: 4, independent_node_count: 2,
      cross_partition_dependency_count: 2, write_scope_conflict_count: 0,
      task_packets_complete: true, independent_validation: true,
      estimated_quality_basis_points: 10_000, estimated_wall_time_ms: 20_000,
      estimated_provider_requests: 1, estimated_input_tokens: 7_999, estimated_output_tokens: 2_000,
      estimated_user_interventions: 0, estimated_safety_events: 0,
      simulator_receipt_sha256: sha256Hex("coordination-simulator"), estimated_at_ms: 1_785_369_950_000,
    });
    expect(finalizeTopologyGateV2({
      ...closure, run_id: "RUN-TOPOLOGY-GATE-COORDINATION", requested_topology: "MULTI",
      config_sha256: sha256Hex("config"), strong_single_baseline: baseline, multi_candidate: candidate,
      predecessor_authority_head_sha256: sha256Hex("predecessor"), created_at_ms: 1_785_370_000_000,
    })).toMatchObject({ effective_topology: "SINGLE", verdict: "DENY" });
  });

  it("uses the exact Plan, config, predecessor and time in gate identity", () => {
    const base = {
      ...closure, run_id: "RUN-TOPOLOGY-GATE-IDENTITY", requested_topology: "MULTI" as const,
      config_sha256: sha256Hex("config"), strong_single_baseline: null, multi_candidate: null,
      predecessor_authority_head_sha256: sha256Hex("predecessor"), created_at_ms: 1_785_370_000_000,
    };
    const first = finalizeTopologyGateV2(base);
    const next = finalizeTopologyGateV2({ ...base, predecessor_authority_head_sha256: sha256Hex("next-predecessor"), created_at_ms: base.created_at_ms + 1 });
    expect(next.topology_gate_receipt_id).not.toBe(first.topology_gate_receipt_id);
  });
});
