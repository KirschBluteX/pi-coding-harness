import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openAuthorityConnection, closeAuthorityConnection } from "../../src/authority/database.js";
import { sha256Hex } from "../../src/foundation/crypto.js";
import { sealTaskFlowRecord, type DeliverableManifestRecord, type EvidenceAttestationRecord, type OperationAttemptRecord, type OperationTransitionRecord, type TaskDecisionEntryRecord } from "../../src/task-flow/domain.js";
import { migrateTaskFlowStore } from "../../src/task-flow/migrate.js";
import { TaskFlowKernel } from "../../src/task-flow/kernel.js";
import { createTaskFlowAuthority, taskAdmissionMetadata, taskAuthorization, taskBaseline, taskContract, taskFlowMemoryMigrations, taskRoute } from "../helpers/task-flow.js";
import { createTestAuthority, type TestAuthority } from "../helpers/authority.js";

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

  it("commits the complete DirectCell authority chain and reuses an idempotent admission", () => {
    const authority = createTaskFlowAuthority();
    authorities.push(authority);
    const goalId = "GOAL-TASK-FLOW-001";
    const sourceIntakeSha256 = sha256Hex("task-flow-intake");
    const admit = {
      type: "ADMIT_TASK_FLOW" as const, goalId,
      workspace: { workspaceId: "WS-TEST-001", workspaceHmac: sha256Hex("test-workspace"), filesystemKind: "LOCAL_TEST", localLockingVerified: true as const },
      originSessionId: "SESSION-TASK-FLOW-001", objective: "Implement and verify src/example.ts",
      intent: "BUILD" as const, lane: "DIRECT_CELL" as const, sourceIntakeSha256,
      activationSha256: sha256Hex("task-flow-activation"),
      ...taskAdmissionMetadata("DIRECT_CELL"),
    };
    const admitted = authority.store.transactTaskFlow(admit, mutation(authority, goalId, 0, "admit"));
    const reused = authority.store.transactTaskFlow(admit, mutation(authority, goalId, 0, "admit"));
    expect(admitted.goalVersion).toBe(1);
    expect(reused.reused).toBe(true);
    const lease = authority.store.acquireLease(goalId, "SESSION-TASK-FLOW-001", 60_000);
    const contract = taskContract(goalId, authority.clock.now());
    authority.store.transactTaskFlow({ type: "SUBMIT_GOAL_CONTRACT", goalId, contract }, mutation(authority, goalId, 1, "contract", lease));
    const route = taskRoute(contract, authority.clock.now());
    authority.store.transactTaskFlow({ type: "SUBMIT_ROUTE_SKELETON", goalId, route, contract }, mutation(authority, goalId, 2, "route", lease));
    const baseline = taskBaseline(goalId, authority.clock.now());
    authority.store.transactTaskFlow({ type: "RECORD_WORKSPACE_BASELINE", goalId, baseline }, mutation(authority, goalId, 3, "baseline", lease));
    const authorization = taskAuthorization(goalId, contract, baseline, lease.generation, lease.fencingToken, authority.clock.now());
    authority.store.transactTaskFlow({ type: "AUTHORIZE_WORK_CELL", goalId, authorization }, mutation(authority, goalId, 4, "authorize", lease));

    const attempt = sealTaskFlowRecord<OperationAttemptRecord, "record_sha256">("PCH-OPERATION-ATTEMPT-V1", {
      schema_version: 1 as const, attempt_id: "ATTEMPT-TEST-001", operation_id: "OPERATION-TEST-001", goal_id: goalId,
      work_cell_id: "CELL-TEST-001", authorization_id: authorization.authorization_id, attempt_number: 1,
      operation_kind: "WRITE" as const, normalized_target_hmac: sha256Hex("src/example.ts"), normalized_payload_sha256: sha256Hex("payload"),
      execution_fingerprint_sha256: sha256Hex("execution"), baseline_sha256: baseline.record_sha256,
      environment_sha256: baseline.environment_sha256, oracle_sha256: baseline.oracle_set_sha256,
      idempotency_key_hmac: sha256Hex("operation-key"), created_at_ms: authority.clock.now(),
    }, "record_sha256");
    const prepared = sealTaskFlowRecord<OperationTransitionRecord, "transition_sha256">("PCH-OPERATION-TRANSITION-V1", {
      schema_version: 1 as const, transition_id: "TRANSITION-TEST-000", attempt_id: attempt.attempt_id, ordinal: 0,
      state: "PREPARED" as const, output_sha256: null, readback_sha256: null, failure_signature_sha256: null,
      postcondition: "UNKNOWN" as const, predecessor_sha256: null, created_at_ms: authority.clock.now(),
    }, "transition_sha256");
    authority.store.transactTaskFlow({ type: "PREPARE_OPERATION", goalId, attempt, prepared, reconcileLocator: null }, mutation(authority, goalId, 5, "prepare", lease));
    let predecessor = prepared.transition_sha256;
    let version = 6;
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
      version += 1;
    }
    const attestation = sealTaskFlowRecord<EvidenceAttestationRecord, "record_sha256">("PCH-EVIDENCE-ATTESTATION-V1", {
      schema_version: 1 as const, attestation_id: "ATTESTATION-TEST-001", goal_id: goalId, work_cell_id: "CELL-TEST-001",
      operation_id: attempt.operation_id, obligation_id: "OBLIGATION-TEST-001", oracle_sha256: baseline.oracle_set_sha256,
      input_closure_sha256: attempt.execution_fingerprint_sha256, output_sha256: sha256Hex("output"),
      baseline_sha256: baseline.record_sha256, environment_sha256: baseline.environment_sha256,
      result: "PASS" as const, freshness: "CURRENT" as const, postcondition: "PASS" as const, artifact_id: null,
      created_at_ms: authority.clock.now(),
    }, "record_sha256");
    authority.store.transactTaskFlow({ type: "ATTEST_EVIDENCE", goalId, attestation }, mutation(authority, goalId, 9, "attest", lease));
    authority.store.transactTaskFlow({ type: "COMPLETE_WORK_CELL", goalId, workCellId: "CELL-TEST-001", completionSummarySha256: sha256Hex("complete") }, mutation(authority, goalId, 10, "complete", lease));
    const deliverable = sealTaskFlowRecord<DeliverableManifestRecord, "record_sha256">("PCH-DELIVERABLE-MANIFEST-V1", {
      schema_version: 1 as const, deliverable_id: "DELIVERABLE-TEST-001", goal_id: goalId,
      contract_id: contract.contract_id, route_id: route.route_id, final_baseline_id: baseline.baseline_id,
      obligation_closure_sha256: sha256Hex("obligation-closure"), evidence_root_sha256: attestation.record_sha256,
      artifacts: [], result: "SUCCEEDED" as const, created_at_ms: authority.clock.now(),
    }, "record_sha256");
    authority.store.transactTaskFlow({ type: "CLOSE_TASK_FLOW_GOAL", goalId, deliverable }, mutation(authority, goalId, 11, "close", lease));
    const expectedView = authority.store.readTaskFlowView(goalId);
    expect(expectedView).toMatchObject({ goalId, workCellId: null, unresolvedOperationIds: [] });
    expect(() => authority.store.transactTaskFlow(
      { type: "CLOSE_TASK_FLOW_GOAL", goalId, deliverable },
      mutation(authority, goalId, 12, "close-with-new-identity", lease),
    )).toThrow("Terminal Task Flow Goal cannot accept a new mutation");
    expect(authority.store.verifyTaskFlowIntegrity()).toMatchObject({ available: true, contracts: 1, routes: 1, workCells: 1, operations: 1, evidence: 1, headMismatches: 0 });
    expect(authority.store.verifyIntegrity()).toMatchObject({ goalCount: 1, eventCount: 12 });

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
      activationSha256: sha256Hex("takeover-activation"),
      ...taskAdmissionMetadata("DIRECT_CELL"),
    }, mutation(authority, goalId, 0, "takeover-admit"));
    const leaseA = authority.store.acquireLease(goalId, "SESSION-TAKEOVER-A", 1_000);
    const contract = taskContract(goalId, authority.clock.now());
    authority.store.transactTaskFlow({ type: "SUBMIT_GOAL_CONTRACT", goalId, contract }, mutation(authority, goalId, 1, "takeover-contract", leaseA));
    const route = taskRoute(contract, authority.clock.now());
    authority.store.transactTaskFlow({ type: "SUBMIT_ROUTE_SKELETON", goalId, route, contract }, mutation(authority, goalId, 2, "takeover-route", leaseA));
    const baseline = taskBaseline(goalId, authority.clock.now());
    authority.store.transactTaskFlow({ type: "RECORD_WORKSPACE_BASELINE", goalId, baseline }, mutation(authority, goalId, 3, "takeover-baseline", leaseA));
    const authorization = taskAuthorization(goalId, contract, baseline, leaseA.generation, leaseA.fencingToken, authority.clock.now());
    authority.store.transactTaskFlow({ type: "AUTHORIZE_WORK_CELL", goalId, authorization }, mutation(authority, goalId, 4, "takeover-authorize", leaseA));
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
    authority.store.transactTaskFlow({ type: "PREPARE_OPERATION", goalId, attempt, prepared, reconcileLocator: null },
      mutation(authority, goalId, 5, "takeover-prepare", leaseA));

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
    }, mutation(authority, goalId, 6, "takeover-prepare-as-b", leaseB))).toThrow(/authorization.*fenc/iu);
    const dispatched = sealTaskFlowRecord<OperationTransitionRecord, "transition_sha256">("PCH-OPERATION-TRANSITION-V1", {
      schema_version: 1, transition_id: "TRANSITION-TAKEOVER-001", attempt_id: attempt.attempt_id, ordinal: 1,
      state: "DISPATCHED", output_sha256: null, readback_sha256: null, failure_signature_sha256: null,
      postcondition: "UNKNOWN", predecessor_sha256: prepared.transition_sha256, created_at_ms: authority.clock.now(),
    }, "transition_sha256");
    expect(() => authority.store.transactTaskFlow({ type: "TRANSITION_OPERATION", goalId, transition: dispatched },
      mutation(authority, goalId, 6, "takeover-dispatch-as-b", leaseB))).toThrow(/authorization.*fenc/iu);
    expect(authority.store.readTaskFlowGoalVersion(goalId)).toBe(6);
    expect(authority.store.readTaskFlowOperation(goalId, attempt.operation_id)).toMatchObject({ state: "PREPARED", ordinal: 0 });
    expect(authority.store.verifyIntegrity()).toMatchObject({ goalCount: 1, eventCount: 6 });
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
      activationSha256: sha256Hex("fault-activation"),
      ...taskAdmissionMetadata("DIRECT_CELL"),
    }, mutation(authority, goalId, 0, "admit-fault"));
    const lease = authority.store.acquireLease(goalId, "SESSION-TASK-FLOW-FAULT", 60_000);
    const contract = taskContract(goalId, authority.clock.now());
    for (const point of ["after-domain-write", "after-event-write", "after-outbox-write", "after-receipt-write", "before-commit"] as const) {
      expect(() => authority.store.transactTaskFlow(
        { type: "SUBMIT_GOAL_CONTRACT", goalId, contract },
        mutation(authority, goalId, 1, `fault-${point}`, lease),
        (current) => { if (current === point) throw new Error(`FAULT:${point}`); },
      )).toThrow(`FAULT:${point}`);
      expect(authority.store.readTaskFlowView(goalId)?.contract).toBeNull();
      expect(authority.store.verifyIntegrity()).toMatchObject({ goalCount: 1, eventCount: 1 });
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
      activationSha256: sha256Hex("plan-activation"),
      ...taskAdmissionMetadata("DIRECT_CELL"),
    }, mutation(authority, goalId, 0, "admit-plan"));
    const lease = authority.store.acquireLease(goalId, "SESSION-TASK-FLOW-PLAN", 60_000);
    const contract = taskContract(goalId, authority.clock.now(), "PLAN");
    authority.store.transactTaskFlow({ type: "SUBMIT_GOAL_CONTRACT", goalId, contract }, mutation(authority, goalId, 1, "plan-contract", lease));
    const route = taskRoute(contract, authority.clock.now());
    authority.store.transactTaskFlow({ type: "SUBMIT_ROUTE_SKELETON", goalId, route, contract }, mutation(authority, goalId, 2, "plan-route", lease));
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
      mutation(authority, goalId, 3, "plan-build-choice", lease));
    expect(authority.store.readTaskFlowView(goalId)).toMatchObject({ status: "BUILDING", nextActionCode: "AUTHORIZE_WORK" });
  });
});
