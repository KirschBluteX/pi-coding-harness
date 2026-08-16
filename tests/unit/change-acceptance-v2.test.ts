import { describe, expect, it } from "vitest";
import { canonicalJsonSha256 } from "../../src/authority/canonical-json.js";
import { sha256Hex } from "../../src/foundation/crypto.js";
import { derivePlanChangeImpactV2 } from "../../src/plan-v2/change-impact.js";
import {
  finalizeChangeAcceptanceClosureV2,
  finalizeDecisionPlanBindingV2,
  deriveChangeInvalidationClosureV2,
} from "../../src/plan-v2/change-acceptance.js";
import type { PlanDependencyEdgeV2, PlanSubjectRefV2 } from "../../src/plan-v2/graph.js";

function subject(kind: PlanSubjectRefV2["kind"], id: string, revision: string): PlanSubjectRefV2 {
  return { kind, id, revision_sha256: sha256Hex(revision) };
}

const requirementA = subject("REQUIREMENT", "REQ-A", "req-a-v1");
const requirementB = subject("REQUIREMENT", "REQ-B", "req-b-v1");
const cellA = subject("WORK_CELL", "CELL-A", "cell-a-v1");
const cellB = subject("WORK_CELL", "CELL-B", "cell-b-v1");
const baseSubjects = [requirementA, requirementB, cellA, cellB] as const;
const baseEdges: readonly PlanDependencyEdgeV2[] = [
  { source: requirementA, target: cellA, dependency_kind: "REQUIRES" },
  { source: requirementB, target: cellB, dependency_kind: "REQUIRES" },
];
const basePlan = {
  id: "PLAN-BASE",
  sha256: sha256Hex("plan-base"),
  subjects: baseSubjects,
  edges: baseEdges,
} as const;

function impact(changed: readonly PlanSubjectRefV2[]) {
  return derivePlanChangeImpactV2({
    plan_revision_id: basePlan.id,
    plan_revision_sha256: basePlan.sha256,
    changed_subjects: changed,
    subjects: basePlan.subjects,
    edges: basePlan.edges,
  });
}

function derive(input: {
  readonly successorSubjects: readonly PlanSubjectRefV2[];
  readonly successorEdges?: readonly PlanDependencyEdgeV2[];
  readonly impacts: readonly ReturnType<typeof impact>[];
}) {
  const successorByIdentity = new Map(input.successorSubjects.map((entry) => [`${entry.kind}\0${entry.id}`, entry]));
  const successorEdges = input.successorEdges ?? basePlan.edges.map((edge) => ({
    ...edge,
    source: successorByIdentity.get(`${edge.source.kind}\0${edge.source.id}`)!,
    target: successorByIdentity.get(`${edge.target.kind}\0${edge.target.id}`)!,
  }));
  return deriveChangeInvalidationClosureV2({
    base_plan_revision_id: basePlan.id,
    base_plan_revision_sha256: basePlan.sha256,
    successor_plan_revision_id: "PLAN-SUCCESSOR",
    successor_plan_revision_sha256: sha256Hex("plan-successor"),
    base_subjects: basePlan.subjects,
    base_edges: basePlan.edges,
    successor_subjects: input.successorSubjects,
    successor_edges: successorEdges,
    request_impacts: input.impacts,
  });
}

