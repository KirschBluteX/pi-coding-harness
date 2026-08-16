import { afterEach, describe, expect, it } from "vitest";
import { AcceptanceAuthorityV2Repository } from "../../src/acceptance-v2/repository.js";
import { AuthorityTransactionKernel } from "../../src/authority/authority-transaction-kernel.js";
import {
  closeAuthorityConnection,
  openAuthorityConnection,
  type AuthorityConnection,
} from "../../src/authority/database.js";
import { sha256Hex } from "../../src/foundation/crypto.js";
import type { AcceptanceBundleV2 } from "../../src/acceptance-v2/domain.js";
import { IntakeAuthorityV2Repository } from "../../src/intake-v2/repository.js";
import {
  decisionActionPayloadSha256V2,
  decisionFrontierSha256V2,
  userDecisionAuthorityInputSourceV2,
} from "../../src/intake-v2/finalize.js";
import { PlanAuthorityV2Repository, planAuthorityZeroSha256 } from "../../src/plan-v2/repository.js";
import {
  sealTaskFlowRecord,
  type RouteSkeletonRecord,
  type WorkCellRecord,
} from "../../src/task-flow/domain.js";
import {
  changeRequestPayloadSha256V2,
  changedSubjectRootSha256V2,
  userChangeRequestAuthoritySourceV2,
} from "../../src/plan-v2/change-request.js";
import { finalizeRoute } from "../../src/task-flow/finalize.js";
import { TestClock, type TestAuthority } from "../helpers/authority.js";
import {
  createTaskFlowAuthority,
  taskAcceptanceFacets,
  taskAdmissionMetadata,
  taskContractProposal,
  taskRoute,
  reviewAndFinalizeTaskFlowContract,
} from "../helpers/task-flow.js";
import { passingGoalFitAssessment, passingMaterialChangeGoalFitAssessment } from "../helpers/goal-fit.js";

interface Fixture {
  readonly authority: TestAuthority;
  connection: AuthorityConnection;
  readonly goalId: string;
  readonly acceptance: AcceptanceBundleV2;
  readonly lease: ReturnType<TestAuthority["store"]["acquireLease"]>;
}

const fixtures: Fixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    closeAuthorityConnection(fixture.connection);
    fixture.authority.close();
  }
});

function eventHead(input: Fixture): { readonly sequence: number; readonly sha256: string } {
  const row = input.connection.prepare(`SELECT sequence,event_sha256 FROM events
    WHERE goal_id=? ORDER BY sequence DESC LIMIT 1`).get(input.goalId) as Record<string, unknown> | undefined;
  if (!row || !Number.isSafeInteger(Number(row.sequence)) || typeof row.event_sha256 !== "string") {
    throw new Error("Plan V2 fixture lacks a core event head");
  }
  return { sequence: Number(row.sequence), sha256: row.event_sha256 };
}

function authorityCommand<T>(
  input: Fixture,
  commandKey: string,
  nowMs: number,
  mutate: (context: {
    readonly sequence: number;
    readonly event_head_sha256: string;
    readonly now_ms: number;
  }) => T,
  eventPayload?: Readonly<Record<string, string>>,
): T {
  const predecessor = eventHead(input);
  let value: T | undefined;
  new AuthorityTransactionKernel(input.connection, new TestClock(nowMs)).execute({
    goalId: input.goalId,
    commandSha256: sha256Hex(`plan-v2-command:${commandKey}`),
    meta: {
      expectedVersion: predecessor.sequence,
      idempotencyKey: `plan-v2:${input.goalId}:${commandKey}`,
      actor: "RUNTIME",
    },
  }, {
    mutate: ({ sequence, nowMs: transactionNowMs }) => {
      value = mutate({
        sequence,
        event_head_sha256: predecessor.sha256,
        now_ms: transactionNowMs,
      });
      return value;
    },
    event: () => ({
      eventType: "DECISION_RESOLVED",
      payload: eventPayload ?? { planV2CommandSha256: sha256Hex(commandKey) },
    }),
  });
  if (value === undefined) throw new Error("Plan V2 authority command did not execute");
  return value;
}

function fixture(maxAttempts = 2): Fixture {
  const authority = createTaskFlowAuthority();
  const goalId = `GOAL-PLAN-V2-${fixtures.length + 1}`;
  authority.store.transactTaskFlow({
    type: "ADMIT_TASK_FLOW",
    goalId,
    workspace: {
      workspaceId: `WS-${goalId}`,
      workspaceHmac: sha256Hex(`workspace:${goalId}`),
      filesystemKind: "LOCAL_TEST",
      localLockingVerified: true,
    },
    originSessionId: `SESSION-${goalId}`,
    objective: "Build one verified local result",
    intent: "BUILD",
    lane: "DIRECT_CELL",
    sourceIntakeSha256: sha256Hex("task-flow-intake"),
    sourceText: "task-flow-intake",
    activationSha256: sha256Hex(`activation:${goalId}`),
    ...taskAdmissionMetadata("DIRECT_CELL"),
  }, { expectedVersion: 0, idempotencyKey: `admit:${goalId}`, actor: "RUNTIME" });
  const lease = authority.store.acquireLease(goalId, `SESSION-${goalId}`, 60_000);
  authority.store.transactTaskFlow({
    type: "SUBMIT_GOAL_CONTRACT",
    goalId,
    proposal: taskContractProposal(),
    acceptanceFacets: taskAcceptanceFacets(),
    goalFitAssessment: passingGoalFitAssessment(),
  }, { expectedVersion: 1, idempotencyKey: `contract:${goalId}`, actor: "RUNTIME", lease });
  const contract = authority.store.readTaskFlowView(goalId)?.contract;
  if (!contract) throw new Error("Plan V2 fixture lacks a GoalContract");
  reviewAndFinalizeTaskFlowContract(authority, goalId, lease, 2, `plan-v2:${goalId}`);
  const routeSeed = taskRoute(contract, authority.clock.now());
  const routeCell = routeSeed.work_cells[0]!;
  const { spec_sha256: priorCellSha256, ...cellBody } = routeCell;
  void priorCellSha256;
  const cell = sealTaskFlowRecord<WorkCellRecord, "spec_sha256">("PCH-WORK-CELL-V1", {
    ...cellBody,
    budget: { ...routeCell.budget, max_attempts: maxAttempts },
  }, "spec_sha256");
  const { record_sha256: priorRouteSha256, ...routeBody } = routeSeed;
  void priorRouteSha256;
  const route = sealTaskFlowRecord<RouteSkeletonRecord, "record_sha256">("PCH-ROUTE-SKELETON-V1", {
    ...routeBody,
    work_cells: [cell],
  }, "record_sha256");
  authority.store.transactTaskFlow({
    type: "SUBMIT_ROUTE_SKELETON",
    goalId,
    route,
    contract,
    goalFitAssessment: passingGoalFitAssessment(),
  }, {
    expectedVersion: 4,
    idempotencyKey: `route:${goalId}`,
    actor: "RUNTIME",
    lease,
  });

  const connection = openAuthorityConnection({ path: authority.databasePath });
  const acceptance = new AcceptanceAuthorityV2Repository(connection).readBundle(contract.contract_id);
  if (!acceptance) throw new Error("Plan V2 fixture lacks Acceptance authority");
  const result = { authority, connection, goalId, acceptance, lease };
  fixtures.push(result);
  return result;
}

