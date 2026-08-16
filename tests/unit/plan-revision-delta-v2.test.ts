import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/foundation/crypto.js";
import { derivePlanRevisionDeltaV2 } from "../../src/plan-v2/revision-delta.js";
import type { PlanDependencyEdgeV2, PlanSubjectRefV2 } from "../../src/plan-v2/graph.js";

function subject(kind: PlanSubjectRefV2["kind"], id: string, revision: string): PlanSubjectRefV2 {
  return { kind, id, revision_sha256: sha256Hex(revision) };
}

describe("Plan Revision V2 delta", () => {
  it("invalidates only changed stable identities and their dependents while proving exact reuse", () => {
    const requirementA1 = subject("REQUIREMENT", "REQ-A", "req-a-v1");
    const requirementA2 = subject("REQUIREMENT", "REQ-A", "req-a-v2");
    const requirementB = subject("REQUIREMENT", "REQ-B", "req-b-v1");
    const cellA = subject("WORK_CELL", "build-a", "cell-a-v1");
    const cellB = subject("WORK_CELL", "build-b", "cell-b-v1");
    const previousEdges: PlanDependencyEdgeV2[] = [
      { source: requirementA1, target: cellA, dependency_kind: "REQUIRES" },
      { source: requirementB, target: cellB, dependency_kind: "REQUIRES" },
    ];
    const currentEdges: PlanDependencyEdgeV2[] = [
      { source: requirementA2, target: cellA, dependency_kind: "REQUIRES" },
      { source: requirementB, target: cellB, dependency_kind: "REQUIRES" },
    ];

    const delta = derivePlanRevisionDeltaV2({
      previous_plan_revision_id: "PLAN-REVISION-1",
      previous_plan_revision_sha256: sha256Hex("plan-v1"),
      current_plan_revision_id: "PLAN-REVISION-2",
      current_plan_revision_sha256: sha256Hex("plan-v2"),
      previous_subjects: [requirementA1, requirementB, cellA, cellB],
      previous_edges: previousEdges,
      current_subjects: [requirementA2, requirementB, cellA, cellB],
      current_edges: currentEdges,
    });

    expect(delta.modified_subjects.map((item) => item.before.id)).toEqual(["REQ-A"]);
    expect(delta.impact.invalidated_subjects.map((item) => item.id)).toEqual(["build-a", "REQ-A"]);
    expect(delta.reusable_subjects.map((item) => item.id)).toEqual(["build-b", "REQ-B"]);
    expect(delta.added_subjects).toEqual([]);
    expect(delta.removed_subjects).toEqual([]);
  });

  it("treats a dependency rewrite as structural invalidation instead of optimistic reuse", () => {
    const requirement = subject("REQUIREMENT", "REQ-A", "req-a-v1");
    const first = subject("WORK_CELL", "first", "first-v1");
    const second = subject("WORK_CELL", "second", "second-v1");
    const previousEdges: PlanDependencyEdgeV2[] = [
      { source: requirement, target: first, dependency_kind: "REQUIRES" },
      { source: first, target: second, dependency_kind: "REQUIRES" },
    ];
    const currentEdges: PlanDependencyEdgeV2[] = [
      { source: requirement, target: second, dependency_kind: "REQUIRES" },
      { source: first, target: second, dependency_kind: "REQUIRES" },
    ];

    const delta = derivePlanRevisionDeltaV2({
      previous_plan_revision_id: "PLAN-REVISION-1",
      previous_plan_revision_sha256: sha256Hex("plan-v1"),
      current_plan_revision_id: "PLAN-REVISION-2",
      current_plan_revision_sha256: sha256Hex("plan-v2"),
      previous_subjects: [requirement, first, second],
      previous_edges: previousEdges,
      current_subjects: [requirement, first, second],
      current_edges: currentEdges,
    });

    expect(delta.structurally_changed_subjects.map((item) => item.id)).toEqual(["first", "REQ-A", "second"]);
    expect(delta.impact.invalidated_subjects.map((item) => item.id)).toEqual(["first", "REQ-A", "second"]);
    expect(delta.reusable_subjects).toEqual([]);
  });
});
