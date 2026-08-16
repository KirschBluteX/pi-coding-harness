import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openAuthorityConnection, closeAuthorityConnection, runImmediateTransaction } from "../../src/authority/database.js";
import { AcceptanceDeliveryV2Repository } from "../../src/acceptance-v2/delivery-repository.js";
import { decisionFrontierSha256V2 } from "../../src/intake-v2/finalize.js";
import { canonicalJsonSha256 } from "../../src/authority/canonical-json.js";
import { sha256Hex } from "../../src/foundation/crypto.js";
import { sealTaskFlowRecord, type OperationAttemptRecord, type OperationTransitionRecord, type TaskDecisionEntryRecord, type WorkspaceBaselineRecord } from "../../src/task-flow/domain.js";
import { migrateTaskFlowStore } from "../../src/task-flow/migrate.js";
import { TaskFlowKernel } from "../../src/task-flow/kernel.js";
import {
  createTaskFlowAuthority, taskAcceptanceFacets, taskAdmissionMetadata, taskAuthorization, taskBaseline,
  taskContractProposal, taskFlowMemoryMigrations, taskRoute, finalizeTaskFlowPlan,
  reviewAndFinalizeTaskFlowContract,
} from "../helpers/task-flow.js";
import { createTestAuthority, type TestAuthority } from "../helpers/authority.js";
import { passingGoalFitAssessment } from "../helpers/goal-fit.js";

const authorities: TestAuthority[] = [];
afterEach(() => { for (const authority of authorities.splice(0)) authority.close(); });

function mutation(authority: TestAuthority, goalId: string, version: number, key: string, lease?: ReturnType<TestAuthority["store"]["acquireLease"]>) {
  return { expectedVersion: version, idempotencyKey: key, actor: "RUNTIME" as const, ...(lease ? { lease } : {}) };
}