function freezePlan(
  input: Fixture,
  commandKey: string,
  expectedPredecessor = planAuthorityZeroSha256,
  nowMs = 106,
) {
  return authorityCommand(input, commandKey, nowMs, ({ sequence, now_ms: transactionNowMs }) =>
    new PlanAuthorityV2Repository(input.connection).freezeCurrentPlan({
      goal_id: input.goalId,
      expected_predecessor_plan_sha256: expectedPredecessor,
      created_at_ms: transactionNowMs,
    }, sequence));
}

function captureMaterialActiveGoalChange(
  input: Fixture,
  plan: ReturnType<typeof freezePlan>,
  subjectIndex: number,
  key: string,
  changedSubjects: readonly typeof plan.subjects[number][] = [plan.subjects[subjectIndex]!],
) {
  const subject = plan.subjects[subjectIndex];
  if (!subject) throw new Error("Plan V2 fixture lacks a material change subject");
  const turn = authorityCommand(input, `capture-${key}`, 130 + subjectIndex, ({
    sequence, event_head_sha256: eventHeadSha256, now_ms: nowMs,
  }) => new PlanAuthorityV2Repository(input.connection).captureActiveGoalUserTurn({
    closure: {
      goal_id: input.goalId,
      goal_version: sequence - 1,
      contract_sha256: null,
      route_sha256: plan.revision.route_sha256,
      plan_revision_id: plan.revision.plan_revision_id,
      plan_revision_sha256: plan.revision.record_sha256,
      stage_gate_sha256: null,
      execution_authorization_sha256: null,
    },
    source: `Material active Goal change ${key}`,
    session_id: `SESSION-${key}`,
    turn_id: `TURN-${key}`,
    event_head_sha256: eventHeadSha256,
    created_at_ms: nowMs,
  }, sequence));
  return authorityCommand(input, `classify-${key}`, 140 + subjectIndex, ({
    sequence, event_head_sha256: eventHeadSha256, now_ms: nowMs,
  }) => {
    const repository = new PlanAuthorityV2Repository(input.connection);
    const classification = repository.classifyActiveGoalUserTurn({
      user_turn_id: turn.turn.user_turn_id,
      expected_user_turn_sha256: turn.turn.record_sha256,
      classification: "CHANGE_REQUEST",
      materiality: "HIGH",
      change_kind: "SCOPE",
      changed_subjects: changedSubjects,
      event_head_sha256: eventHeadSha256,
      created_at_ms: nowMs,
    }, sequence);
    return repository.captureActiveGoalChangeRequest(classification.classification_id, sequence);
  });
}

function capturePendingActiveGoalUserTurn(
  input: Fixture,
  plan: ReturnType<typeof freezePlan>,
  key: string,
) {
  return authorityCommand(input, `capture-pending-${key}`, 153, ({
    sequence, event_head_sha256: eventHeadSha256, now_ms: nowMs,
  }) => new PlanAuthorityV2Repository(input.connection).captureActiveGoalUserTurn({
    closure: {
      goal_id: input.goalId,
      goal_version: sequence - 1,
      contract_sha256: null,
      route_sha256: plan.revision.route_sha256,
      plan_revision_id: plan.revision.plan_revision_id,
      plan_revision_sha256: plan.revision.record_sha256,
      stage_gate_sha256: null,
      execution_authorization_sha256: null,
    },
    source: `Pending active Goal change ${key}`,
    session_id: `SESSION-PENDING-${key}`,
    turn_id: `TURN-PENDING-${key}`,
    event_head_sha256: eventHeadSha256,
    created_at_ms: nowMs,
  }, sequence));
}

