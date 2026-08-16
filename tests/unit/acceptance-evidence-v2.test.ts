import { afterEach, describe, expect, it } from "vitest";
import { canonicalJsonSha256 } from "../../src/authority/canonical-json.js";
import { closeAuthorityConnection, openAuthorityConnection, runImmediateTransaction } from "../../src/authority/database.js";
import { AcceptanceEvidenceV2Repository } from "../../src/acceptance-v2/evidence-repository.js";
import { AcceptanceCompletionV2Repository } from "../../src/acceptance-v2/completion-repository.js";
import { sha256Hex } from "../../src/foundation/crypto.js";
import {
  sealHarnessRecord,
  type ManagedRunRecord,
  type TopologyRevisionRecord,
  type WorkShardRecord,
} from "../../src/harness/domain.js";
import {
  sealTaskFlowRecord,
  type OperationAttemptRecord,
  type OperationTransitionRecord,
  type WorkspaceBaselineRecord,
} from "../../src/task-flow/domain.js";
import type { TestAuthority } from "../helpers/authority.js";
import {
  createTaskFlowAuthority, finalizeTaskFlowPlan, reviewAndFinalizeTaskFlowContract,
  taskAcceptanceFacets, taskAdmissionMetadata, taskAuthorization, taskBaseline, taskContractProposal, taskRoute,
} from "../helpers/task-flow.js";
import { passingGoalFitAssessment } from "../helpers/goal-fit.js";

const authorities: TestAuthority[] = [];
afterEach(() => { for (const authority of authorities.splice(0)) authority.close(); });

function mutation(
  authority: TestAuthority,
  goalId: string,
  version: number,
  key: string,
  lease?: ReturnType<TestAuthority["store"]["acquireLease"]>,
) {
  return { expectedVersion: version, idempotencyKey: key, actor: "RUNTIME" as const, ...(lease ? { lease } : {}) };
}

interface FixtureOptions {
  readonly operationKind?: OperationAttemptRecord["operation_kind"];
  readonly oracleSha256?: string;
  readonly descriptorCommand?: string;
  readonly terminal?: "PASS" | "FAIL";
  readonly postimage?: boolean;
  readonly reconciledCommit?: boolean;
}

function operationTransition(input: {
  readonly attemptId: string;
  readonly ordinal: number;
  readonly state: OperationTransitionRecord["state"];
  readonly predecessor: string | null;
  readonly terminal: "PASS" | "FAIL" | null;
  readonly nowMs: number;
}): OperationTransitionRecord {
  return sealTaskFlowRecord<OperationTransitionRecord, "transition_sha256">("PCH-OPERATION-TRANSITION-V1", {
    schema_version: 1, transition_id: `TRANSITION-${input.attemptId}-${input.ordinal}`, attempt_id: input.attemptId,
    ordinal: input.ordinal, state: input.state,
    output_sha256: input.terminal === null ? null : sha256Hex(`validation-${input.terminal.toLowerCase()}`),
    readback_sha256: input.terminal === "PASS" ? sha256Hex("validation-readback") : null,
    failure_signature_sha256: input.terminal === "FAIL" ? sha256Hex("validation-failure") : null,
    postcondition: input.terminal ?? "UNKNOWN", predecessor_sha256: input.predecessor, created_at_ms: input.nowMs,
  }, "transition_sha256");
}