describe("Task Flow authority", () => {
  it("applies migration 011 after exact predecessor and rejects mutation of immutable rows", () => {
    const authority = createTestAuthority({ memoryMigrations: taskFlowMemoryMigrations });
    authorities.push(authority);
    const connection = openAuthorityConnection({ path: authority.databasePath });
    try {
      const first = migrateTaskFlowStore(connection, resolve("schemas", "sql", "011_task_flow_kernel_v1.sql"), authority.clock.now());
      const second = migrateTaskFlowStore(connection, resolve("schemas", "sql", "011_task_flow_kernel_v1.sql"), authority.clock.now());
      expect(first.applied).toBe(true);
      expect(second).toEqual({ ...first, applied: false });
      expect(connection.prepare("SELECT name FROM schema_migrations WHERE version=11").get()).toEqual({ name: "011_task_flow_kernel_v1.sql" });
      expect(connection.prepare("SELECT count(*) count FROM sqlite_master WHERE type='trigger' AND name='no_update_task_flow_modes_v1'").get()).toEqual({ count: 1 });
    } finally { closeAuthorityConnection(connection); }
  });

  it("stages a Goal Contract draft for USER review before accepting a Route", () => {
    const authority = createTaskFlowAuthority();
    authorities.push(authority);
    const goalId = "GOAL-TASK-FLOW-CONTRACT-REVIEW";
    const sourceText = "Build the reviewed task-flow contract";
    authority.store.transactTaskFlow({
      type: "ADMIT_TASK_FLOW",
      goalId,
      workspace: {
        workspaceId: "WS-TASK-FLOW-CONTRACT-REVIEW",
        workspaceHmac: sha256Hex("task-flow-contract-review-workspace"),
        filesystemKind: "LOCAL_TEST",
        localLockingVerified: true,
      },
      originSessionId: "SESSION-TASK-FLOW-CONTRACT-REVIEW",
      objective: sourceText,
      intent: "BUILD",
      lane: "DIRECT_CELL",
      sourceIntakeSha256: sha256Hex(sourceText),
      sourceText,
      activationSha256: sha256Hex("task-flow-contract-review-activation"),
      ...taskAdmissionMetadata("DIRECT_CELL"),
    }, mutation(authority, goalId, 0, "contract-review:admit"));
    const lease = authority.store.acquireLease(goalId, "SESSION-TASK-FLOW-CONTRACT-REVIEW", 60_000);
    authority.store.transactTaskFlow({
      type: "SUBMIT_GOAL_CONTRACT",
      goalId,
      proposal: taskContractProposal(),
      acceptanceFacets: taskAcceptanceFacets(),
      goalFitAssessment: passingGoalFitAssessment(),
    }, mutation(authority, goalId, 1, "contract-review:draft", lease));

    const view = authority.store.readTaskFlowView(goalId);
    expect(view).toMatchObject({ status: "WAITING_USER", nextActionCode: "REVIEW_CONTRACT" });
    if (!view?.contract) throw new Error("Task Flow contract draft was not persisted");
    const contract = view.contract;
    const intake = authority.store.readTaskFlowIntakeV2(goalId);
    expect(intake?.requirement.items.map((item) => item.kind).sort()).toEqual(["CONSTRAINT", "NON_GOAL", "OUTCOME"]);
    expect(intake?.decisions).toHaveLength(1);
    expect(intake?.decisions[0]).toMatchObject({
      kind: "DRAFT_REVIEW",
      blocking: true,
      latest_resolution_stage: "CONTRACT_FREEZE",
      default_action: "REJECT",
    });
    const draftReviewId = intake?.decisions[0]?.decision_requirement_revision_id;
    if (!draftReviewId) throw new Error("Task Flow contract draft review was not created");
    const reviewCommand = {
      type: "RESOLVE_GOAL_CONTRACT_REVIEW" as const,
      goalId,
      expectedDecisionRequirementRevisionId: draftReviewId,
      expectedRequirementRevisionSha256: intake.requirement.revision.record_sha256,
      expectedDecisionFrontierSha256: decisionFrontierSha256V2(intake.decisions),
      action: "APPROVE" as const,
      selectedValue: true,
    };
    expect(() => authority.store.transactTaskFlow(reviewCommand as never, {
      expectedVersion: 2,
      idempotencyKey: "contract-review:agent-forgery",
      actor: "AGENT",
      lease,
    })).toThrow(/Host-captured USER input authority/u);
    expect(() => authority.store.transactTaskFlowUserInput({
      ...reviewCommand,
      expectedDecisionFrontierSha256: sha256Hex("stale-displayed-frontier"),
    }, {
      expectedVersion: 2,
      idempotencyKey: "contract-review:stale-display",
      lease,
      sessionId: lease.ownerSessionId,
      turnId: "TURN-CONTRACT-REVIEW-STALE",
    })).toThrow(/Decision CAS is stale/u);
    expect(authority.store.readTaskFlowIntakeV2(goalId)?.resolutions).toEqual([]);
    expect(() => authority.store.transactTaskFlow({
      type: "SUBMIT_ROUTE_SKELETON",
      goalId,
      route: taskRoute(contract, authority.clock.now()),
      contract,
      goalFitAssessment: passingGoalFitAssessment(),
    }, mutation(authority, goalId, 2, "contract-review:route-too-early", lease)))
      .toThrow(/SUBMIT_ROUTE planning boundary/u);

    authority.store.transactTaskFlowUserInput(reviewCommand, {
      expectedVersion: 2,
      idempotencyKey: "contract-review:user-approval",
      lease,
      sessionId: lease.ownerSessionId,
      turnId: "TURN-CONTRACT-REVIEW-APPROVAL",
    });
    expect(authority.store.readTaskFlowView(goalId)).toMatchObject({
      status: "CONTRACTING",
      nextActionCode: "FINALIZE_INTAKE",
    });
    expect(authority.store.readTaskFlowIntakeV2(goalId)?.resolutions).toHaveLength(1);
    const intakeBeforeHostileFinalization = authority.store.readTaskFlowView(goalId);
    expect(() => authority.store.transactTaskFlow({
      type: "FINALIZE_GOAL_CONTRACT_INTAKE",
      goalId,
      goalFitAssessment: {
        ...passingGoalFitAssessment(),
        outcome_fidelity: {
          status: "REJECT",
          reason_codes: ["HOSTILE_REPLACEMENT_ASSESSMENT"],
          coverage: "ALL_CURRENT",
        },
      },
    } as never, {
      expectedVersion: 3,
      idempotencyKey: "contract-review:hostile-finalize-intake",
      actor: "RUNTIME",
      lease,
    })).toThrow(/unexpected or missing fields/u);
    expect(authority.store.readTaskFlowView(goalId)).toEqual(intakeBeforeHostileFinalization);
    authority.store.transactTaskFlow({ type: "FINALIZE_GOAL_CONTRACT_INTAKE", goalId }, {
      expectedVersion: 3,
      idempotencyKey: "contract-review:finalize-intake",
      actor: "RUNTIME",
      lease,
    });
    expect(authority.store.readTaskFlowView(goalId)).toMatchObject({
      status: "PLANNING",
      nextActionCode: "SUBMIT_ROUTE",
    });
    expect(authority.store.readTaskFlowIntakeV2(goalId)?.contract_freeze).toMatchObject({
      goal_id: goalId,
      contract_id: contract.contract_id,
    });

    authority.store.transactTaskFlow({
      type: "SUBMIT_ROUTE_SKELETON",
      goalId,
      route: taskRoute(contract, authority.clock.now()),
      contract,
      goalFitAssessment: passingGoalFitAssessment(),
    }, mutation(authority, goalId, 4, "contract-review:route", lease));
    expect(authority.store.readTaskFlowView(goalId)).toMatchObject({
      status: "PLANNING",
      nextActionCode: "FINALIZE_PLAN",
    });
    const planBeforeHostileFinalization = authority.store.readTaskFlowView(goalId);
    expect(() => authority.store.transactTaskFlow({
      type: "FINALIZE_TASK_FLOW_PLAN",
      goalId,
      goalFitAssessment: passingGoalFitAssessment(),
    } as never, {
      expectedVersion: 5,
      idempotencyKey: "contract-review:hostile-finalize-plan",
      actor: "RUNTIME",
      lease,
    })).toThrow(/unexpected or missing fields/u);
    expect(authority.store.readTaskFlowView(goalId)).toEqual(planBeforeHostileFinalization);
    authority.store.transactTaskFlow({ type: "FINALIZE_TASK_FLOW_PLAN", goalId }, {
      expectedVersion: 5,
      idempotencyKey: "contract-review:review-plan",
      actor: "RUNTIME",
      lease,
    });
    expect(authority.store.readTaskFlowView(goalId)).toMatchObject({
      status: "PLANNING",
      nextActionCode: "COMMIT_PLAN_GATE",
    });
    authority.store.transactTaskFlow({ type: "COMMIT_TASK_FLOW_PLAN_GATE", goalId }, {
      expectedVersion: 6,
      idempotencyKey: "contract-review:commit-plan-gate",
      actor: "RUNTIME",
      lease,
    });
    expect(authority.store.readTaskFlowView(goalId)).toMatchObject({
      status: "BUILDING",
      nextActionCode: "AUTHORIZE_WORK",
    });
    expect(authority.store.readTaskFlowPlanV2(goalId)?.revision).toMatchObject({
      goal_id: goalId,
      contract_id: contract.contract_id,
      revision: 1,
    });
    expect(authority.store.readTaskFlowPlanStageGateV2(goalId, "PLAN_ENTRY")).toMatchObject({
      goal_id: goalId,
      gate: "PLAN_ENTRY",
      review_owner: "HOST",
    });
    const connection = openAuthorityConnection({ path: authority.databasePath });
    try {
      const sequence = connection.prepare(`SELECT p.created_event_sequence plan_sequence,
          g.created_event_sequence review_sequence,s.created_event_sequence gate_sequence
        FROM stage_gate_receipts_v2 s
        JOIN plan_revisions_v2 p ON p.plan_revision_id=s.plan_revision_id
        JOIN goal_fit_reviews_v2 g ON g.goal_fit_review_id=s.goal_fit_review_id
        WHERE s.goal_id=? AND s.gate='PLAN_ENTRY'`).get(goalId) as {
          plan_sequence: number;
          review_sequence: number;
          gate_sequence: number;
        } | undefined;
      if (!sequence) throw new Error("Task Flow test lacks its StageGate sequence lineage");
      expect(sequence.gate_sequence).toBeGreaterThan(sequence.plan_sequence);
      expect(sequence.gate_sequence).toBeGreaterThan(sequence.review_sequence);
    } finally { closeAuthorityConnection(connection); }
  });

  it("rolls Plan review and StageGate commit back with their core event envelope", () => {
    const authority = createTaskFlowAuthority();
    authorities.push(authority);
    const goalId = "GOAL-TASK-FLOW-PLAN-GATE-FAULT";
    authority.store.transactTaskFlow({
      type: "ADMIT_TASK_FLOW", goalId,
      workspace: {
        workspaceId: "WS-PLAN-GATE-FAULT", workspaceHmac: sha256Hex("plan-gate-fault-workspace"),
        filesystemKind: "LOCAL_TEST", localLockingVerified: true,
      },
      originSessionId: "SESSION-PLAN-GATE-FAULT", objective: "Prove atomic Plan gate staging",
      intent: "BUILD", lane: "DIRECT_CELL", sourceIntakeSha256: sha256Hex("task-flow-intake"),
      sourceText: "task-flow-intake", activationSha256: sha256Hex("plan-gate-fault-activation"),
      ...taskAdmissionMetadata("DIRECT_CELL"),
    }, mutation(authority, goalId, 0, "plan-gate-fault:admit"));
    const lease = authority.store.acquireLease(goalId, "SESSION-PLAN-GATE-FAULT", 60_000);
    authority.store.transactTaskFlow({
      type: "SUBMIT_GOAL_CONTRACT", goalId,
      proposal: taskContractProposal(), acceptanceFacets: taskAcceptanceFacets(),
      goalFitAssessment: passingGoalFitAssessment(),
    }, mutation(authority, goalId, 1, "plan-gate-fault:contract", lease));
    let version = reviewAndFinalizeTaskFlowContract(authority, goalId, lease, 2, "plan-gate-fault");
    const contract = authority.store.readTaskFlowView(goalId)?.contract;
    if (!contract) throw new Error("Plan gate fault fixture lacks its Contract");
    authority.store.transactTaskFlow({
      type: "SUBMIT_ROUTE_SKELETON", goalId, route: taskRoute(contract, authority.clock.now()), contract,
      goalFitAssessment: passingGoalFitAssessment(),
    }, mutation(authority, goalId, version, "plan-gate-fault:route", lease));
    version += 1;

    const connection = openAuthorityConnection({ path: authority.databasePath });
    try {
      const snapshot = () => ({
        view: authority.store.readTaskFlowView(goalId),
        counts: Object.fromEntries([
          "plan_revisions_v2", "decision_closures_v2", "decision_closure_members_v2",
          "goal_fit_reviews_v2", "stage_gate_receipts_v2", "events", "outbox", "command_receipts",
        ].map((table) => [table, connection.prepare(`SELECT count(*) count FROM ${table} WHERE goal_id=?`).get(goalId)])),
      });
      const faults = [
        "after-domain-write", "after-event-write", "after-projection-write",
        "after-outbox-write", "after-receipt-write", "before-commit",
      ] as const;
      const reviewBaseline = snapshot();
      for (const point of faults) {
        expect(() => authority.store.transactTaskFlow({ type: "FINALIZE_TASK_FLOW_PLAN", goalId },
          mutation(authority, goalId, version, `plan-gate-fault:review:${point}`, lease),
          (current) => { if (current === point) throw new Error(`FAULT:${point}`); }))
          .toThrow(`FAULT:${point}`);
        expect(snapshot()).toEqual(reviewBaseline);
      }
      authority.store.transactTaskFlow({ type: "FINALIZE_TASK_FLOW_PLAN", goalId },
        mutation(authority, goalId, version, "plan-gate-fault:review:commit", lease));
      version += 1;
      expect(authority.store.readTaskFlowView(goalId)).toMatchObject({ nextActionCode: "COMMIT_PLAN_GATE" });

      const gateBaseline = snapshot();
      for (const point of faults) {
        expect(() => authority.store.transactTaskFlow({ type: "COMMIT_TASK_FLOW_PLAN_GATE", goalId },
          mutation(authority, goalId, version, `plan-gate-fault:gate:${point}`, lease),
          (current) => { if (current === point) throw new Error(`FAULT:${point}`); }))
          .toThrow(`FAULT:${point}`);
        expect(snapshot()).toEqual(gateBaseline);
      }
      expect(authority.store.verifyIntegrity()).toMatchObject({ goalCount: 1 });
    } finally { closeAuthorityConnection(connection); }
  });

  it("commits the complete DirectCell authority chain and reuses an idempotent admission", () => {
    const authority = createTaskFlowAuthority();
    authorities.push(authority);
    const goalId = "GOAL-TASK-FLOW-001";
    const sourceIntakeSha256 = sha256Hex("task-flow-intake");
    const admit = {
      type: "ADMIT_TASK_FLOW" as const, goalId,
      workspace: { workspaceId: "WS-TEST-001", workspaceHmac: sha256Hex("test-workspace"), filesystemKind: "LOCAL_TEST", localLockingVerified: true as const },
      originSessionId: "SESSION-TASK-FLOW-001", objective: "Verify src/example.ts",
      intent: "BUILD" as const, lane: "DIRECT_CELL" as const, sourceIntakeSha256,
      sourceText: "task-flow-intake",
      activationSha256: sha256Hex("task-flow-activation"),
      ...taskAdmissionMetadata("DIRECT_CELL"),
    };
    const admitted = authority.store.transactTaskFlow(admit, mutation(authority, goalId, 0, "admit"));
    const reused = authority.store.transactTaskFlow(admit, mutation(authority, goalId, 0, "admit"));
    expect(admitted.goalVersion).toBe(1);
    expect(reused.reused).toBe(true);
    const lease = authority.store.acquireLease(goalId, "SESSION-TASK-FLOW-001", 60_000);
    authority.store.transactTaskFlow({
      type: "SUBMIT_GOAL_CONTRACT", goalId, proposal: taskContractProposal(), acceptanceFacets: taskAcceptanceFacets(),
      goalFitAssessment: passingGoalFitAssessment(),
    }, mutation(authority, goalId, 1, "contract", lease));
    const contract = authority.store.readTaskFlowView(goalId)?.contract;
    if (!contract) throw new Error("Task Flow contract was not frozen");
    const acceptance = authority.store.readTaskFlowAcceptanceV2(contract.contract_id);
    if (!acceptance) throw new Error("Acceptance V2 authority was not frozen");
    expect(acceptance.authority).toMatchObject({
      goal_id: goalId,
      contract_id: contract.contract_id,
      contract_sha256: contract.record_sha256,
      qualification_basis: "NATIVE_EXACT",
      unresolved_material_count: 0,
    });
    expect(acceptance.authority.facet_count).toBe(acceptance.facets.length);
    expect(acceptance.authority.binding_count).toBe(acceptance.bindings.length);
    expect(acceptance.authority.evidence_requirement_count).toBe(acceptance.evidence_requirements.length);
    let version = reviewAndFinalizeTaskFlowContract(authority, goalId, lease, 2, "direct-cell");
    const route = taskRoute(contract, authority.clock.now());
    authority.store.transactTaskFlow({
      type: "SUBMIT_ROUTE_SKELETON", goalId, route, contract,
      goalFitAssessment: passingGoalFitAssessment(),
    }, mutation(authority, goalId, version, "route", lease));
    version += 1;
    const plan = finalizeTaskFlowPlan(authority, goalId, lease, version, "direct-cell");
    version = plan.nextVersion;
    const baseline = taskBaseline(goalId, authority.clock.now());
    authority.store.transactTaskFlow({ type: "RECORD_WORKSPACE_BASELINE", goalId, baseline }, mutation(authority, goalId, version, "baseline", lease));
    version += 1;
    const authorization = taskAuthorization(
      goalId, contract, baseline, lease.generation, lease.fencingToken, authority.clock.now(), plan.decisionClosureSha256,
    );
    authority.store.transactTaskFlow({ type: "AUTHORIZE_WORK_CELL", goalId, authorization }, mutation(authority, goalId, version, "authorize", lease));
    version += 1;

    const attempt = sealTaskFlowRecord<OperationAttemptRecord, "record_sha256">("PCH-OPERATION-ATTEMPT-V1", {
      schema_version: 1 as const, attempt_id: "ATTEMPT-TEST-001", operation_id: "OPERATION-TEST-001", goal_id: goalId,
      work_cell_id: "CELL-TEST-001", authorization_id: authorization.authorization_id, attempt_number: 1,
      operation_kind: "VALIDATION" as const, normalized_target_hmac: sha256Hex("src/example.ts"), normalized_payload_sha256: sha256Hex("payload"),
      execution_fingerprint_sha256: sha256Hex("execution"), baseline_sha256: baseline.record_sha256,
      environment_sha256: baseline.environment_sha256, oracle_sha256: canonicalJsonSha256(route.work_cells[0]!.oracle),
      idempotency_key_hmac: sha256Hex("operation-key"), created_at_ms: authority.clock.now(),
    }, "record_sha256");
    const prepared = sealTaskFlowRecord<OperationTransitionRecord, "transition_sha256">("PCH-OPERATION-TRANSITION-V1", {
      schema_version: 1 as const, transition_id: "TRANSITION-TEST-000", attempt_id: attempt.attempt_id, ordinal: 0,
      state: "PREPARED" as const, output_sha256: null, readback_sha256: null, failure_signature_sha256: null,
      postcondition: "UNKNOWN" as const, predecessor_sha256: null, created_at_ms: authority.clock.now(),
    }, "transition_sha256");
    authority.store.transactTaskFlow({
      type: "PREPARE_OPERATION", goalId, attempt, prepared, reconcileLocator: null,
      oracleExecution: { command: "npm test", policySha256: sha256Hex("task-flow-authority-oracle-policy") },
    }, mutation(authority, goalId, version, "prepare", lease));
    version += 1;
    let predecessor = prepared.transition_sha256;
    let terminalTransitionId = "";
    for (const [ordinal, state] of [[1, "DISPATCHED"], [2, "OBSERVED"], [3, "COMMITTED"]] as const) {
      const transition = sealTaskFlowRecord<OperationTransitionRecord, "transition_sha256">("PCH-OPERATION-TRANSITION-V1", {
        schema_version: 1 as const, transition_id: `TRANSITION-TEST-00${ordinal}`, attempt_id: attempt.attempt_id, ordinal, state,
        output_sha256: state === "COMMITTED" ? sha256Hex("output") : null,
        readback_sha256: state === "OBSERVED" || state === "COMMITTED" ? sha256Hex("readback") : null,
        failure_signature_sha256: null, postcondition: state === "COMMITTED" ? "PASS" as const : "UNKNOWN" as const,
        predecessor_sha256: predecessor, created_at_ms: authority.clock.now(),
      }, "transition_sha256");
      authority.store.transactTaskFlow({ type: "TRANSITION_OPERATION", goalId, transition }, mutation(authority, goalId, version, `transition-${ordinal}`, lease));
      predecessor = transition.transition_sha256;
      if (state === "COMMITTED") terminalTransitionId = transition.transition_id;
      version += 1;
    }
    const baselineBody = Object.fromEntries(
      Object.entries(baseline).filter(([key]) => key !== "record_sha256"),
    ) as Omit<WorkspaceBaselineRecord, "record_sha256">;
    const postimage = sealTaskFlowRecord<WorkspaceBaselineRecord, "record_sha256">("PCH-WORKSPACE-BASELINE-V1", {
      ...baselineBody, baseline_id: "BASELINE-TASK-FLOW-POST-VALIDATION",
      content_root_sha256: sha256Hex("post-validation-content"), created_at_ms: authority.clock.now(),
    }, "record_sha256");
    authority.store.transactTaskFlow({ type: "RECORD_WORKSPACE_BASELINE", goalId, baseline: postimage },
      mutation(authority, goalId, version, "post-validation-baseline", lease));
    version += 1;
    authority.store.transactTaskFlow({
      type: "DERIVE_ACCEPTANCE_EVIDENCE_V2", goalId, attemptId: attempt.attempt_id,
      terminalTransitionId,
    }, mutation(authority, goalId, version, "derive-evidence-v2", lease));
    version += 1;
    authority.store.transactTaskFlow({ type: "COMPLETE_WORK_CELL_V2", goalId, workCellId: "CELL-TEST-001" },
      mutation(authority, goalId, version, "complete-v2", lease));
    version += 1;
    const directDelivery = openAuthorityConnection({ path: authority.databasePath });
    try {
      expect(() => runImmediateTransaction(directDelivery, () => new AcceptanceDeliveryV2Repository(directDelivery)
        .recordDeliverable({ goal_id: goalId }, {
          created_at_ms: authority.clock.now(), created_event_sequence: version + 2,
        }))).toThrow(/next Goal event/u);
      expect(directDelivery.prepare("SELECT count(*) count FROM deliverable_manifests_v2").get()).toEqual({ count: 0 });
    } finally { closeAuthorityConnection(directDelivery); }
    authority.store.transactTaskFlow({ type: "CLOSE_TASK_FLOW_GOAL_V2", goalId },
      mutation(authority, goalId, version, "close-v2", lease));
    version += 1;
    const expectedView = authority.store.readTaskFlowView(goalId);
    expect(expectedView).toMatchObject({ goalId, workCellId: null, unresolvedOperationIds: [] });
    expect(() => authority.store.transactTaskFlow(
      { type: "CLOSE_TASK_FLOW_GOAL_V2", goalId },
      mutation(authority, goalId, version, "close-with-new-identity", lease),
    )).toThrow("Terminal Task Flow Goal cannot accept a new mutation");
    expect(authority.store.verifyTaskFlowIntegrity()).toMatchObject({ available: true, contracts: 1, routes: 1, workCells: 1, operations: 1, evidence: 0, headMismatches: 0 });
    expect(authority.store.verifyIntegrity()).toMatchObject({ goalCount: 1, eventCount: version });

    const tamper = openAuthorityConnection({ path: authority.databasePath });
    try {
      tamper.prepare("UPDATE goal_contract_heads_v1 SET contract_sha256=? WHERE goal_id=?")
        .run(sha256Hex("tampered-head"), goalId);
    } finally { closeAuthorityConnection(tamper); }
    expect(() => authority.store.verifyTaskFlowIntegrity()).toThrow("Task Flow current-view integrity failed");
    expect(new TaskFlowKernel(authority.store, authority.clock).recover(goalId)).toMatchObject({
      view: expectedView,
      exactNextAction: "NONE",
      requiresReconciliation: false,
      additionalModelRequests: 0,
    });
    expect(authority.store.verifyTaskFlowIntegrity()).toMatchObject({ headMismatches: 0, multipleRunningGoals: 0 });
  });

  it("fences ordinary operation work after lease takeover until explicit reconciliation", () => {
    const authority = createTaskFlowAuthority();
    authorities.push(authority);
    const goalId = "GOAL-TASK-FLOW-TAKEOVER";
    authority.store.transactTaskFlow({
      type: "ADMIT_TASK_FLOW", goalId,
      workspace: { workspaceId: "WS-TEST-001", workspaceHmac: sha256Hex("takeover-workspace"), filesystemKind: "LOCAL_TEST", localLockingVerified: true },
      originSessionId: "SESSION-TAKEOVER-A", objective: "Fence a prepared workspace mutation",
      intent: "BUILD", lane: "DIRECT_CELL", sourceIntakeSha256: sha256Hex("takeover-intake"),
      sourceText: "takeover-intake",
      activationSha256: sha256Hex("takeover-activation"),
      ...taskAdmissionMetadata("DIRECT_CELL"),
    }, mutation(authority, goalId, 0, "takeover-admit"));
    const leaseA = authority.store.acquireLease(goalId, "SESSION-TAKEOVER-A", 1_000);
    authority.store.transactTaskFlow({
      type: "SUBMIT_GOAL_CONTRACT", goalId, proposal: taskContractProposal(), acceptanceFacets: taskAcceptanceFacets(),
      goalFitAssessment: passingGoalFitAssessment(),
    }, mutation(authority, goalId, 1, "takeover-contract", leaseA));
    const contract = authority.store.readTaskFlowView(goalId)?.contract;
    if (!contract) throw new Error("Takeover contract was not frozen");
    let version = reviewAndFinalizeTaskFlowContract(authority, goalId, leaseA, 2, "takeover");
    const route = taskRoute(contract, authority.clock.now());
    authority.store.transactTaskFlow({
      type: "SUBMIT_ROUTE_SKELETON", goalId, route, contract,
      goalFitAssessment: passingGoalFitAssessment(),
    }, mutation(authority, goalId, version, "takeover-route", leaseA));
    version += 1;
    const plan = finalizeTaskFlowPlan(authority, goalId, leaseA, version, "takeover");
    version = plan.nextVersion;
    const baseline = taskBaseline(goalId, authority.clock.now());
    authority.store.transactTaskFlow({ type: "RECORD_WORKSPACE_BASELINE", goalId, baseline }, mutation(authority, goalId, version, "takeover-baseline", leaseA));
    version += 1;
    const authorization = taskAuthorization(
      goalId, contract, baseline, leaseA.generation, leaseA.fencingToken, authority.clock.now(), plan.decisionClosureSha256,
    );
    authority.store.transactTaskFlow({ type: "AUTHORIZE_WORK_CELL", goalId, authorization }, mutation(authority, goalId, version, "takeover-authorize", leaseA));
    version += 1;
    const attempt = sealTaskFlowRecord<OperationAttemptRecord, "record_sha256">("PCH-OPERATION-ATTEMPT-V1", {
      schema_version: 1, attempt_id: "ATTEMPT-TAKEOVER-001", operation_id: "OPERATION-TAKEOVER-001", goal_id: goalId,
      work_cell_id: authorization.work_cell_id, authorization_id: authorization.authorization_id, attempt_number: 1,
      operation_kind: "WRITE", normalized_target_hmac: sha256Hex("takeover-target"), normalized_payload_sha256: sha256Hex("takeover-payload"),
      execution_fingerprint_sha256: sha256Hex("takeover-execution"), baseline_sha256: baseline.record_sha256,
      environment_sha256: baseline.environment_sha256, oracle_sha256: baseline.oracle_set_sha256,
      idempotency_key_hmac: sha256Hex("takeover-key"), created_at_ms: authority.clock.now(),
    }, "record_sha256");
    const prepared = sealTaskFlowRecord<OperationTransitionRecord, "transition_sha256">("PCH-OPERATION-TRANSITION-V1", {
      schema_version: 1, transition_id: "TRANSITION-TAKEOVER-000", attempt_id: attempt.attempt_id, ordinal: 0,
      state: "PREPARED", output_sha256: null, readback_sha256: null, failure_signature_sha256: null,
      postcondition: "UNKNOWN", predecessor_sha256: null, created_at_ms: authority.clock.now(),
    }, "transition_sha256");
    authority.store.transactTaskFlow({ type: "PREPARE_OPERATION", goalId, attempt, prepared, reconcileLocator: null, oracleExecution: null },
      mutation(authority, goalId, version, "takeover-prepare", leaseA));
    version += 1;

    authority.clock.advance(1_001);
    const leaseB = authority.store.acquireLease(goalId, "SESSION-TAKEOVER-B", 60_000);
    const replacementAttempt = sealTaskFlowRecord<OperationAttemptRecord, "record_sha256">("PCH-OPERATION-ATTEMPT-V1", {
      schema_version: 1, attempt_id: "ATTEMPT-TAKEOVER-002", operation_id: "OPERATION-TAKEOVER-002", goal_id: goalId,
      work_cell_id: authorization.work_cell_id, authorization_id: authorization.authorization_id, attempt_number: 1,
      operation_kind: "WRITE", normalized_target_hmac: sha256Hex("replacement-target"), normalized_payload_sha256: sha256Hex("replacement-payload"),
      execution_fingerprint_sha256: sha256Hex("replacement-execution"), baseline_sha256: baseline.record_sha256,
      environment_sha256: baseline.environment_sha256, oracle_sha256: baseline.oracle_set_sha256,
      idempotency_key_hmac: sha256Hex("replacement-key"), created_at_ms: authority.clock.now(),
    }, "record_sha256");
    const replacementPrepared = sealTaskFlowRecord<OperationTransitionRecord, "transition_sha256">("PCH-OPERATION-TRANSITION-V1", {
      schema_version: 1, transition_id: "TRANSITION-TAKEOVER-REPLACEMENT", attempt_id: replacementAttempt.attempt_id, ordinal: 0,
      state: "PREPARED", output_sha256: null, readback_sha256: null, failure_signature_sha256: null,
      postcondition: "UNKNOWN", predecessor_sha256: null, created_at_ms: authority.clock.now(),
    }, "transition_sha256");
    expect(() => authority.store.transactTaskFlow({
      type: "PREPARE_OPERATION", goalId, attempt: replacementAttempt, prepared: replacementPrepared, reconcileLocator: null,
      oracleExecution: null,
    }, mutation(authority, goalId, version, "takeover-prepare-as-b", leaseB))).toThrow(/authorization.*fenc/iu);
    const dispatched = sealTaskFlowRecord<OperationTransitionRecord, "transition_sha256">("PCH-OPERATION-TRANSITION-V1", {
      schema_version: 1, transition_id: "TRANSITION-TAKEOVER-001", attempt_id: attempt.attempt_id, ordinal: 1,
      state: "DISPATCHED", output_sha256: null, readback_sha256: null, failure_signature_sha256: null,
      postcondition: "UNKNOWN", predecessor_sha256: prepared.transition_sha256, created_at_ms: authority.clock.now(),
    }, "transition_sha256");
    expect(() => authority.store.transactTaskFlow({ type: "TRANSITION_OPERATION", goalId, transition: dispatched },
      mutation(authority, goalId, version, "takeover-dispatch-as-b", leaseB))).toThrow(/authorization.*fenc/iu);
    expect(authority.store.readTaskFlowGoalVersion(goalId)).toBe(version);
    expect(authority.store.readTaskFlowOperation(goalId, attempt.operation_id)).toMatchObject({ state: "PREPARED", ordinal: 0 });
    expect(authority.store.verifyIntegrity()).toMatchObject({ goalCount: 1, eventCount: version });
  });

  it("rolls back domain, event, outbox and receipt together at every transaction fault boundary", () => {
    const authority = createTaskFlowAuthority();
    authorities.push(authority);
    const goalId = "GOAL-TASK-FLOW-FAULT";
    authority.store.transactTaskFlow({
      type: "ADMIT_TASK_FLOW", goalId,
      workspace: { workspaceId: "WS-TEST-001", workspaceHmac: sha256Hex("test-workspace"), filesystemKind: "LOCAL_TEST", localLockingVerified: true },
      originSessionId: "SESSION-TASK-FLOW-FAULT", objective: "Implement one verified file",
      intent: "BUILD", lane: "DIRECT_CELL", sourceIntakeSha256: sha256Hex("task-flow-intake"),
      sourceText: "task-flow-intake",
      activationSha256: sha256Hex("fault-activation"),
      ...taskAdmissionMetadata("DIRECT_CELL"),
    }, mutation(authority, goalId, 0, "admit-fault"));
    const lease = authority.store.acquireLease(goalId, "SESSION-TASK-FLOW-FAULT", 60_000);
    const assertNoFrozenAuthority = () => {
      const inspection = openAuthorityConnection({ path: authority.databasePath });
      try {
        for (const table of [
          "goal_contract_versions_v1", "task_obligations_v1", "goal_contract_heads_v1",
          "acceptance_source_revisions_v2", "acceptance_source_spans_v2", "acceptance_facets_v2",
          "acceptance_obligations_v2", "facet_obligation_bindings_v2", "evidence_requirements_v2",
          "acceptance_authority_roots_v2",
        ]) {
          expect(inspection.prepare(`SELECT count(*) count FROM ${table} WHERE goal_id=?`).get(goalId), table)
            .toEqual({ count: 0 });
        }
      } finally { closeAuthorityConnection(inspection); }
      expect(authority.store.readTaskFlowView(goalId)?.contract).toBeNull();
      expect(authority.store.verifyIntegrity()).toMatchObject({ goalCount: 1, eventCount: 1 });
    };
    const invalidFacets = taskAcceptanceFacets().map((facet, index) => index === 0
      ? { ...facet, obligation_keys: ["missing-obligation"] } : facet);
    expect(() => authority.store.transactTaskFlow(
      {
        type: "SUBMIT_GOAL_CONTRACT", goalId, proposal: taskContractProposal(), acceptanceFacets: invalidFacets,
        goalFitAssessment: passingGoalFitAssessment(),
      },
      mutation(authority, goalId, 1, "invalid-acceptance-mapping", lease),
    )).toThrow(/unknown obligation/iu);
    assertNoFrozenAuthority();
    for (const point of ["after-domain-write", "after-event-write", "after-outbox-write", "after-receipt-write", "before-commit"] as const) {
      expect(() => authority.store.transactTaskFlow(
        {
          type: "SUBMIT_GOAL_CONTRACT", goalId, proposal: taskContractProposal(), acceptanceFacets: taskAcceptanceFacets(),
          goalFitAssessment: passingGoalFitAssessment(),
        },
        mutation(authority, goalId, 1, `fault-${point}`, lease),
        (current) => { if (current === point) throw new Error(`FAULT:${point}`); },
      )).toThrow(`FAULT:${point}`);
      assertNoFrozenAuthority();
    }
  });

  it("persists the PLAN build decision before authorizing execution", () => {
    const authority = createTaskFlowAuthority();
    authorities.push(authority);
    const goalId = "GOAL-TASK-FLOW-PLAN";
    authority.store.transactTaskFlow({
      type: "ADMIT_TASK_FLOW", goalId,
      workspace: { workspaceId: "WS-TEST-001", workspaceHmac: sha256Hex("test-workspace"), filesystemKind: "LOCAL_TEST", localLockingVerified: true },
      originSessionId: "SESSION-TASK-FLOW-PLAN", objective: "Plan one verified file",
      intent: "PLAN", lane: "DIRECT_CELL", sourceIntakeSha256: sha256Hex("task-flow-intake"),
      sourceText: "task-flow-intake",
      activationSha256: sha256Hex("plan-activation"),
      ...taskAdmissionMetadata("DIRECT_CELL"),
    }, mutation(authority, goalId, 0, "admit-plan"));
    const lease = authority.store.acquireLease(goalId, "SESSION-TASK-FLOW-PLAN", 60_000);
    authority.store.transactTaskFlow({
      type: "SUBMIT_GOAL_CONTRACT", goalId, proposal: taskContractProposal(), acceptanceFacets: taskAcceptanceFacets(),
      goalFitAssessment: passingGoalFitAssessment(),
    }, mutation(authority, goalId, 1, "plan-contract", lease));
    const contract = authority.store.readTaskFlowView(goalId)?.contract;
    if (!contract) throw new Error("PLAN contract was not frozen");
    let version = reviewAndFinalizeTaskFlowContract(authority, goalId, lease, 2, "plan-only");
    const route = taskRoute(contract, authority.clock.now());
    authority.store.transactTaskFlow({
      type: "SUBMIT_ROUTE_SKELETON", goalId, route, contract,
      goalFitAssessment: passingGoalFitAssessment(),
    }, mutation(authority, goalId, version, "plan-route", lease));
    version += 1;
    version = finalizeTaskFlowPlan(authority, goalId, lease, version, "plan-only").nextVersion;
    expect(authority.store.readTaskFlowView(goalId)).toMatchObject({ status: "WAITING_USER", nextActionCode: "PLAN_CONTINUATION" });
    const bindingSha256 = sha256Hex(`${contract.record_sha256}:${route.record_sha256}`);
    const decision = sealTaskFlowRecord<TaskDecisionEntryRecord, "record_sha256">("PCH-TASK-DECISION-V1", {
      schema_version: 1 as const, decision_entry_id: "DECISION-PLAN-001", goal_id: goalId,
      contract_id: contract.contract_id, route_id: route.route_id, decision_key: "PLAN_CONTINUATION",
      authority_actor: "USER" as const, materiality: "HIGH" as const, reversible: true, privacy_related: false,
      question_hmac: sha256Hex("question"), recommendation: { recommended: "BUILD" }, selection: { choice: "BUILD" },
      state: "RESOLVED" as const, binding_sha256: bindingSha256, created_at_ms: authority.clock.now(), expires_at_ms: null,
    }, "record_sha256");
    authority.store.transactTaskFlow({ type: "RESOLVE_PLAN_CONTINUATION", goalId, choice: "BUILD", decision },
      mutation(authority, goalId, version, "plan-build-choice", lease));
    expect(authority.store.readTaskFlowView(goalId)).toMatchObject({ status: "BUILDING", nextActionCode: "AUTHORIZE_WORK" });
  });
});