function prepareMaterialChangeSuccessor(input: Fixture) {
  const base = freezePlan(input, "freeze-before-active-goal-change-batch");
  const first = captureMaterialActiveGoalChange(input, base, 0, "FIRST", base.subjects);
  const second = captureMaterialActiveGoalChange(input, base, 1, "SECOND");
  const priorView = input.authority.store.readTaskFlowView(input.goalId);
  if (!priorView?.route) throw new Error("Plan V2 fixture lacks its current Route");
  input.authority.store.transactTaskFlow({
    type: "OPEN_GOAL_CONTRACT_REVISION",
    goalId: input.goalId,
    revisionKind: "SCOPE",
    reasonSha256: sha256Hex("bind-active-goal-change-batch"),
  }, {
    expectedVersion: input.authority.store.readTaskFlowGoalVersion(input.goalId),
    idempotencyKey: `plan-v2:${input.goalId}:open-successor-contract`,
    actor: "RUNTIME",
    lease: input.lease,
  });
  input.authority.store.transactTaskFlow({
    type: "SUBMIT_GOAL_CONTRACT",
    goalId: input.goalId,
    proposal: { ...taskContractProposal(), scope: ["src/example.ts", "src/adjacent.ts"] },
    acceptanceFacets: taskAcceptanceFacets(),
    goalFitAssessment: passingGoalFitAssessment(),
  }, {
    expectedVersion: input.authority.store.readTaskFlowGoalVersion(input.goalId),
    idempotencyKey: `plan-v2:${input.goalId}:successor-contract`,
    actor: "RUNTIME",
    lease: input.lease,
  });
  reviewAndFinalizeTaskFlowContract(
    input.authority,
    input.goalId,
    input.lease,
    input.authority.store.readTaskFlowGoalVersion(input.goalId),
    `plan-v2:${input.goalId}:successor-contract`,
  );
  const view = input.authority.store.readTaskFlowView(input.goalId);
  if (!view?.contract) throw new Error("Plan V2 fixture lacks its revised Contract");
  const successorRoute = finalizeRoute({
    contract: view.contract,
    revision: priorView.route.revision + 1,
    parentRouteId: priorView.route.route_id,
    proposal: {
      outcomes: ["Bind all captured material changes"],
      work_cells: [{
        key: "active-goal-change-successor",
        outcome: "The shared successor covers both captured changes",
        obligation_keys: ["verified-output"],
        dependencies: [],
        read_roots: ["src"],
        write_roots: ["src/example.ts"],
        effect_classes: ["LOCAL_REVERSIBLE"],
        oracle: { command: "npm test" },
        risk: "LOW",
        reversible: true,
        budget: { max_attempts: 2 },
      }],
      near_horizon: ["active-goal-change-successor"],
    },
    createdAtMs: 150,
  });
  input.authority.store.transactTaskFlow({
    type: "SUBMIT_ROUTE_SKELETON",
    goalId: input.goalId,
    route: successorRoute,
    contract: view.contract,
    goalFitAssessment: passingGoalFitAssessment(),
  }, {
    expectedVersion: input.authority.store.readTaskFlowGoalVersion(input.goalId),
    idempotencyKey: `plan-v2:${input.goalId}:successor-route`,
    actor: "RUNTIME",
    lease: input.lease,
  });
  const successor = freezePlan(
    input,
    "freeze-active-goal-change-successor",
    base.revision.record_sha256,
    151,
  );
  const closure = authorityCommand(input, "active-goal-change-successor-closure", 152, ({
    sequence, now_ms: nowMs,
  }) => new IntakeAuthorityV2Repository(input.connection).recordDecisionClosure(
    successor.revision.requirement_revision_id, "MATERIAL_CHANGE", nowMs, sequence,
  ));
  return { base, first, second, successor, closure };
}

const changeAcceptanceTables = [
  "decision_plan_bindings_v2",
  "decision_plan_binding_members_v2",
  "decision_plan_binding_targets_v2",
  "change_invalidation_closures_v2",
  "change_invalidation_members_v2",
  "change_reuse_members_v2",
  "change_acceptance_request_members_v2",
  "change_acceptance_semantic_deltas_v2",
  "change_acceptance_oracle_bindings_v2",
  "change_acceptance_closures_v2",
] as const;

function changeAcceptanceCounts(connection: AuthorityConnection): Readonly<Record<string, number>> {
  return Object.fromEntries(changeAcceptanceTables.map((table) => {
    const row = connection.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { readonly count: number };
    return [table, row.count];
  }));
}

function expectNoChangeAcceptanceRows(connection: AuthorityConnection): void {
  expect(changeAcceptanceCounts(connection)).toEqual(Object.fromEntries(
    changeAcceptanceTables.map((table) => [table, 0]),
  ));
}