function fixture(options: FixtureOptions = {}): {
  readonly authority: TestAuthority;
  readonly goalId: string;
  readonly lease: ReturnType<TestAuthority["store"]["acquireLease"]>;
  readonly attemptId: string;
  readonly terminalTransitionId: string;
  readonly requirementId: string;
  readonly requirementIds: readonly string[];
  readonly version: number;
  readonly nextSequence: number;
} {
  const authority = createTaskFlowAuthority();
  authorities.push(authority);
  const goalId = "GOAL-ACCEPTANCE-EVIDENCE-V2";
  authority.store.transactTaskFlow({
    type: "ADMIT_TASK_FLOW", goalId,
    workspace: {
      workspaceId: "WS-TEST-001", workspaceHmac: sha256Hex("acceptance-evidence-workspace"),
      filesystemKind: "LOCAL_TEST", localLockingVerified: true,
    },
    originSessionId: "SESSION-ACCEPTANCE-EVIDENCE", objective: "Implement and validate one bounded result",
    intent: "BUILD", lane: "DIRECT_CELL", sourceIntakeSha256: sha256Hex("task-flow-intake"),
    sourceText: "task-flow-intake", activationSha256: sha256Hex("acceptance-evidence-activation"),
    ...taskAdmissionMetadata("DIRECT_CELL"),
  }, mutation(authority, goalId, 0, "admit"));
  const lease = authority.store.acquireLease(goalId, "SESSION-ACCEPTANCE-EVIDENCE", 120_000);
  authority.store.transactTaskFlow({
    type: "SUBMIT_GOAL_CONTRACT", goalId, proposal: taskContractProposal(), acceptanceFacets: taskAcceptanceFacets(),
    goalFitAssessment: passingGoalFitAssessment(),
  }, mutation(authority, goalId, 1, "contract", lease));
  const contract = authority.store.readTaskFlowView(goalId)?.contract;
  const acceptance = contract ? authority.store.readTaskFlowAcceptanceV2(contract.contract_id) : null;
  if (!contract || !acceptance) throw new Error("Acceptance evidence fixture contract was not frozen");
  let version = reviewAndFinalizeTaskFlowContract(authority, goalId, lease, 2, "acceptance-evidence");
  const route = taskRoute(contract, authority.clock.now());
  authority.store.transactTaskFlow({
    type: "SUBMIT_ROUTE_SKELETON", goalId, route, contract, goalFitAssessment: passingGoalFitAssessment(),
  },
    mutation(authority, goalId, version, "route", lease));
  version += 1;
  const planGate = finalizeTaskFlowPlan(authority, goalId, lease, version, "acceptance-evidence");
  version = planGate.nextVersion;
  const baseline = taskBaseline(goalId, authority.clock.now());
  authority.store.transactTaskFlow({ type: "RECORD_WORKSPACE_BASELINE", goalId, baseline },
    mutation(authority, goalId, version, "baseline", lease));
  version += 1;
  const authorization = taskAuthorization(
    goalId, contract, baseline, lease.generation, lease.fencingToken, authority.clock.now(),
    planGate.decisionClosureSha256,
  );
  authority.store.transactTaskFlow({ type: "AUTHORIZE_WORK_CELL", goalId, authorization },
    mutation(authority, goalId, version, "authorize", lease));
  version += 1;
  const attempt = sealTaskFlowRecord<OperationAttemptRecord, "record_sha256">("PCH-OPERATION-ATTEMPT-V1", {
    schema_version: 1, attempt_id: "ATTEMPT-ACCEPTANCE-EVIDENCE", operation_id: "OPERATION-ACCEPTANCE-EVIDENCE",
    goal_id: goalId, work_cell_id: authorization.work_cell_id, authorization_id: authorization.authorization_id,
    attempt_number: 1, operation_kind: options.operationKind ?? "VALIDATION",
    normalized_target_hmac: sha256Hex("validation-target"), normalized_payload_sha256: sha256Hex("validation-payload"),
    execution_fingerprint_sha256: sha256Hex("validation-fingerprint"), baseline_sha256: baseline.record_sha256,
    environment_sha256: baseline.environment_sha256,
    oracle_sha256: options.oracleSha256 ?? canonicalJsonSha256(contract.obligations[0]!.oracle),
    idempotency_key_hmac: sha256Hex("validation-idempotency"), created_at_ms: authority.clock.now(),
  }, "record_sha256");
  const prepared = operationTransition({
    attemptId: attempt.attempt_id, ordinal: 0, state: "PREPARED", predecessor: null,
    terminal: null, nowMs: authority.clock.now(),
  });
  authority.store.transactTaskFlow({
    type: "PREPARE_OPERATION", goalId, attempt, prepared, reconcileLocator: null,
    oracleExecution: options.operationKind === "COMMAND" ? null : {
      command: options.descriptorCommand ?? "npm test",
      policySha256: sha256Hex("acceptance-evidence-oracle-policy"),
    },
  },
    mutation(authority, goalId, version, "prepare", lease));
  version += 1;
  const dispatched = operationTransition({
    attemptId: attempt.attempt_id, ordinal: 1, state: "DISPATCHED", predecessor: prepared.transition_sha256,
    terminal: null, nowMs: authority.clock.now(),
  });
  authority.store.transactTaskFlow({ type: "TRANSITION_OPERATION", goalId, transition: dispatched },
    mutation(authority, goalId, version, "dispatch", lease));
  version += 1;
  const terminalResult = options.terminal ?? "PASS";
  const observed = terminalResult === "PASS" && !options.reconciledCommit ? operationTransition({
    attemptId: attempt.attempt_id, ordinal: 2, state: "OBSERVED", predecessor: dispatched.transition_sha256,
    terminal: null, nowMs: authority.clock.now(),
  }) : null;
  if (observed) authority.store.transactTaskFlow({ type: "TRANSITION_OPERATION", goalId, transition: observed },
    mutation(authority, goalId, version, "observe", lease));
  const outcomeUnknown = options.reconciledCommit ? operationTransition({
    attemptId: attempt.attempt_id, ordinal: 2, state: "OUTCOME_UNKNOWN", predecessor: dispatched.transition_sha256,
    terminal: null, nowMs: authority.clock.now(),
  }) : null;
  if (outcomeUnknown) authority.store.transactTaskFlow({ type: "TRANSITION_OPERATION", goalId, transition: outcomeUnknown },
    mutation(authority, goalId, version, "unknown", lease));
  if (observed || outcomeUnknown) version += 1;
  const terminal = operationTransition({
    attemptId: attempt.attempt_id, ordinal: observed || outcomeUnknown ? 3 : 2,
    state: terminalResult === "PASS" ? "COMMITTED" : "FAILED",
    predecessor: observed?.transition_sha256 ?? outcomeUnknown?.transition_sha256 ?? dispatched.transition_sha256,
    terminal: terminalResult, nowMs: authority.clock.now(),
  });
  authority.store.transactTaskFlow(options.reconciledCommit
    ? { type: "RECONCILE_OPERATION", goalId, transition: terminal, disposition: "APPLIED" }
    : { type: "TRANSITION_OPERATION", goalId, transition: terminal },
  mutation(authority, goalId, version, "terminal", lease));
  version += 1;
  if (options.postimage ?? true) {
    const baselineBody = Object.fromEntries(
      Object.entries(baseline).filter(([key]) => key !== "record_sha256"),
    ) as Omit<WorkspaceBaselineRecord, "record_sha256">;
    const postimage = sealTaskFlowRecord<WorkspaceBaselineRecord, "record_sha256">("PCH-WORKSPACE-BASELINE-V1", {
      ...baselineBody, baseline_id: "BASELINE-POST-VALIDATION", content_root_sha256: sha256Hex("post-validation-content"),
      scope_manifest: [{ root: "src/example.ts", sha256: sha256Hex("post-validation-file") }],
      created_at_ms: authority.clock.now(),
    }, "record_sha256");
    authority.store.transactTaskFlow({ type: "RECORD_WORKSPACE_BASELINE", goalId, baseline: postimage },
      mutation(authority, goalId, version, "postimage", lease));
    version += 1;
  }
  return {
    authority, goalId, attemptId: attempt.attempt_id,
    requirementId: acceptance.evidence_requirements[0]!.evidence_requirement_id,
    requirementIds: acceptance.evidence_requirements.map((entry) => entry.evidence_requirement_id),
    terminalTransitionId: terminal.transition_id, lease, version,
    nextSequence: version + 1,
  };
}