describe("Change Acceptance V2 invalidation closure", () => {
  it("keeps a leaf WorkCell change local and preserves an independent branch", () => {
    const changedCell = subject("WORK_CELL", cellA.id, "cell-a-v2");
    const closure = derive({
      successorSubjects: [requirementA, requirementB, changedCell, cellB],
      impacts: [impact([cellA])],
    });

    expect(closure.members).toEqual([
      expect.objectContaining({
        subject: cellA,
        local: true,
        upstream: false,
        structural: false,
      }),
    ]);
    expect(closure.reusable_subjects).toEqual([cellB, requirementA, requirementB]);
  });

  it("propagates an upstream Requirement revision only through its dependent branch", () => {
    const changedRequirement = subject("REQUIREMENT", requirementA.id, "req-a-v2");
    const closure = derive({
      successorSubjects: [changedRequirement, requirementB, cellA, cellB],
      impacts: [impact([requirementA])],
    });

    expect(closure.members).toEqual([
      expect.objectContaining({ subject: cellA, local: true, upstream: true, structural: false }),
      expect.objectContaining({ subject: requirementA, local: true, upstream: true, structural: false }),
    ]);
    expect(closure.reusable_subjects).toEqual([cellB, requirementB]);
  });

  it("marks edge-only changes as structural even when every subject hash is unchanged", () => {
    const successorEdges: readonly PlanDependencyEdgeV2[] = [
      { source: requirementA, target: cellB, dependency_kind: "REQUIRES" },
      { source: requirementB, target: cellB, dependency_kind: "REQUIRES" },
    ];
    const closure = derive({
      successorSubjects: baseSubjects,
      successorEdges,
      impacts: [impact([requirementA, cellB])],
    });

    expect(closure.members).toEqual([
      expect.objectContaining({ subject: cellA, structural: true }),
      expect.objectContaining({ subject: cellB, structural: true }),
      expect.objectContaining({ subject: requirementA, structural: true }),
    ]);
    expect(closure.reusable_subjects).toEqual([requirementB]);
  });

  it("rejects a material request that has no intersection with the real successor delta", () => {
    expect(() => derive({
      successorSubjects: baseSubjects,
      impacts: [impact([cellA])],
    })).toThrow(/no material successor delta/iu);
  });

  it("rejects a successor delta that is not completely covered by the material request union", () => {
    expect(() => derive({
      successorSubjects: [
        requirementA,
        requirementB,
        subject("WORK_CELL", cellA.id, "cell-a-v2"),
        subject("WORK_CELL", cellB.id, "cell-b-v2"),
      ],
      impacts: [impact([cellA])],
    })).toThrow(/complete successor delta/iu);
  });
});