describe("Plan V2 authority repository", () => {
  it("derives and freezes the complete current graph without caller-supplied roots", () => {
    const input = fixture();
    const frozen = freezePlan(input, "freeze-initial");

    expect(frozen.revision).toMatchObject({
      goal_id: input.goalId,
      revision: 1,
      parent_plan_revision_id: null,
      requirement_count: 3,
      work_cell_count: 1,
    });
    expect(frozen.subjects.map((subject) => subject.kind)).toEqual([
      "WORK_CELL",
      "DECISION",
      "REQUIREMENT",
      "REQUIREMENT",
      "REQUIREMENT",
    ]);
    expect(frozen.edges).toHaveLength(6);
    expect(input.connection.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

    closeAuthorityConnection(input.connection);
    input.connection = openAuthorityConnection({ path: input.authority.databasePath });
    const rebuilt = new PlanAuthorityV2Repository(input.connection).readCurrentPlan(input.goalId);
    expect(rebuilt).toEqual(frozen);
  });

  it("is idempotent after commit and rejects a stale unrelated predecessor", () => {
    const input = fixture();
    const first = freezePlan(input, "freeze-idempotent-first");
    const retried = freezePlan(input, "freeze-idempotent-retry", planAuthorityZeroSha256, 999);
    expect(retried).toEqual(first);
    expect(input.connection.prepare("SELECT count(*) count FROM plan_revisions_v2").get()).toEqual({ count: 1 });
    expect(() => freezePlan(input, "freeze-stale", sha256Hex("unrelated-plan-head"), 1_000))
      .toThrow(/expected-head CAS mismatch/u);
  });

  it("rolls back the complete Plan projection with its outer transaction", () => {
    const input = fixture();
    expect(() => authorityCommand(input, "freeze-outer-fault", 106, ({ sequence, now_ms: nowMs }) => {
      new PlanAuthorityV2Repository(input.connection).freezeCurrentPlan({
        goal_id: input.goalId,
        expected_predecessor_plan_sha256: planAuthorityZeroSha256,
        created_at_ms: nowMs,
      }, sequence);
      throw new Error("fault:outer-plan-transaction");
    })).toThrow("fault:outer-plan-transaction");
    expect(input.connection.prepare("SELECT count(*) count FROM plan_revisions_v2").get()).toEqual({ count: 0 });
    expect(input.connection.prepare("SELECT count(*) count FROM plan_subjects_v2").get()).toEqual({ count: 0 });
    expect(input.connection.prepare("SELECT count(*) count FROM plan_dependency_edges_v2").get()).toEqual({ count: 0 });
    expect(input.connection.prepare("SELECT count(*) count FROM plan_heads_v2").get()).toEqual({ count: 0 });
  });

  it("uses a method SAVEPOINT when a graph member insert fails and the caller catches it", () => {
    const input = fixture();
    input.connection.exec(`CREATE TEMP TRIGGER fault_second_plan_subject
      BEFORE INSERT ON plan_subjects_v2
      WHEN (SELECT count(*) FROM plan_subjects_v2)=1
      BEGIN SELECT RAISE(ABORT,'fault:second-plan-subject'); END`);
    authorityCommand(input, "freeze-member-fault", 106, ({ sequence, now_ms: nowMs }) => {
      expect(() => new PlanAuthorityV2Repository(input.connection).freezeCurrentPlan({
        goal_id: input.goalId,
        expected_predecessor_plan_sha256: planAuthorityZeroSha256,
        created_at_ms: nowMs,
      }, sequence)).toThrow("fault:second-plan-subject");
      return "caught";
    });
    expect(input.connection.prepare("SELECT count(*) count FROM plan_revisions_v2").get()).toEqual({ count: 0 });
    expect(input.connection.prepare("SELECT count(*) count FROM plan_subjects_v2").get()).toEqual({ count: 0 });
    expect(input.connection.prepare("SELECT count(*) count FROM plan_dependency_edges_v2").get()).toEqual({ count: 0 });
    expect(input.connection.prepare("SELECT count(*) count FROM plan_heads_v2").get()).toEqual({ count: 0 });
    input.connection.exec("DROP TRIGGER fault_second_plan_subject");
  });

  it("rejects a tampered dependency when rebuilding after restart", () => {
    const input = fixture();
    freezePlan(input, "freeze-before-tamper");
    input.connection.exec("DROP TRIGGER no_update_plan_dependency_edges_v2");
    input.connection.prepare(`UPDATE plan_dependency_edges_v2 SET record_sha256=?
      WHERE edge_id=(SELECT edge_id FROM plan_dependency_edges_v2 ORDER BY ordinal LIMIT 1)`)
      .run(sha256Hex("tampered-plan-edge"));
    closeAuthorityConnection(input.connection);
    input.connection = openAuthorityConnection({ path: input.authority.databasePath });
    expect(() => new PlanAuthorityV2Repository(input.connection).readCurrentPlan(input.goalId))
      .toThrow(/dependency identity is invalid/u);
  });

  it("rejects a missing mutable Plan head when immutable revisions still exist", () => {
    const input = fixture();
    freezePlan(input, "freeze-before-head-loss");
    input.connection.prepare("DELETE FROM plan_heads_v2 WHERE goal_id=?").run(input.goalId);
    expect(() => new PlanAuthorityV2Repository(input.connection).verifyIntegrity())
      .toThrow(/head is not the latest immutable revision/u);
  });

  it("opens PLAN_ENTRY only from a fresh matching Goal Fit review", () => {
    const input = fixture();
    const plan = freezePlan(input, "freeze-before-plan-entry");
    expect(() => authorityCommand(input, "premature-plan-entry", 107, ({ sequence, event_head_sha256: eventHead, now_ms: nowMs }) =>
      new PlanAuthorityV2Repository(input.connection).recordCurrentStageGate({
        goal_id: input.goalId,
        plan_revision_id: plan.revision.plan_revision_id,
        plan_revision_sha256: plan.revision.record_sha256,
        gate: "PLAN_ENTRY",
        decision_closure_id: "DECISION_CLOSURE_MISSING",
        decision_closure_sha256: sha256Hex("missing-decision-closure"),
        goal_fit_review_id: "GOAL_FIT_REVIEW_MISSING",
        goal_fit_review_sha256: sha256Hex("missing-goal-fit-review"),
        change_acceptance_closure_id: null,
        change_acceptance_closure_sha256: null,
        event_head_sha256: eventHead,
        created_at_ms: nowMs,
      }, sequence))).toThrow(/Goal Fit review/u);

    const closure = authorityCommand(input, "plan-entry-closure", 108, ({ sequence, now_ms: nowMs }) =>
      new IntakeAuthorityV2Repository(input.connection).recordDecisionClosure(
        plan.revision.requirement_revision_id, "PLAN_ENTRY", nowMs, sequence,
      ));
    const goalFit = authorityCommand(input, "plan-entry-goal-fit", 109, ({ sequence, now_ms: nowMs }) =>
      new IntakeAuthorityV2Repository(input.connection).recordGoalFitReview({
        requirement_revision_id: plan.revision.requirement_revision_id,
        decision_closure_id: closure.closure.decision_closure_id,
        gate_subject: {
          kind: "PLAN_REVISION",
          id: plan.revision.plan_revision_id,
          record_sha256: plan.revision.record_sha256,
        },
        assessment: passingGoalFitAssessment(),
        created_at_ms: nowMs,
      }, sequence));
    const gate = authorityCommand(input, "plan-entry-gate", 110, ({ sequence, event_head_sha256: eventHead, now_ms: nowMs }) =>
      new PlanAuthorityV2Repository(input.connection).recordCurrentStageGate({
        goal_id: input.goalId,
        plan_revision_id: plan.revision.plan_revision_id,
        plan_revision_sha256: plan.revision.record_sha256,
        gate: "PLAN_ENTRY",
        decision_closure_id: closure.closure.decision_closure_id,
        decision_closure_sha256: closure.closure.record_sha256,
        goal_fit_review_id: goalFit.review.goal_fit_review_id,
        goal_fit_review_sha256: goalFit.review.record_sha256,
        change_acceptance_closure_id: null,
        change_acceptance_closure_sha256: null,
        event_head_sha256: eventHead,
        created_at_ms: nowMs,
      }, sequence));
    expect(gate).toMatchObject({
      plan_revision_id: plan.revision.plan_revision_id,
      plan_revision_sha256: plan.revision.record_sha256,
      gate: "PLAN_ENTRY",
      review_owner: "HOST",
    });
    expect(new PlanAuthorityV2Repository(input.connection).readStageGate(gate.stage_gate_receipt_id)).toEqual(gate);
    const lineage = input.connection.prepare(`SELECT p.created_event_sequence plan_sequence,
        g.created_event_sequence review_sequence
      FROM stage_gate_receipts_v2 s
      JOIN plan_revisions_v2 p ON p.plan_revision_id=s.plan_revision_id
      JOIN goal_fit_reviews_v2 g ON g.goal_fit_review_id=s.goal_fit_review_id
      WHERE s.stage_gate_receipt_id=?`).get(gate.stage_gate_receipt_id) as {
        plan_sequence: number;
        review_sequence: number;
      } | undefined;
    if (!lineage) throw new Error("Plan V2 fixture lacks StageGate lineage");
    input.connection.exec("DROP TRIGGER no_update_stage_gate_receipts_v2");
    input.connection.prepare("UPDATE stage_gate_receipts_v2 SET created_event_sequence=? WHERE stage_gate_receipt_id=?")
      .run(Math.max(lineage.plan_sequence, lineage.review_sequence), gate.stage_gate_receipt_id);
    expect(() => new PlanAuthorityV2Repository(input.connection).verifyIntegrity())
      .toThrow(/does not follow its current Plan and Goal Fit review/u);
  });

  it("captures an exact structured Change Request and derives localized invalidation plus bounded reuse", () => {
    const input = fixture();
    const plan = freezePlan(input, "freeze-before-change-request");
    const changed = plan.subjects.find((subject) => subject.kind === "REQUIREMENT")!;
    const requestPayload = { request: "Change only this requirement", reason: "User value changed" };
    const projection = authorityCommand(input, "capture-change-request", 111, ({
      sequence, event_head_sha256: eventHeadSha256, now_ms: nowMs,
    }) => {
      const source = userChangeRequestAuthoritySourceV2({
        plan_revision_id: plan.revision.plan_revision_id,
        plan_revision_sha256: plan.revision.record_sha256,
        classification: "CHANGE_REQUEST",
        materiality: "HIGH",
        request_payload_sha256: changeRequestPayloadSha256V2(requestPayload),
        changed_subject_root_sha256: changedSubjectRootSha256V2([changed]),
        session_id: "SESSION-CHANGE-REQUEST",
        turn_id: "TURN-CHANGE-REQUEST",
        event_head_sha256: eventHeadSha256,
      });
      return new PlanAuthorityV2Repository(input.connection).captureUserChangeRequest({
        goal_id: input.goalId,
        classification: "CHANGE_REQUEST",
        materiality: "HIGH",
        request_payload: requestPayload,
        changed_subjects: [changed],
        source,
        session_id: "SESSION-CHANGE-REQUEST",
        turn_id: "TURN-CHANGE-REQUEST",
        event_head_sha256: eventHeadSha256,
        created_at_ms: nowMs,
      }, sequence);
    });

    expect(projection.request).toMatchObject({
      goal_id: input.goalId,
      base_plan_revision_id: plan.revision.plan_revision_id,
      classification: "CHANGE_REQUEST",
      materiality: "HIGH",
      source_kind: "USER_TURN",
    });
    expect(projection.impact.changed_subjects).toEqual([changed]);
    expect(projection.impact.invalidated_subjects.map((subject) => subject.kind)).toEqual([
      "WORK_CELL",
      "REQUIREMENT",
    ]);
    expect(projection.reuse_receipts).toHaveLength(plan.subjects.length - 2);
    expect(projection.reuse_receipts.every((receipt) => receipt.reuse_scope === "PLAN_SUBJECT_ONLY"
      && receipt.requires_fresh_effect_oracle)).toBe(true);
    expect(input.connection.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

    closeAuthorityConnection(input.connection);
    input.connection = openAuthorityConnection({ path: input.authority.databasePath });
    expect(new PlanAuthorityV2Repository(input.connection).readChangeRequest(projection.request.change_request_id))
      .toEqual(projection);

    input.connection.exec("DROP TRIGGER no_update_plan_change_impact_members_v2");
    input.connection.prepare(`UPDATE plan_change_impact_members_v2 SET ordinal=4000
      WHERE change_request_id=? AND disposition='CHANGED' AND ordinal=0`)
      .run(projection.request.change_request_id);
    expect(() => new PlanAuthorityV2Repository(input.connection)
      .readChangeRequest(projection.request.change_request_id)).toThrow(/member closure is invalid/u);
    input.connection.prepare(`UPDATE plan_change_impact_members_v2 SET ordinal=0
      WHERE change_request_id=? AND disposition='CHANGED' AND ordinal=4000`)
      .run(projection.request.change_request_id);

    const edge = input.connection.prepare(`SELECT dependency_kind FROM plan_invalidation_edges_v2
      WHERE change_request_id=? ORDER BY ordinal LIMIT 1`).get(projection.request.change_request_id) as
      { readonly dependency_kind?: unknown } | undefined;
    if (!edge || typeof edge.dependency_kind !== "string") throw new Error("Plan V2 fixture lacks an invalidation edge");
    const replacementDependency = edge.dependency_kind === "REQUIRES" ? "SATISFIES" : "REQUIRES";
    input.connection.exec("DROP TRIGGER no_update_plan_invalidation_edges_v2");
    input.connection.prepare(`UPDATE plan_invalidation_edges_v2 SET dependency_kind=?
      WHERE change_request_id=? AND ordinal=0`).run(replacementDependency, projection.request.change_request_id);
    expect(() => new PlanAuthorityV2Repository(input.connection)
      .readChangeRequest(projection.request.change_request_id)).toThrow(/invalidation edge V2 is invalid/u);
    input.connection.prepare(`UPDATE plan_invalidation_edges_v2 SET dependency_kind=?
      WHERE change_request_id=? AND ordinal=0`).run(edge.dependency_kind, projection.request.change_request_id);

    input.connection.exec("DROP TRIGGER no_update_plan_change_impacts_v2");
    input.connection.prepare("UPDATE plan_change_impacts_v2 SET record_sha256=? WHERE change_request_id=?")
      .run(projection.impact.impact_closure_sha256, projection.request.change_request_id);
    expect(() => new PlanAuthorityV2Repository(input.connection)
      .readChangeRequest(projection.request.change_request_id)).toThrow(/not bound to its Change Request/u);
  });

  it("rejects lexical or mismatched Change Request text without appending authority", () => {
    const input = fixture();
    const plan = freezePlan(input, "freeze-before-rejected-change-request");
    const changed = plan.subjects.find((subject) => subject.kind === "REQUIREMENT")!;
    expect(() => authorityCommand(input, "reject-change-request-text", 111, ({
      sequence, event_head_sha256: eventHeadSha256, now_ms: nowMs,
    }) => new PlanAuthorityV2Repository(input.connection).captureUserChangeRequest({
      goal_id: input.goalId,
      classification: "CHANGE_REQUEST",
      materiality: "HIGH",
      request_payload: { request: "Change only this requirement" },
      changed_subjects: [changed],
      source: "Please change everything instead.",
      session_id: "SESSION-CHANGE-REQUEST",
      turn_id: "TURN-CHANGE-REQUEST",
      event_head_sha256: eventHeadSha256,
      created_at_ms: nowMs,
    }, sequence))).toThrow(/structured Change Request envelope/u);
    expect(input.connection.prepare("SELECT count(*) count FROM change_requests_v2").get()).toEqual({ count: 0 });
  });

  it("persists durable correction budgets and stops repeated repair attempts from Host event evidence", () => {
    const input = fixture();
    freezePlan(input, "freeze-before-correction-budget");
    const repository = new PlanAuthorityV2Repository(input.connection);
    expect(repository.readCorrectionBudgets(input.goalId).map((budget) => budget.family)).toEqual([
      "ASK_USER",
      "HANDOFF",
      "LOCAL_REPAIR",
      "PROVIDER_FANOUT",
      "RECONCILE",
      "REPLAN",
      "WORKER_RETRY",
    ]);

    const observationPayload = { failure_signature: "same-host-observation" };
    authorityCommand(input, "repair-observation-1", 120, () => true, observationPayload);
    const first = authorityCommand(input, "repair-attempt-1", 121, ({ sequence, now_ms: nowMs }) =>
      new PlanAuthorityV2Repository(input.connection).recordCorrectionAttempt({
        goal_id: input.goalId,
        family: "LOCAL_REPAIR",
        result: "FAILED",
        created_at_ms: nowMs,
      }, sequence));
    expect(first).toMatchObject({
      attempt_number: 1,
      progress_changed: true,
      no_progress_streak: 0,
      stop_action: "CONTINUE",
    });

    authorityCommand(input, "repair-observation-2", 122, () => true, observationPayload);
    const second = authorityCommand(input, "repair-attempt-2", 123, ({ sequence, now_ms: nowMs }) =>
      new PlanAuthorityV2Repository(input.connection).recordCorrectionAttempt({
        goal_id: input.goalId,
        family: "LOCAL_REPAIR",
        result: "FAILED",
        created_at_ms: nowMs,
      }, sequence));
    expect(second).toMatchObject({
      attempt_number: 2,
      progress_changed: false,
      no_progress_streak: 1,
      stop_action: "REPLAN",
      stop_reason: "ATTEMPT_BUDGET_EXHAUSTED",
    });

    authorityCommand(input, "repair-observation-3", 124, () => true, observationPayload);
    expect(() => authorityCommand(input, "repair-attempt-3", 125, ({ sequence, now_ms: nowMs }) =>
      new PlanAuthorityV2Repository(input.connection).recordCorrectionAttempt({
        goal_id: input.goalId,
        family: "LOCAL_REPAIR",
        result: "FAILED",
        created_at_ms: nowMs,
      }, sequence))).toThrow(/budget is already stopped/u);

    closeAuthorityConnection(input.connection);
    input.connection = openAuthorityConnection({ path: input.authority.databasePath });
    expect(new PlanAuthorityV2Repository(input.connection).readCorrectionAttempt(second.correction_attempt_id))
      .toEqual(second);
  });

  it("derives WorkCell correction ceilings from the largest configured attempt budget", () => {
    const input = fixture(5);
    freezePlan(input, "freeze-before-configured-correction-budget");
    const budgets = new Map(new PlanAuthorityV2Repository(input.connection).readCorrectionBudgets(input.goalId)
      .map((budget) => [budget.family, budget]));
    expect(budgets.get("LOCAL_REPAIR")?.maximum_attempts).toBe(5);
    expect(budgets.get("WORKER_RETRY")?.maximum_attempts).toBe(5);
  });

  it("rolls back the complete Change Acceptance closure with its outer transaction", () => {
    const input = fixture();
    const { closure } = prepareMaterialChangeSuccessor(input);
    const predecessor = eventHead(input);
    input.connection.exec("BEGIN IMMEDIATE");
    try {
      new PlanAuthorityV2Repository(input.connection).recordChangeAcceptance({
        goal_id: input.goalId,
        decision_closure_id: closure.closure.decision_closure_id,
        event_head_sha256: predecessor.sha256,
        created_at_ms: 154,
      }, predecessor.sequence + 1);
      expect(changeAcceptanceCounts(input.connection)).toMatchObject({
        decision_plan_bindings_v2: 1,
        change_invalidation_closures_v2: 1,
        change_acceptance_request_members_v2: 2,
        change_acceptance_closures_v2: 1,
      });
    } finally {
      input.connection.exec("ROLLBACK");
    }
    expectNoChangeAcceptanceRows(input.connection);
  });

  it("rolls back every Change Acceptance member when a later request member faults", () => {
    const input = fixture();
    const { closure } = prepareMaterialChangeSuccessor(input);
    input.connection.exec(`CREATE TEMP TRIGGER fault_second_change_acceptance_request
      BEFORE INSERT ON change_acceptance_request_members_v2 WHEN NEW.ordinal=1
      BEGIN SELECT RAISE(ABORT,'faulted second Change Acceptance request'); END`);
    const counts = authorityCommand(input, "fault-change-acceptance-member", 154, ({
      sequence, event_head_sha256: eventHeadSha256, now_ms: nowMs,
    }) => {
      expect(() => new PlanAuthorityV2Repository(input.connection).recordChangeAcceptance({
        goal_id: input.goalId,
        decision_closure_id: closure.closure.decision_closure_id,
        event_head_sha256: eventHeadSha256,
        created_at_ms: nowMs,
      }, sequence)).toThrow(/faulted second Change Acceptance request/u);
      const result = changeAcceptanceCounts(input.connection);
      input.connection.exec("DROP TRIGGER fault_second_change_acceptance_request");
      return result;
    });
    expect(counts).toEqual(Object.fromEntries(changeAcceptanceTables.map((table) => [table, 0])));
    expectNoChangeAcceptanceRows(input.connection);
  });

  it.each(["UNCLASSIFIED", "MISSING_MATERIAL_BINDING"] as const)(
    "rejects a %s active Goal turn before Change Acceptance",
    (failure) => {
      const input = fixture();
      const { base, closure } = prepareMaterialChangeSuccessor(input);
      const turn = capturePendingActiveGoalUserTurn(input, base, failure);
      if (failure === "MISSING_MATERIAL_BINDING") {
        authorityCommand(input, "classify-without-material-binding", 154, ({
          sequence, event_head_sha256: eventHeadSha256, now_ms: nowMs,
        }) => new PlanAuthorityV2Repository(input.connection).classifyActiveGoalUserTurn({
          user_turn_id: turn.turn.user_turn_id,
          expected_user_turn_sha256: turn.turn.record_sha256,
          classification: "CHANGE_REQUEST",
          materiality: "HIGH",
          change_kind: "SCOPE",
          changed_subjects: [base.subjects[0]!],
          event_head_sha256: eventHeadSha256,
          created_at_ms: nowMs,
        }, sequence));
      }
      expect(() => authorityCommand(input, `reject-${failure}`, 155, ({
        sequence, event_head_sha256: eventHeadSha256, now_ms: nowMs,
      }) => new PlanAuthorityV2Repository(input.connection).recordChangeAcceptance({
        goal_id: input.goalId,
        decision_closure_id: closure.closure.decision_closure_id,
        event_head_sha256: eventHeadSha256,
        created_at_ms: nowMs,
      }, sequence))).toThrow(failure === "UNCLASSIFIED" ? /unclassified captured turn/u : /without its exact binding/u);
      expectNoChangeAcceptanceRows(input.connection);
    },
  );

  it("rejects a stale event head before Change Acceptance writes", () => {
    const input = fixture();
    const { closure } = prepareMaterialChangeSuccessor(input);
    expect(() => authorityCommand(input, "stale-change-acceptance-head", 154, ({ sequence, now_ms: nowMs }) =>
      new PlanAuthorityV2Repository(input.connection).recordChangeAcceptance({
        goal_id: input.goalId,
        decision_closure_id: closure.closure.decision_closure_id,
        event_head_sha256: sha256Hex("stale-change-acceptance-head"),
        created_at_ms: nowMs,
      }, sequence))).toThrow(/current core event head/u);
    expectNoChangeAcceptanceRows(input.connection);
  });

  it("binds every material turn captured against one base Plan to its direct successor", () => {
    const input = fixture();
    const { first, second, successor, closure } = prepareMaterialChangeSuccessor(input);
    const acceptance = authorityCommand(input, "active-goal-change-successor-acceptance", 154, ({
      sequence, event_head_sha256: eventHeadSha256, now_ms: nowMs,
    }) => new PlanAuthorityV2Repository(input.connection).recordChangeAcceptance({
      goal_id: input.goalId,
      decision_closure_id: closure.closure.decision_closure_id,
      event_head_sha256: eventHeadSha256,
      created_at_ms: nowMs,
    }, sequence));
    const goalFit = authorityCommand(input, "active-goal-change-successor-fit", 155, ({ sequence, now_ms: nowMs }) =>
      new IntakeAuthorityV2Repository(input.connection).recordGoalFitReview({
        requirement_revision_id: successor.revision.requirement_revision_id,
        decision_closure_id: closure.closure.decision_closure_id,
        gate_subject: {
          kind: "CHANGE_ACCEPTANCE_CLOSURE",
          id: acceptance.closure.change_acceptance_closure_id,
          record_sha256: acceptance.closure.record_sha256,
        },
        assessment: passingMaterialChangeGoalFitAssessment(),
        created_at_ms: nowMs,
      }, sequence));

    const transitions = authorityCommand(input, "bind-active-goal-change-successor", 156, ({
      sequence, event_head_sha256: eventHeadSha256, now_ms: nowMs,
    }) => {
      const repository = new PlanAuthorityV2Repository(input.connection);
      const gate = repository.recordCurrentStageGate({
        goal_id: input.goalId,
        plan_revision_id: successor.revision.plan_revision_id,
        plan_revision_sha256: successor.revision.record_sha256,
        gate: "MATERIAL_CHANGE",
        decision_closure_id: closure.closure.decision_closure_id,
        decision_closure_sha256: closure.closure.record_sha256,
        goal_fit_review_id: goalFit.review.goal_fit_review_id,
        goal_fit_review_sha256: goalFit.review.record_sha256,
        change_acceptance_closure_id: acceptance.closure.change_acceptance_closure_id,
        change_acceptance_closure_sha256: acceptance.closure.record_sha256,
        event_head_sha256: eventHeadSha256,
        created_at_ms: nowMs,
      }, sequence);
      return repository.recordActiveGoalChangeTransitions({
        goal_id: input.goalId,
        successor_stage_gate: gate,
      }, sequence);
    });

    expect(transitions.map((transition) => transition.binding_id)).toEqual([
      first.binding.binding_id,
      second.binding.binding_id,
    ]);
    expect(transitions.every((transition) => transition.successor_plan_revision_id
      === successor.revision.plan_revision_id)).toBe(true);
    expect(new Set(transitions.map((transition) => transition.successor_stage_gate_receipt_id)).size).toBe(1);
    const intake = new IntakeAuthorityV2Repository(input.connection);
    const decisions = intake.readDecisionRequirements(successor.revision.requirement_revision_id);
    const decision = decisions[0];
    if (!decision) throw new Error("Plan V2 fixture lacks its material Decision");
    const laterResolution = authorityCommand(input, "post-closure-resolution", 157, ({
      sequence, event_head_sha256: eventHeadSha256, now_ms: nowMs,
    }) => {
      const selectedValue = { approved: true, reaffirmed: true };
      const source = userDecisionAuthorityInputSourceV2({
        requirement_revision_sha256: successor.revision.requirement_revision_sha256,
        decision_requirement_revision_id: decision.decision_requirement_revision_id,
        decision_frontier_sha256: decisionFrontierSha256V2(decisions),
        action: "APPROVE",
        action_payload_sha256: decisionActionPayloadSha256V2({
          decision,
          action: "APPROVE",
          selected_value: selectedValue,
          edited_requirement_revision_id: null,
          deferred_trigger_sha256: null,
        }),
        at_gate: "MATERIAL_CHANGE",
        session_id: "SESSION-POST-CLOSURE",
        turn_id: "TURN-POST-CLOSURE",
        event_head_sha256: eventHeadSha256,
      });
      return intake.captureUserDecisionAction({
        decision_requirement_revision_id: decision.decision_requirement_revision_id,
        action: "APPROVE",
        at_gate: "MATERIAL_CHANGE",
        selected_value: selectedValue,
        edited_requirement_revision_id: null,
        deferred_trigger_sha256: null,
        authority_source_span_id: decision.source_span_ids[0] ?? null,
        source,
        session_id: "SESSION-POST-CLOSURE",
        turn_id: "TURN-POST-CLOSURE",
        event_head_sha256: eventHeadSha256,
        created_at_ms: nowMs,
      }, sequence);
    });
    expect(closure.members.map((member) => member.decision_resolution_id)).not.toContain(
      laterResolution.decision_resolution_id,
    );
    const repository = new PlanAuthorityV2Repository(input.connection);
    expect(repository.verifyIntegrity()).toMatchObject({
      activeGoalChangeTransitions: 2,
      decisionPlanBindings: 1,
      changeAcceptances: 1,
      headMismatches: 0,
    });
    expect(repository.readChangeAcceptance(acceptance.closure.change_acceptance_closure_id)).toEqual(acceptance);

    closeAuthorityConnection(input.connection);
    input.connection = openAuthorityConnection({ path: input.authority.databasePath });
    const restarted = new PlanAuthorityV2Repository(input.connection);
    expect(restarted.readChangeAcceptance(acceptance.closure.change_acceptance_closure_id)).toEqual(acceptance);
    expect(restarted.verifyIntegrity()).toMatchObject({ decisionPlanBindings: 1, changeAcceptances: 1 });

    input.connection.exec("DROP TRIGGER no_update_change_acceptance_closures_v2");
    input.connection.prepare(`UPDATE change_acceptance_closures_v2 SET oracle_evidence_root_sha256=?
      WHERE change_acceptance_closure_id=?`).run(
      sha256Hex("hostile-change-acceptance-oracle-root"),
      acceptance.closure.change_acceptance_closure_id,
    );
    expect(() => restarted.readChangeAcceptance(acceptance.closure.change_acceptance_closure_id))
      .toThrow(/Stored Change Acceptance|oracle/iu);
    expect(() => new IntakeAuthorityV2Repository(input.connection)
      .readAssessedGoalFitReview(goalFit.review.goal_fit_review_id))
      .toThrow(/Change Acceptance|Host-derived|Goal Fit/iu);
  });
});