describe("Acceptance evidence V2 repository", () => {
  it("derives observation, PASS receipt and binding from current Host authority", () => {
    const value = fixture();
    const connection = openAuthorityConnection({ path: value.authority.databasePath });
    try {
      const closures = runImmediateTransaction(connection, () => new AcceptanceEvidenceV2Repository(connection)
        .recordOracleEvidence({
          attempt_id: value.attemptId,
        }, {
          created_at_ms: value.authority.clock.now(),
          created_event_sequence: value.nextSequence,
        }));
      const closure = closures[0]!;
      expect(closures).toHaveLength(3);
      expect(closure.observation).toMatchObject({
        goal_id: value.goalId, attempt_id: value.attemptId, observed_postcondition: "PASS",
      });
      expect(closure.pass_receipt).toMatchObject({
        goal_id: value.goalId, evidence_requirement_id: value.requirementId,
        attempt_id: value.attemptId, observation_root_sha256: closure.observation.output_sha256,
      });
      expect(closure.evidence_binding).toMatchObject({
        goal_id: value.goalId, evidence_requirement_id: value.requirementId,
        pass_receipt_id: closure.pass_receipt.pass_receipt_id,
      });
      expect(closure.witnesses).toHaveLength(1);
      expect(new AcceptanceEvidenceV2Repository(connection).verifyIntegrity()).toEqual({
        observations: 1, passReceipts: 3, evidenceBindings: 3,
      });
      expect(connection.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      connection.exec("DROP TRIGGER no_delete_acceptance_evidence_witness_members_v2");
      connection.prepare("DELETE FROM acceptance_evidence_witness_members_v2").run();
      expect(() => new AcceptanceEvidenceV2Repository(connection).verifyIntegrity()).toThrow(/witness closure mismatch/u);
    } finally {
      closeAuthorityConnection(connection);
    }
  });

  it("reuses one Host observation for every Host-derived eligible frozen requirement", () => {
    const value = fixture();
    expect(value.requirementIds).toHaveLength(3);
    const connection = openAuthorityConnection({ path: value.authority.databasePath });
    try {
      const closures = runImmediateTransaction(connection, () =>
        new AcceptanceEvidenceV2Repository(connection).recordOracleEvidence({
          attempt_id: value.attemptId,
        }, {
          created_at_ms: value.authority.clock.now(),
          created_event_sequence: value.nextSequence,
        }));
      expect(new Set(closures.map((entry) => entry.observation.observation_id)).size).toBe(1);
      expect(new Set(closures.map((entry) => entry.pass_receipt.evidence_requirement_id)).size).toBe(3);
      expect(new AcceptanceEvidenceV2Repository(connection).verifyIntegrity()).toEqual({
        observations: 1, passReceipts: 3, evidenceBindings: 3,
      });
    } finally {
      closeAuthorityConnection(connection);
    }
  });

  it("derives a multi-requirement closure atomically through AuthorityStore and replays idempotently", () => {
    const value = fixture();
    const meta = mutation(value.authority, value.goalId, value.nextSequence - 1, "derive-all", value.lease);
    const command = {
      type: "DERIVE_ACCEPTANCE_EVIDENCE_V2" as const,
      goalId: value.goalId,
      attemptId: value.attemptId,
      terminalTransitionId: value.terminalTransitionId,
    };
    const first = value.authority.store.transactTaskFlow(command, meta);
    expect(first).toMatchObject({ eventType: "EVIDENCE_ATTESTED", eventSequence: value.nextSequence, reused: false });
    expect(value.authority.store.transactTaskFlow(command, meta)).toMatchObject({
      eventSequence: value.nextSequence, reused: true,
    });

    const connection = openAuthorityConnection({ path: value.authority.databasePath });
    try {
      expect(new AcceptanceEvidenceV2Repository(connection).verifyIntegrity()).toEqual({
        observations: 1, passReceipts: 3, evidenceBindings: 3,
      });
      const event = connection.prepare("SELECT payload_json FROM events WHERE goal_id=? ORDER BY sequence DESC LIMIT 1")
        .get(value.goalId) as { readonly payload_json: string };
      const payload = JSON.parse(event.payload_json) as Record<string, unknown>;
      expect(payload).toMatchObject({
        attemptId: value.attemptId,
        terminalTransitionId: value.terminalTransitionId,
        evidenceRequirementIds: [...value.requirementIds].sort(),
      });
      expect(Array.isArray(payload.evidenceBindingIds)).toBe(true);
      expect((payload.evidenceBindingIds as unknown[]).length).toBe(3);
    } finally {
      closeAuthorityConnection(connection);
    }
  });

  it("rejects a caller attempt to inject evidence requirement authority", () => {
    const value = fixture();
    const forged = {
      type: "DERIVE_ACCEPTANCE_EVIDENCE_V2",
      goalId: value.goalId,
      attemptId: value.attemptId,
      terminalTransitionId: value.terminalTransitionId,
      evidenceRequirementIds: [value.requirementIds[0]!, "ZZZ-UNKNOWN-EVIDENCE-REQUIREMENT"],
    } as unknown as Parameters<TestAuthority["store"]["transactTaskFlow"]>[0];
    expect(() => value.authority.store.transactTaskFlow(
      forged, mutation(value.authority, value.goalId, value.nextSequence - 1, "derive-invalid", value.lease),
    )).toThrow(/command shape|caller.*requirement/iu);
    const connection = openAuthorityConnection({ path: value.authority.databasePath });
    try {
      expect(new AcceptanceEvidenceV2Repository(connection).verifyIntegrity()).toEqual({
        observations: 0, passReceipts: 0, evidenceBindings: 0,
      });
      expect(connection.prepare("SELECT max(sequence) sequence FROM events WHERE goal_id=?").get(value.goalId))
        .toEqual({ sequence: value.nextSequence - 1 });
    } finally {
      closeAuthorityConnection(connection);
    }
  });

  it.each([
    ["non-validation", { operationKind: "COMMAND" } satisfies FixtureOptions, /terminal Host validation PASS/u],
    ["FAIL", { terminal: "FAIL" } satisfies FixtureOptions, /terminal Host validation PASS/u],
    ["no post-validation baseline", { postimage: false } satisfies FixtureOptions, /post-validation Host baseline/u],
    ["reconciled validation output", { reconciledCommit: true } satisfies FixtureOptions, /terminal Host validation PASS/u],
  ])("rejects %s and writes no partial evidence", (_label, options, error) => {
    const value = fixture(options);
    const connection = openAuthorityConnection({ path: value.authority.databasePath });
    try {
      expect(() => runImmediateTransaction(connection, () => new AcceptanceEvidenceV2Repository(connection)
        .recordOracleEvidence({ attempt_id: value.attemptId }, {
          created_at_ms: value.authority.clock.now(), created_event_sequence: value.nextSequence,
        }))).toThrow(error);
      for (const table of [
        "oracle_execution_observations_v2", "oracle_pass_receipts_v2",
        "acceptance_evidence_bindings_v2", "acceptance_evidence_witness_members_v2",
      ]) expect(connection.prepare(`SELECT count(*) count FROM ${table}`).get()).toEqual({ count: 0 });
    } finally {
      closeAuthorityConnection(connection);
    }
  });

  it("rejects an attempt whose aggregate oracle does not match its execution descriptor", () => {
    expect(() => fixture({ oracleSha256: sha256Hex("supplemental-oracle") }))
      .toThrow(/descriptor.*WorkCell oracle|validation attempt/iu);
  });

  it("persists supplemental validation but never promotes it to frozen evidence", () => {
    const value = fixture({ descriptorCommand: "npm run lint" });
    const connection = openAuthorityConnection({ path: value.authority.databasePath });
    try {
      expect(connection.prepare("SELECT command_text,evidence_role FROM oracle_execution_descriptors_v2").get())
        .toEqual({ command_text: "npm run lint", evidence_role: "SUPPLEMENTAL_VALIDATION" });
      expect(() => runImmediateTransaction(connection, () => new AcceptanceEvidenceV2Repository(connection)
        .recordOracleEvidence({ attempt_id: value.attemptId }, {
          created_at_ms: value.authority.clock.now(), created_event_sequence: value.nextSequence,
        }))).toThrow(/Supplemental validation cannot authorize frozen Acceptance evidence/u);
      expect(connection.prepare("SELECT count(*) count FROM oracle_pass_receipts_v2").get()).toEqual({ count: 0 });
    } finally { closeAuthorityConnection(connection); }
  });

  it("rejects a canonically resealed descriptor with substituted policy lineage", () => {
    const value = fixture();
    const connection = openAuthorityConnection({ path: value.authority.databasePath });
    try {
      const row = connection.prepare("SELECT * FROM oracle_execution_descriptors_v2").get() as Record<string, unknown>;
      const policySha256 = sha256Hex("substituted-policy");
      const resealed = canonicalJsonSha256({
        domain: "PCH-ORACLE-EXECUTION-DESCRIPTOR-V2", schema_version: 2,
        descriptor_id: row.descriptor_id, goal_id: row.goal_id, work_cell_id: row.work_cell_id,
        attempt_id: row.attempt_id, command: row.command_text, command_sha256: row.command_sha256,
        evidence_role: row.evidence_role, work_cell_oracle_sha256: row.work_cell_oracle_sha256,
        policy_sha256: policySha256, execution_fingerprint_sha256: row.execution_fingerprint_sha256,
      });
      connection.exec("DROP TRIGGER no_update_oracle_execution_descriptors_v2");
      connection.prepare("UPDATE oracle_execution_descriptors_v2 SET policy_sha256=?,record_sha256=? WHERE descriptor_id=?")
        .run(policySha256, resealed, String(row.descriptor_id));
      expect(() => new AcceptanceEvidenceV2Repository(connection).verifyIntegrity())
        .toThrow(/descriptor is invalid|identity/iu);
    } finally { closeAuthorityConnection(connection); }
  });

  it("rejects expired authorization while the lease remains current", () => {
    const value = fixture();
    value.authority.clock.advance(60_001);
    const connection = openAuthorityConnection({ path: value.authority.databasePath });
    try {
      expect(() => runImmediateTransaction(connection, () => new AcceptanceEvidenceV2Repository(connection)
        .recordOracleEvidence({ attempt_id: value.attemptId }, {
          created_at_ms: value.authority.clock.now(), created_event_sequence: value.nextSequence,
        }))).toThrow(/current fenced/u);
      expect(connection.prepare("SELECT count(*) count FROM oracle_execution_observations_v2").get()).toEqual({ count: 0 });
    } finally {
      closeAuthorityConnection(connection);
    }
  });

  it("rejects a caller-supplied transaction sequence that is not the next Goal event", () => {
    const value = fixture();
    const connection = openAuthorityConnection({ path: value.authority.databasePath });
    try {
      expect(() => runImmediateTransaction(connection, () => new AcceptanceEvidenceV2Repository(connection)
        .recordOracleEvidence({ attempt_id: value.attemptId }, {
          created_at_ms: value.authority.clock.now(), created_event_sequence: value.nextSequence + 1,
        }))).toThrow(/next Goal event/u);
      expect(connection.prepare("SELECT count(*) count FROM oracle_execution_observations_v2").get()).toEqual({ count: 0 });
    } finally {
      closeAuthorityConnection(connection);
    }
  });

  it("derives a shared observation through one public transaction command", () => {
    const value = fixture();
    const result = value.authority.store.transactTaskFlow({
      type: "DERIVE_ACCEPTANCE_EVIDENCE_V2",
      goalId: value.goalId,
      attemptId: value.attemptId,
      terminalTransitionId: value.terminalTransitionId,
    }, mutation(value.authority, value.goalId, value.version, "derive-evidence-v2", value.lease));
    expect(result.eventType).toBe("EVIDENCE_ATTESTED");
    const connection = openAuthorityConnection({ path: value.authority.databasePath });
    try {
      expect(new AcceptanceEvidenceV2Repository(connection).verifyIntegrity()).toEqual({
        observations: 1, passReceipts: 3, evidenceBindings: 3,
      });
    } finally { closeAuthorityConnection(connection); }
  });

  it("rolls back a public derivation with a stale terminal transition reference", () => {
    const value = fixture();
    expect(() => value.authority.store.transactTaskFlow({
      type: "DERIVE_ACCEPTANCE_EVIDENCE_V2",
      goalId: value.goalId,
      attemptId: value.attemptId,
      terminalTransitionId: "TRANSITION-STALE",
    }, mutation(value.authority, value.goalId, value.version, "derive-evidence-v2-stale", value.lease)))
      .toThrow(/terminal transition reference is stale/u);
    const connection = openAuthorityConnection({ path: value.authority.databasePath });
    try {
      expect(connection.prepare("SELECT count(*) count FROM oracle_execution_observations_v2").get()).toEqual({ count: 0 });
      expect(connection.prepare("SELECT count(*) count FROM events WHERE goal_id=?").get(value.goalId))
        .toEqual({ count: value.version });
    } finally { closeAuthorityConnection(connection); }
  });

  it("rejects a canonically resealed observation that no longer represents PASS", () => {
    const value = fixture();
    value.authority.store.transactTaskFlow({
      type: "DERIVE_ACCEPTANCE_EVIDENCE_V2",
      goalId: value.goalId,
      attemptId: value.attemptId,
      terminalTransitionId: value.terminalTransitionId,
    }, mutation(value.authority, value.goalId, value.version, "derive-evidence-v2-tamper", value.lease));
    const connection = openAuthorityConnection({ path: value.authority.databasePath });
    try {
      const row = connection.prepare("SELECT * FROM oracle_execution_observations_v2 LIMIT 1")
        .get() as Record<string, unknown>;
      const resealed = canonicalJsonSha256({
        domain: "PCH-ORACLE-EXECUTION-OBSERVATION-V2",
        schema_version: 2,
        observation_id: row.observation_id,
        goal_id: row.goal_id,
        work_cell_id: row.work_cell_id,
        attempt_id: row.attempt_id,
        terminal_transition_id: row.terminal_transition_id,
        terminal_transition_sha256: row.terminal_transition_sha256,
        observed_postcondition: "UNKNOWN",
        output_sha256: row.output_sha256,
      });
      connection.exec("DROP TRIGGER no_update_oracle_execution_observations_v2");
      connection.prepare(`UPDATE oracle_execution_observations_v2
        SET observed_postcondition='UNKNOWN',record_sha256=? WHERE observation_id=?`)
        .run(resealed, String(row.observation_id));
      expect(() => new AcceptanceEvidenceV2Repository(connection).verifyIntegrity())
        .toThrow(/PASS observation/u);
    } finally { closeAuthorityConnection(connection); }
  });

  it("rejects a completion stamp that is not the next Goal event", () => {
    const value = fixture();
    value.authority.store.transactTaskFlow({
      type: "DERIVE_ACCEPTANCE_EVIDENCE_V2",
      goalId: value.goalId,
      attemptId: value.attemptId,
      terminalTransitionId: value.terminalTransitionId,
    }, mutation(value.authority, value.goalId, value.version, "derive-before-bad-completion-sequence", value.lease));
    const connection = openAuthorityConnection({ path: value.authority.databasePath });
    try {
      expect(() => runImmediateTransaction(connection, () => new AcceptanceCompletionV2Repository(connection)
        .recordWorkCellCompletion({ goal_id: value.goalId, work_cell_id: "CELL-TEST-001" }, {
          created_at_ms: value.authority.clock.now(), created_event_sequence: value.nextSequence + 2,
        }))).toThrow(/next Goal event/u);
      expect(connection.prepare("SELECT count(*) count FROM work_cell_completion_receipts_v2").get())
        .toEqual({ count: 0 });
    } finally { closeAuthorityConnection(connection); }
  });

  it("rejects completion after authorization expiry while the lease remains current", () => {
    const value = fixture();
    value.authority.store.transactTaskFlow({
      type: "DERIVE_ACCEPTANCE_EVIDENCE_V2",
      goalId: value.goalId,
      attemptId: value.attemptId,
      terminalTransitionId: value.terminalTransitionId,
    }, mutation(value.authority, value.goalId, value.version, "derive-before-authorization-expiry", value.lease));
    value.authority.clock.advance(60_001);
    const connection = openAuthorityConnection({ path: value.authority.databasePath });
    try {
      expect(() => runImmediateTransaction(connection, () => new AcceptanceCompletionV2Repository(connection)
        .recordWorkCellCompletion({ goal_id: value.goalId, work_cell_id: "CELL-TEST-001" }, {
          created_at_ms: value.authority.clock.now(), created_event_sequence: value.nextSequence + 1,
        }))).toThrow(/current fenced/u);
      expect(connection.prepare("SELECT count(*) count FROM work_cell_completion_receipts_v2").get())
        .toEqual({ count: 0 });
    } finally { closeAuthorityConnection(connection); }
  });

  it("rejects completion when the current topology changed after evidence", () => {
    const value = fixture();
    let version = value.authority.store.transactTaskFlow({
      type: "DERIVE_ACCEPTANCE_EVIDENCE_V2",
      goalId: value.goalId,
      attemptId: value.attemptId,
      terminalTransitionId: value.terminalTransitionId,
    }, mutation(value.authority, value.goalId, value.version, "derive-before-topology-change", value.lease)).goalVersion;
    const run = sealHarnessRecord<ManagedRunRecord, "record_sha256">("PCH-MANAGED-RUN-V1", {
      schema_version: 1,
      run_id: "RUN-AFTER-EVIDENCE",
      goal_id: value.goalId,
      workspace_id: "WS-TEST-001",
      created_by_host_hmac: sha256Hex("host-after-evidence"),
      initial_config_sha256: sha256Hex("config-after-evidence"),
      created_at_ms: value.authority.clock.now(),
    }, "record_sha256");
    const topology = sealHarnessRecord<TopologyRevisionRecord, "record_sha256">("PCH-TOPOLOGY-REVISION-V1", {
      schema_version: 1,
      run_id: run.run_id,
      revision: 1,
      requested_topology: "MULTI",
      effective_topology: "MULTI",
      reason_code: "USER_SELECTED",
      decision_sha256: sha256Hex("topology-after-evidence"),
      config_sha256: run.initial_config_sha256,
      created_at_ms: value.authority.clock.now(),
    }, "record_sha256");
    version = value.authority.store.transactHarness(
      { type: "CREATE_MANAGED_RUN", goalId: value.goalId, run, topology },
      mutation(value.authority, value.goalId, version, "run-after-evidence", value.lease),
    ).goalVersion;
    const shard = sealHarnessRecord<WorkShardRecord, "spec_sha256">("PCH-WORK-SHARD-V1", {
      schema_version: 1,
      shard_id: "SHARD-AFTER-EVIDENCE",
      run_id: run.run_id,
      goal_id: value.goalId,
      work_cell_id: "CELL-TEST-001",
      logical_key: "after-evidence",
      ordinal: 0,
      role: "VERIFIER",
      outcome: "Complete the current WorkCell",
      dependencies: [],
      read_roots: ["src"],
      write_roots: [],
      oracle: { command: "npm test" },
      packet_budget: { max_attempts: 1 },
    }, "spec_sha256");
    version = value.authority.store.transactHarness({
      type: "DEFINE_WORK_SHARDS",
      goalId: value.goalId,
      runId: run.run_id,
      workCellId: shard.work_cell_id,
      shards: [shard],
    }, mutation(value.authority, value.goalId, version, "shard-after-evidence", value.lease)).goalVersion;

    const connection = openAuthorityConnection({ path: value.authority.databasePath });
    try {
      expect(() => runImmediateTransaction(connection, () => new AcceptanceCompletionV2Repository(connection)
        .recordWorkCellCompletion({ goal_id: value.goalId, work_cell_id: "CELL-TEST-001" }, {
          created_at_ms: value.authority.clock.now(), created_event_sequence: version + 1,
        }))).toThrow(/topology/u);
      expect(connection.prepare("SELECT count(*) count FROM work_cell_completion_receipts_v2").get())
        .toEqual({ count: 0 });
    } finally { closeAuthorityConnection(connection); }
  });

  it("rejects completion when a committed mutation is newer than the current evidence", () => {
    const value = fixture();
    value.authority.store.transactTaskFlow({
      type: "DERIVE_ACCEPTANCE_EVIDENCE_V2",
      goalId: value.goalId,
      attemptId: value.attemptId,
      terminalTransitionId: value.terminalTransitionId,
    }, mutation(value.authority, value.goalId, value.version, "derive-before-mutation", value.lease));

    const read = openAuthorityConnection({ path: value.authority.databasePath });
    const baseline = read.prepare(`SELECT b.record_sha256,b.environment_sha256
      FROM execution_authorizations_v1 z JOIN workspace_baselines_v1 b ON b.baseline_id=z.baseline_id
      WHERE z.authorization_id=?`).get("AUTHORIZATION-TEST-001") as {
        readonly record_sha256: string;
        readonly environment_sha256: string;
      };
    closeAuthorityConnection(read);

    const attempt = sealTaskFlowRecord<OperationAttemptRecord, "record_sha256">("PCH-OPERATION-ATTEMPT-V1", {
      schema_version: 1,
      attempt_id: "ATTEMPT-AFTER-EVIDENCE-WRITE",
      operation_id: "OPERATION-AFTER-EVIDENCE-WRITE",
      goal_id: value.goalId,
      work_cell_id: "CELL-TEST-001",
      authorization_id: "AUTHORIZATION-TEST-001",
      attempt_number: 1,
      operation_kind: "WRITE",
      normalized_target_hmac: sha256Hex("src/example.ts"),
      normalized_payload_sha256: sha256Hex("new-content"),
      execution_fingerprint_sha256: sha256Hex("write-after-evidence"),
      baseline_sha256: baseline.record_sha256,
      environment_sha256: baseline.environment_sha256,
      oracle_sha256: sha256Hex("write-oracle"),
      idempotency_key_hmac: sha256Hex("write-after-evidence-idempotency"),
      created_at_ms: value.authority.clock.now(),
    }, "record_sha256");
    const prepared = operationTransition({
      attemptId: attempt.attempt_id, ordinal: 0, state: "PREPARED", predecessor: null,
      terminal: null, nowMs: value.authority.clock.now(),
    });
    let version = value.version + 1;
    value.authority.store.transactTaskFlow(
      { type: "PREPARE_OPERATION", goalId: value.goalId, attempt, prepared, reconcileLocator: null, oracleExecution: null },
      mutation(value.authority, value.goalId, version, "prepare-write-after-evidence", value.lease),
    );
    version += 1;
    let predecessor = prepared.transition_sha256;
    for (const [ordinal, state] of [[1, "DISPATCHED"], [2, "OBSERVED"], [3, "COMMITTED"]] as const) {
      const transition = operationTransition({
        attemptId: attempt.attempt_id, ordinal, state, predecessor,
        terminal: state === "OBSERVED" || state === "COMMITTED" ? "PASS" : null,
        nowMs: value.authority.clock.now(),
      });
      value.authority.store.transactTaskFlow(
        { type: "TRANSITION_OPERATION", goalId: value.goalId, transition },
        mutation(value.authority, value.goalId, version, `write-after-evidence-${state}`, value.lease),
      );
      predecessor = transition.transition_sha256;
      version += 1;
    }

    const connection = openAuthorityConnection({ path: value.authority.databasePath });
    try {
      expect(() => runImmediateTransaction(connection, () => new AcceptanceCompletionV2Repository(connection)
        .recordWorkCellCompletion({ goal_id: value.goalId, work_cell_id: "CELL-TEST-001" }, {
          created_at_ms: value.authority.clock.now(), created_event_sequence: version + 1,
        }))).toThrow(/stale/u);
      expect(connection.prepare("SELECT count(*) count FROM work_cell_completion_receipts_v2").get())
        .toEqual({ count: 0 });
    } finally { closeAuthorityConnection(connection); }
  });
});
