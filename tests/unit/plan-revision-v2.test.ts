import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/foundation/crypto.js";
import { finalizePlanRevisionV2 } from "../../src/plan-v2/finalize.js";
import type { PlanSubjectKindV2, PlanSubjectRefV2 } from "../../src/plan-v2/graph.js";

function subject(kind: PlanSubjectKindV2, id: string): PlanSubjectRefV2 {
  return { kind, id, revision_sha256: sha256Hex(`${kind}:${id}`) };
}

describe("Plan Revision V2", () => {
  it("freezes a hash-bound acyclic Plan that reaches every MUST requirement", () => {
    const requirementA = subject("REQUIREMENT", "REQ-A");
    const requirementB = subject("REQUIREMENT", "REQ-B");
    const workCellA = subject("WORK_CELL", "CELL-A");
    const workCellB = subject("WORK_CELL", "CELL-B");
    const plan = finalizePlanRevisionV2({
      goal_id: "GOAL-001",
      contract_id: "CONTRACT-001",
      authority_root_id: "AUTHORITY-ROOT-001",
      contract_freeze_receipt_id: "CONTRACT-FREEZE-001",
      contract_freeze_sha256: sha256Hex("contract-freeze"),
      requirement_revision_id: "REQUIREMENT-REVISION-001",
      requirement_revision_sha256: sha256Hex("requirement-revision"),
      route_id: "ROUTE-001",
      route_sha256: sha256Hex("route"),
      revision: 1,
      parent_plan_revision_id: null,
      parent_plan_revision_sha256: null,
      subjects: [requirementA, requirementB, workCellA, workCellB],
      edges: [
        { source: requirementA, target: workCellA, dependency_kind: "REQUIRES" },
        { source: requirementB, target: workCellB, dependency_kind: "REQUIRES" },
      ],
      must_requirements: [requirementA, requirementB],
      work_cells: [workCellA, workCellB],
      created_at_ms: 1_800_000_000_000,
    });

    expect(plan).toMatchObject({
      schema_version: 2,
      goal_id: "GOAL-001",
      contract_id: "CONTRACT-001",
      requirement_count: 2,
      work_cell_count: 2,
      revision: 1,
      parent_plan_revision_id: null,
    });
    expect(plan.plan_revision_id).toMatch(/^PLAN_REVISION-[A-F0-9]{64}$/u);
    expect(plan.record_sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("does not treat an authorization-only edge as MUST implementation coverage", () => {
    const requirement = subject("REQUIREMENT", "REQ-A");
    const workCell = subject("WORK_CELL", "CELL-A");
    expect(() => finalizePlanRevisionV2({
      goal_id: "GOAL-001",
      contract_id: "CONTRACT-001",
      authority_root_id: "AUTHORITY-ROOT-001",
      contract_freeze_receipt_id: "CONTRACT-FREEZE-001",
      contract_freeze_sha256: sha256Hex("contract-freeze"),
      requirement_revision_id: "REQUIREMENT-REVISION-001",
      requirement_revision_sha256: sha256Hex("requirement-revision"),
      route_id: "ROUTE-001",
      route_sha256: sha256Hex("route"),
      revision: 1,
      parent_plan_revision_id: null,
      parent_plan_revision_sha256: null,
      subjects: [requirement, workCell],
      edges: [{ source: requirement, target: workCell, dependency_kind: "AUTHORIZES" }],
      must_requirements: [requirement],
      work_cells: [workCell],
      created_at_ms: 1_800_000_000_000,
    })).toThrow(/MUST requirement.*reachable WorkCell/iu);
  });
});
