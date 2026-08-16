import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/foundation/crypto.js";
import {
  comparableWorkloadDimensionsV1,
  finalizeComparableWorkloadV1,
  finalizeStrongSingleWorkloadBindingV1,
} from "../../src/harness-v2/workload-comparability.js";

function workload() {
  return finalizeComparableWorkloadV1({
    work_cell_semantics_sha256: sha256Hex("work-cell"),
    requirement_content_root_sha256: sha256Hex("requirements"),
    obligation_content_root_sha256: sha256Hex("obligations"),
    decision_content_root_sha256: sha256Hex("decisions"),
    oracle_set_sha256: sha256Hex("oracle"),
    scope_sha256: sha256Hex("scope"),
    effect_policy_sha256: sha256Hex("effects"),
    input_content_root_sha256: sha256Hex("input"),
    environment_sha256: sha256Hex("environment"),
    runtime_fingerprint_sha256: sha256Hex("runtime"),
    comparison_config_sha256: sha256Hex("config"),
    provider_profile_sha256: sha256Hex("provider-profile"),
    cache_epoch_sha256: sha256Hex("cache-epoch"),
  });
}

describe("Strong Single workload comparability", () => {
  it("changes the workload key when any explicit comparability dimension changes", () => {
    const baseline = workload();
    const baselineDimensions = Object.fromEntries(
      comparableWorkloadDimensionsV1.map((field) => [field, baseline[field]]),
    ) as Record<typeof comparableWorkloadDimensionsV1[number], string>;
    expect(comparableWorkloadDimensionsV1).toHaveLength(13);
    for (const field of comparableWorkloadDimensionsV1) {
      expect(finalizeComparableWorkloadV1({
        ...baselineDimensions,
        [field]: sha256Hex(`changed:${field}`),
      }).workload_key_sha256).not.toBe(baseline.workload_key_sha256);
    }
  });

  it("keeps execution identity, topology and timestamps out of the workload key", () => {
    const descriptor = workload();
    const first = finalizeStrongSingleWorkloadBindingV1({
      source_goal_id: "GOAL-A",
      source_run_id: "RUN-A",
      source_work_cell_id: "CELL-A",
      source_rollout_receipt_id: "ROLLOUT-A",
      source_rollout_receipt_sha256: sha256Hex("rollout-a"),
      source_topology_revision: 1,
      source_topology_revision_sha256: sha256Hex("topology-a"),
      workload: descriptor,
      created_at_ms: 100,
    });
    const second = finalizeStrongSingleWorkloadBindingV1({
      source_goal_id: "GOAL-B",
      source_run_id: "RUN-B",
      source_work_cell_id: "CELL-B",
      source_rollout_receipt_id: "ROLLOUT-B",
      source_rollout_receipt_sha256: sha256Hex("rollout-b"),
      source_topology_revision: 99,
      source_topology_revision_sha256: sha256Hex("topology-b"),
      workload: descriptor,
      created_at_ms: 999,
    });
    expect(first.workload_key_sha256).toBe(second.workload_key_sha256);
    expect(first.record_sha256).not.toBe(second.record_sha256);
  });

  it("rejects missing, malformed or substituted workload hashes", () => {
    const descriptor = workload();
    expect(() => finalizeComparableWorkloadV1({
      ...descriptor,
      cache_epoch_sha256: "C0",
    })).toThrow(/cache epoch/u);
    expect(() => finalizeComparableWorkloadV1({
      ...descriptor,
      workload_key_sha256: sha256Hex("substituted"),
    })).toThrow(/workload key/u);
  });
});
