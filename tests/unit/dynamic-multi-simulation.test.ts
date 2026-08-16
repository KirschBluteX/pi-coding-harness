import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/foundation/crypto.js";
import { finalizeStrongSingleRolloutReceiptV1 } from "../../src/harness-v2/strong-single-rollout.js";
import { simulateDynamicMultiAdmissionV1 } from "../../src/harness-v2/dynamic-multi-simulation.js";

function baseline() {
  return finalizeStrongSingleRolloutReceiptV1({
    goal_id: "GOAL-SIMULATION",
    run_id: "RUN-SIMULATION",
    work_cell_id: "WORK-CELL-SIMULATION",
    plan_revision_id: "PLAN-SIMULATION",
    plan_revision_sha256: sha256Hex("plan"),
    input_closure_sha256: sha256Hex("input"),
    runtime_fingerprint_sha256: sha256Hex("runtime"),
    topology_revision: 1,
    topology_revision_sha256: sha256Hex("topology"),
    config_sha256: sha256Hex("config"),
    authorization_id: "AUTHORIZATION-SIMULATION",
    authorization_sha256: sha256Hex("authorization"),
    baseline_sha256: sha256Hex("baseline"),
    baseline_content_root_sha256: sha256Hex("baseline-root"),
    environment_sha256: sha256Hex("environment"),
    completion_receipt_id: "COMPLETION-SIMULATION",
    completion_receipt_sha256: sha256Hex("completion"),
    provider_requests: 2,
    input_tokens: 10_000,
    output_tokens: 2_000,
    cache_read_tokens: 0,
    provider_receipt_refs: [],
    user_interventions: 0,
    safety_events: 0,
    started_at_ms: 1_000,
    completed_at_ms: 11_000,
  });
}

describe("Dynamic Multi admission simulation", () => {
  it("uses the real DAG to prove wall-time benefit without inventing token savings", () => {
    const result = simulateDynamicMultiAdmissionV1({
      baseline: baseline(),
      graph_proposal_sha256: sha256Hex("graph"),
      independent_node_count: 2,
      nodes: [
        { node_id: "A", capability: "DISCOVER", dependency_ids: [], patch_proposal: false,
          work_weight: 1, exact_input_sha256s: [sha256Hex("a")] },
        { node_id: "B", capability: "PATCH", dependency_ids: [], patch_proposal: true,
          work_weight: 1, exact_input_sha256s: [sha256Hex("b")] },
      ],
    });
    expect(result).toMatchObject({
      correctness: "PASS",
      estimated_provider_requests: 2,
      estimated_input_tokens: 10_000,
      estimated_output_tokens: 2_000,
    });
    expect(result.estimated_wall_time_ms).toBeLessThan(10_000);
  });

  it("penalizes duplicated exact inputs and fails closed when the baseline cannot fund the DAG", () => {
    const shared = sha256Hex("shared");
    const duplicate = simulateDynamicMultiAdmissionV1({
      baseline: baseline(), graph_proposal_sha256: sha256Hex("duplicate"), independent_node_count: 2,
      nodes: [
        { node_id: "A", capability: "READ", dependency_ids: [], patch_proposal: false,
          work_weight: 1, exact_input_sha256s: [shared] },
        { node_id: "B", capability: "READ", dependency_ids: [], patch_proposal: false,
          work_weight: 1, exact_input_sha256s: [shared] },
      ],
    });
    expect(duplicate.estimated_input_tokens).toBe(15_000);
    const tiny = { ...baseline(), wall_time_ms: 1 };
    expect(simulateDynamicMultiAdmissionV1({
      baseline: tiny, graph_proposal_sha256: sha256Hex("tiny"), independent_node_count: 2,
      nodes: [
        { node_id: "A", capability: "READ", dependency_ids: [], patch_proposal: false,
          work_weight: 1, exact_input_sha256s: [] },
        { node_id: "B", capability: "READ", dependency_ids: [], patch_proposal: false,
          work_weight: 1, exact_input_sha256s: [] },
      ],
    }).correctness).toBe("FAIL");
  });
});
