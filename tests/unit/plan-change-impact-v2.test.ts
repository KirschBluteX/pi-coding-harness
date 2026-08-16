import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/foundation/crypto.js";
import { derivePlanChangeImpactV2 } from "../../src/plan-v2/change-impact.js";

const revision = "PLAN-REVISION-001";

function subject(kind: "REQUIREMENT" | "WORK_CELL", id: string) {
  return { kind, id, revision_sha256: sha256Hex(`${kind}:${id}`) } as const;
}

describe("Plan V2 change impact", () => {
  it("derives only the transitive dependent closure and preserves an independent WorkCell", () => {
    const requirementA = subject("REQUIREMENT", "REQ-A");
    const requirementB = subject("REQUIREMENT", "REQ-B");
    const workCellA = subject("WORK_CELL", "CELL-A");
    const workCellB = subject("WORK_CELL", "CELL-B");
    const validationA = subject("WORK_CELL", "CELL-VALIDATE-A");

    const impact = derivePlanChangeImpactV2({
      plan_revision_id: revision,
      plan_revision_sha256: sha256Hex(revision),
      changed_subjects: [requirementA],
      subjects: [requirementA, requirementB, workCellA, workCellB, validationA],
      edges: [
        { source: requirementA, target: workCellA, dependency_kind: "REQUIRES" },
        { source: workCellA, target: validationA, dependency_kind: "REQUIRES" },
        { source: requirementB, target: workCellB, dependency_kind: "REQUIRES" },
      ],
    });

    expect(impact.invalidated_subjects.map((item) => item.id)).toEqual([
      "CELL-A",
      "CELL-VALIDATE-A",
      "REQ-A",
    ]);
    expect(impact.reusable_subjects.map((item) => item.id)).toEqual(["CELL-B", "REQ-B"]);
    expect(impact.changed_root_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(impact.invalidation_root_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(impact.reuse_root_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(impact.propagation_edges.map((edge) => [edge.source.id, edge.target.id])).toEqual([
      ["REQ-A", "CELL-A"],
      ["CELL-A", "CELL-VALIDATE-A"],
    ]);
  });

  it("rejects a cyclic dependency graph before deriving authority impact", () => {
    const requirement = subject("REQUIREMENT", "REQ-A");
    const workCell = subject("WORK_CELL", "CELL-A");
    expect(() => derivePlanChangeImpactV2({
      plan_revision_id: revision,
      plan_revision_sha256: sha256Hex(revision),
      changed_subjects: [requirement],
      subjects: [requirement, workCell],
      edges: [
        { source: requirement, target: workCell, dependency_kind: "REQUIRES" },
        { source: workCell, target: requirement, dependency_kind: "DERIVED_FROM" },
      ],
    })).toThrow(/cycle/iu);
  });

  it("rejects duplicate changed subjects instead of silently normalizing caller input", () => {
    const requirement = subject("REQUIREMENT", "REQ-A");
    const workCell = subject("WORK_CELL", "CELL-A");
    expect(() => derivePlanChangeImpactV2({
      plan_revision_id: revision,
      plan_revision_sha256: sha256Hex(revision),
      changed_subjects: [requirement, requirement],
      subjects: [requirement, workCell],
      edges: [{ source: requirement, target: workCell, dependency_kind: "REQUIRES" }],
    })).toThrow(/repeats.*changed|changed.*repeats/iu);
  });

  it("does not turn an authorization edge into execution invalidation", () => {
    const decision = { kind: "DECISION", id: "DRAFT-REVIEW", revision_sha256: sha256Hex("draft") } as const;
    const requirement = subject("REQUIREMENT", "REQ-A");
    const workCell = subject("WORK_CELL", "CELL-A");
    const impact = derivePlanChangeImpactV2({
      plan_revision_id: revision,
      plan_revision_sha256: sha256Hex(revision),
      changed_subjects: [decision],
      subjects: [decision, requirement, workCell],
      edges: [
        { source: decision, target: requirement, dependency_kind: "AUTHORIZES" },
        { source: requirement, target: workCell, dependency_kind: "REQUIRES" },
      ],
    });
    expect(impact.invalidated_subjects.map((item) => item.id)).toEqual(["DRAFT-REVIEW"]);
    expect(impact.reusable_subjects.map((item) => item.id)).toEqual(["CELL-A", "REQ-A"]);
  });
});