describe("Decision Plan Binding V2", () => {
  const decisionA = subject("DECISION", "DECISION-Z", "decision-z");
  const decisionB = subject("DECISION", "decision-a", "decision-a");
  const requirement = subject("REQUIREMENT", "REQ-BINDING", "requirement-binding");
  const workCellA = subject("WORK_CELL", "CELL-BINDING-A", "cell-binding-a");
  const workCellB = subject("WORK_CELL", "CELL-BINDING-B", "cell-binding-b");
  const subjects = [decisionA, decisionB, requirement, workCellA, workCellB] as const;
  const edges: readonly PlanDependencyEdgeV2[] = [
    { source: decisionA, target: requirement, dependency_kind: "AUTHORIZES" },
    { source: decisionB, target: requirement, dependency_kind: "DERIVED_FROM" },
    { source: requirement, target: workCellA, dependency_kind: "REQUIRES" },
  ];
  const closureMembers = [
    {
      decision_requirement_revision_id: "DECISION-REVISION-A",
      decision_requirement_id: decisionA.id,
      decision_resolution_id: "RESOLUTION-A",
      state: "APPROVED" as const,
    },
    {
      decision_requirement_revision_id: "DECISION-REVISION-B",
      decision_requirement_id: decisionB.id,
      decision_resolution_id: "RESOLUTION-B",
      state: "DEFERRED" as const,
    },
  ];
  const closureBody = {
    schema_version: 2 as const,
    decision_closure_id: "DECISION-CLOSURE-MATERIAL",
    requirement_revision_id: "REQUIREMENT-REVISION-MATERIAL",
    goal_id: "GOAL-MATERIAL",
    contract_id: "CONTRACT-MATERIAL",
    authority_root_id: "AUTHORITY-MATERIAL",
    gate: "MATERIAL_CHANGE" as const,
    decision_root_sha256: sha256Hex("decision-root"),
    resolution_root_sha256: sha256Hex("resolution-root"),
    member_root_sha256: canonicalJsonSha256({
      domain: "PCH-DECISION-CLOSURE-MEMBERS-V2",
      members: closureMembers,
    }),
    unresolved_decision_ids: [],
    rejected_decision_ids: [],
    edited_decision_ids: [],
    deferred_decision_ids: [decisionB.id],
    due_deferred_decision_ids: [],
    draft_review_approved: true,
    qualified: true,
    created_at_ms: 2,
  };
  const closure = {
    closure: {
      ...closureBody,
      record_sha256: canonicalJsonSha256({ domain: "PCH-DECISION-CLOSURE-V2", ...closureBody }),
    },
    members: closureMembers,
  };
  const decisions = [
    {
      decision_requirement_revision_id: "DECISION-REVISION-A",
      decision_requirement_id: decisionA.id,
      record_sha256: decisionA.revision_sha256,
      affected_work_cell_ids: [],
    },
    {
      decision_requirement_revision_id: "DECISION-REVISION-B",
      decision_requirement_id: decisionB.id,
      record_sha256: decisionB.revision_sha256,
      affected_work_cell_ids: [workCellB.id],
    },
  ];
  const resolutions = [
    { decision_resolution_id: "RESOLUTION-A", record_sha256: sha256Hex("resolution-a") },
    { decision_resolution_id: "RESOLUTION-B", record_sha256: sha256Hex("resolution-b") },
  ];

  function bind(input: {
    readonly planSubjects?: readonly PlanSubjectRefV2[];
    readonly planEdges?: readonly PlanDependencyEdgeV2[];
    readonly decisionClosure?: typeof closure;
    readonly decisionRecords?: readonly typeof decisions[number][];
    readonly resolutionRecords?: readonly typeof resolutions[number][];
  } = {}) {
    return finalizeDecisionPlanBindingV2({
      plan: {
        plan_revision_id: "PLAN-MATERIAL",
        record_sha256: sha256Hex("plan-material"),
        requirement_revision_id: closure.closure.requirement_revision_id,
        requirement_revision_sha256: sha256Hex("requirement-revision"),
        goal_id: closure.closure.goal_id,
        contract_id: closure.closure.contract_id,
        authority_root_id: closure.closure.authority_root_id,
      },
      subjects: input.planSubjects ?? subjects,
      edges: input.planEdges ?? edges,
      decision_closure: input.decisionClosure ?? closure,
      decisions: input.decisionRecords ?? decisions,
      resolutions: input.resolutionRecords ?? resolutions,
      created_at_ms: 3,
    });
  }

  it("binds every current Decision and its effective resolution to exact WorkCells", () => {
    const binding = bind();

    expect(binding.members).toEqual([
      expect.objectContaining({
        decision_requirement_id: decisionA.id,
        decision_state: "APPROVED",
        target_work_cells: [workCellA],
      }),
      expect.objectContaining({
        decision_requirement_id: decisionB.id,
        decision_state: "DEFERRED",
        target_work_cells: [workCellB],
      }),
    ]);
    expect(binding.binding.member_count).toBe(2);
    expect(binding.members.map((member) => member.decision_requirement_id))
      .toEqual([decisionA.id, decisionB.id]);
  });

  it("rejects a Plan that omits one current Decision", () => {
    expect(() => bind({
      planSubjects: subjects.filter((entry) => entry.id !== decisionB.id),
      planEdges: edges.filter((edge) => edge.source.id !== decisionB.id),
    })).toThrow(/complete Decision frontier/iu);
  });

  it("rejects a deferred Decision that still authorizes the successor graph", () => {
    const invalidEdges: readonly PlanDependencyEdgeV2[] = [
      edges[0]!,
      { source: decisionB, target: requirement, dependency_kind: "AUTHORIZES" },
      edges[2]!,
    ];
    expect(() => bind({ planEdges: invalidEdges })).toThrow(/non-approved.*AUTHORIZES/iu);
  });

  it("rejects a missing effective resolution instead of binding a stale Decision", () => {
    expect(() => bind({ resolutionRecords: [resolutions[0]!] }))
      .toThrow(/effective resolution/iu);
  });

  it("rejects a forged source Decision closure before deriving a Plan binding", () => {
    expect(() => bind({
      decisionClosure: {
        closure: closure.closure,
        members: closure.members.map((member, index) => index === 0
          ? { ...member, decision_resolution_id: "RESOLUTION-ATTACKER" }
          : member),
      },
    })).toThrow(/Decision closure member root/iu);
  });

  it("rejects unbounded Decision and resolution frontiers before processing", () => {
    expect(() => bind({
      decisionRecords: Array.from({ length: 1_025 }, () => decisions[0]!),
    })).toThrow(/1\.\.1024/iu);
    expect(() => bind({
      resolutionRecords: Array.from({ length: 1_025 }, () => resolutions[0]!),
    })).toThrow(/1\.\.1024/iu);
  });

  it("rejects repeated affected WorkCells instead of silently collapsing them", () => {
    expect(() => bind({
      decisionRecords: [
        decisions[0]!,
        { ...decisions[1]!, affected_work_cell_ids: [workCellB.id, workCellB.id] },
      ],
    })).toThrow(/repeats an affected WorkCell/iu);
  });

  function acceptanceFixture() {
    const successorRequirement = subject("REQUIREMENT", requirement.id, "requirement-binding-v2");
    const successorCellA = subject("WORK_CELL", workCellA.id, "cell-binding-a-v2");
    const successorSubjects = [decisionA, decisionB, successorRequirement, successorCellA, workCellB] as const;
    const successorEdges: readonly PlanDependencyEdgeV2[] = [
      { source: decisionA, target: successorRequirement, dependency_kind: "AUTHORIZES" },
      { source: decisionB, target: successorRequirement, dependency_kind: "DERIVED_FROM" },
      { source: successorRequirement, target: successorCellA, dependency_kind: "REQUIRES" },
    ];
    const decisionBinding = bind({ planSubjects: successorSubjects, planEdges: successorEdges });
    const basePlanSha256 = sha256Hex("plan-material-base");
    const requestImpact = derivePlanChangeImpactV2({
      plan_revision_id: "PLAN-MATERIAL-BASE",
      plan_revision_sha256: basePlanSha256,
      changed_subjects: [requirement],
      subjects,
      edges,
    });
    return {
      base_plan: {
        plan_revision_id: "PLAN-MATERIAL-BASE",
        record_sha256: basePlanSha256,
        subjects,
        edges,
      },
      successor_plan: {
        plan_revision_id: "PLAN-MATERIAL",
        record_sha256: sha256Hex("plan-material"),
        parent_plan_revision_id: "PLAN-MATERIAL-BASE",
        parent_plan_revision_sha256: basePlanSha256,
        requirement_revision_id: closure.closure.requirement_revision_id,
        requirement_revision_sha256: sha256Hex("requirement-revision"),
        goal_id: closure.closure.goal_id,
        contract_id: closure.closure.contract_id,
        authority_root_id: closure.closure.authority_root_id,
        subjects: successorSubjects,
        edges: successorEdges,
      },
      decision_plan_binding: decisionBinding,
      material_requests: [{
        binding_id: "MATERIAL-BINDING-1",
        binding_sha256: sha256Hex("material-binding-1"),
        change_request_id: "CHANGE-REQUEST-1",
        change_request_sha256: sha256Hex("change-request-1"),
        impact: requestImpact,
      }],
      base_semantic_records: [
        {
          entity_kind: "ACCEPTANCE_FACET",
          semantic_key: "parser",
          entity_id: "FACET-OLD",
          record_sha256: sha256Hex("facet-old"),
        },
        {
          entity_kind: "REQUIREMENT",
          semantic_key: "parser",
          entity_id: requirement.id,
          record_sha256: requirement.revision_sha256,
        },
      ],
      successor_semantic_records: [
        {
          entity_kind: "ACCEPTANCE_FACET",
          semantic_key: "parser",
          entity_id: "FACET-NEW",
          record_sha256: sha256Hex("facet-new"),
        },
        {
          entity_kind: "REQUIREMENT",
          semantic_key: "parser",
          entity_id: successorRequirement.id,
          record_sha256: successorRequirement.revision_sha256,
        },
      ],
      oracle_bindings: [
        { work_cell: successorCellA, oracle_sha256: sha256Hex("oracle-a") },
        { work_cell: workCellB, oracle_sha256: sha256Hex("oracle-b") },
      ],
      event_head_sha256: sha256Hex("change-acceptance-event-head"),
      created_at_ms: 4,
    } as const;
  }

  it("binds material requests, semantic deltas, invalidations, Decisions and frozen oracles", () => {
    const input = acceptanceFixture();
    const result = finalizeChangeAcceptanceClosureV2(input);

    expect(result.closure).toMatchObject({
      base_plan_revision_id: "PLAN-MATERIAL-BASE",
      successor_plan_revision_id: "PLAN-MATERIAL",
      request_count: 1,
      semantic_delta_count: 2,
      invalidation_count: 2,
      oracle_count: 2,
      decision_plan_binding_root_sha256: input.decision_plan_binding.binding.record_sha256,
    });
    expect(result.semantic_deltas.map((entry) => [entry.entity_kind, entry.change_kind]))
      .toEqual([["ACCEPTANCE_FACET", "MODIFY"], ["REQUIREMENT", "MODIFY"]]);
  });

  it("rejects a successor whose frozen oracle set does not cover every WorkCell", () => {
    const input = acceptanceFixture();
    expect(() => finalizeChangeAcceptanceClosureV2({
      ...input,
      oracle_bindings: input.oracle_bindings.slice(0, 1),
    })).toThrow(/complete successor WorkCell set/iu);
  });

  it("rejects a successor that is not the direct child of the material base", () => {
    const input = acceptanceFixture();
    expect(() => finalizeChangeAcceptanceClosureV2({
      ...input,
      successor_plan: { ...input.successor_plan, parent_plan_revision_id: "PLAN-OTHER" },
    })).toThrow(/direct successor Plan/iu);
  });

  it("rejects duplicate material bindings instead of silently collapsing user turns", () => {
    const input = acceptanceFixture();
    expect(() => finalizeChangeAcceptanceClosureV2({
      ...input,
      material_requests: [input.material_requests[0], input.material_requests[0]],
    })).toThrow(/repeats a material request or binding/iu);
  });

  it("rejects request hash aliases even when mutable IDs differ", () => {
    const input = acceptanceFixture();
    const first = input.material_requests[0];
    expect(() => finalizeChangeAcceptanceClosureV2({
      ...input,
      material_requests: [first, {
        ...first,
        binding_id: "MATERIAL-BINDING-ALIAS",
        change_request_id: "CHANGE-REQUEST-ALIAS",
      }],
    })).toThrow(/repeats a material request or binding/iu);
  });

  it("rejects a recomputed closure when a Decision Plan member is forged", () => {
    const input = acceptanceFixture();
    expect(() => finalizeChangeAcceptanceClosureV2({
      ...input,
      decision_plan_binding: {
        ...input.decision_plan_binding,
        members: input.decision_plan_binding.members.map((member, index) => index === 0
          ? { ...member, record_sha256: sha256Hex("forged-decision-plan-member") }
          : member),
      },
    })).toThrow(/not Host-derived/iu);
  });

  it("rejects a material acceptance with no source-bound semantic delta", () => {
    const input = acceptanceFixture();
    const baseSubjects = input.successor_plan.subjects.map((entry) => entry.kind === "WORK_CELL"
      && entry.id === workCellA.id ? workCellA : entry);
    const baseByIdentity = new Map(baseSubjects.map((entry) => [`${entry.kind}\0${entry.id}`, entry]));
    const baseEdges = input.successor_plan.edges.map((edge) => ({
      ...edge,
      source: baseByIdentity.get(`${edge.source.kind}\0${edge.source.id}`)!,
      target: baseByIdentity.get(`${edge.target.kind}\0${edge.target.id}`)!,
    }));
    const impact = derivePlanChangeImpactV2({
      plan_revision_id: input.base_plan.plan_revision_id,
      plan_revision_sha256: input.base_plan.record_sha256,
      changed_subjects: [workCellA],
      subjects: baseSubjects,
      edges: baseEdges,
    });
    expect(() => finalizeChangeAcceptanceClosureV2({
      ...input,
      base_plan: { ...input.base_plan, subjects: baseSubjects, edges: baseEdges },
      material_requests: [{ ...input.material_requests[0], impact }],
      base_semantic_records: input.successor_semantic_records,
    })).toThrow(/source-bound semantic delta/iu);
  });

  it("rejects a semantic ADD that omits an existing base Requirement", () => {
    const input = acceptanceFixture();
    expect(() => finalizeChangeAcceptanceClosureV2({
      ...input,
      base_semantic_records: input.base_semantic_records.filter((record) => record.entity_kind !== "REQUIREMENT"),
    })).toThrow(/Base semantic Requirement closure/iu);
  });

  it("rejects a semantic REMOVE that omits a current successor Requirement", () => {
    const input = acceptanceFixture();
    expect(() => finalizeChangeAcceptanceClosureV2({
      ...input,
      successor_semantic_records: input.successor_semantic_records
        .filter((record) => record.entity_kind !== "REQUIREMENT"),
    })).toThrow(/Successor semantic Requirement closure/iu);
  });

  it("rejects a semantic MODIFY whose previous hash is not the base Plan Requirement", () => {
    const input = acceptanceFixture();
    expect(() => finalizeChangeAcceptanceClosureV2({
      ...input,
      base_semantic_records: input.base_semantic_records.map((record) => record.entity_kind === "REQUIREMENT"
        ? { ...record, record_sha256: sha256Hex("forged-base-requirement") }
        : record),
    })).toThrow(/Base semantic Requirement closure/iu);
  });
});
