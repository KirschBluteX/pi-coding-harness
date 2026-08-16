import { describe, expect, it } from "vitest";
import {
  projectDecisionInboxV2, validateDecisionInboxProjectionV2, type DecisionInboxSourceV2,
} from "../../src/harness/host/decision-inbox.js";

function source(): DecisionInboxSourceV2 {
  return {
    goalId: "GOAL-DECISION-INBOX",
    phase: "WAITING_USER",
    nextAction: "REVIEW_CONTRACT",
    workCellId: null,
    routeHealth: "H0_CONTINUE",
    blocker: null,
    clarifications: [{ id: "DECISION-API", reversible: true, record: { id: "DECISION-API", revision: 1 } }],
    contractReview: {
      decisionRequirementRevisionId: "DECISION-REVIEW-1",
      requirementRevisionSha256: "a".repeat(64),
      decisionFrontierSha256: "b".repeat(64),
      contractDiff: { scope: { before: [], after: ["src"] } },
      requirementDiff: { added: [{ key: "quality" }], changed: [], removed: [] },
    },
    planReview: null,
    execution: null,
    changes: {
      recent: [{
        change_request_id: "CHANGE-1", classification: "CHANGE_REQUEST", materiality: "HIGH",
        changed_subject_count: 1, invalidated_subject_count: 2, reusable_subject_count: 1,
        authority_ref_sha256: "c".repeat(64), created_at_ms: 10,
      }],
      invalidatedWork: [{
        subject_kind: "WORK_CELL", subject_id: "CELL-OLD", revision_sha256: "d".repeat(64),
        authority_ref_sha256: "e".repeat(64),
      }],
      reusedWork: [{
        subject_kind: "WORK_CELL", subject_id: "CELL-KEEP", revision_sha256: "f".repeat(64),
        authority_ref_sha256: "1".repeat(64),
      }],
    },
    acceptance: {
      mustTotal: 4, mustSatisfied: 2, currentReceiptRefs: ["2".repeat(64)],
    },
    provider: {
      requests: 3, inputTokens: 120, outputTokens: 40, cacheReadTokens: 80, costUsd: null,
      budgetState: "UNKNOWN", accountingCompleteness: "PARTIAL",
      scope: "GOAL_BOUND_OBSERVED", receiptRefs: ["3".repeat(64)],
    },
  };
}

describe("Decision Inbox V2 projection", () => {
  it("projects pending user authority without creating a second mutable source", () => {
    const projected = projectDecisionInboxV2(source());
    expect(projected).toMatchObject({
      authority: "DERIVED_READ_ONLY_PROJECTION",
      pending: [
        { kind: "CLARIFICATION", stable_id: "DECISION-API", allowed_actions: ["SELECT", "DEFER"] },
        {
          kind: "CONTRACT_REVIEW", stable_id: "DECISION-REVIEW-1",
          allowed_actions: ["APPROVE", "EDIT", "REJECT"],
        },
      ],
      diffs: { contract_changed_fields: ["scope"], requirement_added: 1 },
      changes: {
        recent: [{ change_request_id: "CHANGE-1", invalidated_subject_count: 2 }],
        invalidated_work: [{ subject_id: "CELL-OLD" }],
        reused_work: [{ subject_id: "CELL-KEEP" }],
      },
      provider: {
        requests: 3, accounting_completeness: "PARTIAL", scope: "GOAL_BOUND_OBSERVED",
      },
    });
    expect(projectDecisionInboxV2(source())).toEqual(projected);
    expect(validateDecisionInboxProjectionV2(projected)).toBe(true);
    expect(validateDecisionInboxProjectionV2({ ...projected, risks: ["forged"] })).toBe(false);
  });

  it("binds projection identity to current authority references", () => {
    const before = projectDecisionInboxV2(source());
    const changed = source();
    const after = projectDecisionInboxV2({
      ...changed,
      contractReview: { ...changed.contractReview!, requirementRevisionSha256: "c".repeat(64) },
    });
    expect(after.pending.find((item) => item.kind === "CONTRACT_REVIEW")?.authority_ref_sha256)
      .not.toBe(before.pending.find((item) => item.kind === "CONTRACT_REVIEW")?.authority_ref_sha256);
    expect(after.projection_sha256).not.toBe(before.projection_sha256);
  });

  it("surfaces classification, recovery and route risk as typed items", () => {
    const value = projectDecisionInboxV2({
      ...source(), contractReview: null, clarifications: [], nextAction: "CLASSIFY_ACTIVE_GOAL_INPUT",
      phase: "RUNNING", routeHealth: "H3_REPLAN", blocker: "stale route",
    });
    expect(value.pending).toHaveLength(1);
    expect(value.pending[0]).toMatchObject({ kind: "ACTIVE_GOAL_INPUT", blocking: true });
    expect(value.risks).toEqual(["ROUTE:H3_REPLAN", "BLOCKER:stale route"]);
  });

  it("summarizes execution evidence without accepting Worker prose", () => {
    const value = projectDecisionInboxV2({
      ...source(), contractReview: null, clarifications: [], phase: "RUNNING", nextAction: "EXECUTE_WORK",
      workCellId: "CELL-1", execution: { status: "RUNNING", ready: 2, active: 1, completed: 3 },
    });
    expect(value.pending).toEqual([]);
    expect(value.evidence).toEqual({
      work_cell_id: "CELL-1", execution_status: "RUNNING", ready_work_count: 2,
      active_work_count: 1, completed_work_count: 3, must_total: 4, must_satisfied: 2,
      current_receipt_refs: ["2".repeat(64)],
    });
  });
});
