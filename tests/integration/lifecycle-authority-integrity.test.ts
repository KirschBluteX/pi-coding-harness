import { afterEach, describe, expect, it } from "vitest";
import { closeAuthorityConnection, openAuthorityConnection } from "../../src/authority/database.js";
import { sha256Hex } from "../../src/foundation/crypto.js";
import { verifyLifecycleAuthorityIntegrity } from "../../src/runtime/lifecycle.js";
import { passingGoalFitAssessment } from "../helpers/goal-fit.js";
import {
  createTaskFlowAuthority, finalizeTaskFlowPlan, reviewAndFinalizeTaskFlowContract,
  taskAcceptanceFacets, taskAdmissionMetadata, taskContractProposal, taskRoute,
} from "../helpers/task-flow.js";
import type { TestAuthority } from "../helpers/authority.js";

const authorities: TestAuthority[] = [];
afterEach(() => { for (const authority of authorities.splice(0)) authority.close(); });

describe("lifecycle authority integrity", () => {
  it("rebuilds Acceptance V2 and rejects a missing explicit authority member", () => {
    const authority = createTaskFlowAuthority();
    authorities.push(authority);
    const goalId = "GOAL-LIFECYCLE-ACCEPTANCE-V2";
    authority.store.transactTaskFlow({
      type: "ADMIT_TASK_FLOW",
      goalId,
      workspace: {
        workspaceId: "WS-LIFECYCLE-ACCEPTANCE-V2",
        workspaceHmac: sha256Hex("lifecycle-acceptance-workspace"),
        filesystemKind: "LOCAL_TEST",
        localLockingVerified: true,
      },
      originSessionId: "SESSION-LIFECYCLE-ACCEPTANCE-V2",
      objective: "Freeze one exact acceptance authority",
      intent: "BUILD",
      lane: "DIRECT_CELL",
      sourceIntakeSha256: sha256Hex("task-flow-intake"),
      sourceText: "task-flow-intake",
      activationSha256: sha256Hex("lifecycle-acceptance-activation"),
      ...taskAdmissionMetadata("DIRECT_CELL"),
    }, {
      expectedVersion: 0,
      idempotencyKey: "lifecycle-acceptance-admit",
      actor: "RUNTIME",
    });
    const lease = authority.store.acquireLease(goalId, "SESSION-LIFECYCLE-ACCEPTANCE-V2", 60_000);
    authority.store.transactTaskFlow({
      type: "SUBMIT_GOAL_CONTRACT",
      goalId,
      proposal: taskContractProposal(),
      acceptanceFacets: taskAcceptanceFacets(),
      goalFitAssessment: passingGoalFitAssessment(),
    }, {
      expectedVersion: 1,
      idempotencyKey: "lifecycle-acceptance-contract",
      actor: "RUNTIME",
      lease,
    });

    const connection = openAuthorityConnection({ path: authority.databasePath });
    try {
      expect(() => verifyLifecycleAuthorityIntegrity(connection, authority.databasePath)).not.toThrow();
      connection.exec("DROP TRIGGER no_delete_acceptance_authority_facet_members_v2");
      connection.exec("DELETE FROM acceptance_authority_facet_members_v2");
      expect(() => verifyLifecycleAuthorityIntegrity(connection, authority.databasePath))
        .toThrow(/authority facet members|explicit members|authority root/iu);
    } finally {
      closeAuthorityConnection(connection);
    }
  });

  it("rejects a missing Plan V2 head when immutable Plan authority remains", () => {
    const authority = createTaskFlowAuthority();
    authorities.push(authority);
    const goalId = "GOAL-LIFECYCLE-PLAN-V2";
    const sessionId = "SESSION-LIFECYCLE-PLAN-V2";
    authority.store.transactTaskFlow({
      type: "ADMIT_TASK_FLOW",
      goalId,
      workspace: {
        workspaceId: "WS-LIFECYCLE-PLAN-V2",
        workspaceHmac: sha256Hex("lifecycle-plan-workspace"),
        filesystemKind: "LOCAL_TEST",
        localLockingVerified: true,
      },
      originSessionId: sessionId,
      objective: "Freeze one exact Plan authority",
      intent: "PLAN",
      lane: "DIRECT_CELL",
      sourceIntakeSha256: sha256Hex("task-flow-intake"),
      sourceText: "task-flow-intake",
      activationSha256: sha256Hex("lifecycle-plan-activation"),
      ...taskAdmissionMetadata("DIRECT_CELL"),
    }, {
      expectedVersion: 0,
      idempotencyKey: "lifecycle-plan-admit",
      actor: "RUNTIME",
    });
    const lease = authority.store.acquireLease(goalId, sessionId, 60_000);
    authority.store.transactTaskFlow({
      type: "SUBMIT_GOAL_CONTRACT",
      goalId,
      proposal: taskContractProposal(),
      acceptanceFacets: taskAcceptanceFacets(),
      goalFitAssessment: passingGoalFitAssessment(),
    }, {
      expectedVersion: 1,
      idempotencyKey: "lifecycle-plan-contract",
      actor: "RUNTIME",
      lease,
    });
    let version = reviewAndFinalizeTaskFlowContract(authority, goalId, lease, 2, "lifecycle-plan");
    const contract = authority.store.readTaskFlowView(goalId)?.contract;
    if (!contract) throw new TypeError("Lifecycle Plan fixture lacks its frozen Contract");
    authority.store.transactTaskFlow({
      type: "SUBMIT_ROUTE_SKELETON",
      goalId,
      contract,
      route: taskRoute(contract, 1_800_000_000_000),
      goalFitAssessment: passingGoalFitAssessment(),
    }, {
      expectedVersion: version,
      idempotencyKey: "lifecycle-plan-route",
      actor: "RUNTIME",
      lease,
    });
    version += 1;
    finalizeTaskFlowPlan(authority, goalId, lease, version, "lifecycle-plan");

    const connection = openAuthorityConnection({ path: authority.databasePath });
    try {
      expect(() => verifyLifecycleAuthorityIntegrity(connection, authority.databasePath)).not.toThrow();
      connection.prepare("DELETE FROM plan_heads_v2 WHERE goal_id=?").run(goalId);
      expect(() => verifyLifecycleAuthorityIntegrity(connection, authority.databasePath))
        .toThrow(/Plan V2 head is not the latest immutable revision/u);
    } finally {
      closeAuthorityConnection(connection);
    }
  });
});
