import { resolve } from "node:path";
import { ArtifactStore } from "../../src/artifacts/artifact-store.js";
import { canonicalJsonSha256 } from "../../src/authority/canonical-json.js";
import { closeAuthorityConnection, openAuthorityConnection } from "../../src/authority/database.js";
import type { LeaseToken } from "../../src/authority/lease.js";
import { MemoryEngine } from "../../src/memory/engine.js";
import type { MemoryEngineConfig, MemoryMutationContext } from "../../src/memory/types.js";
import { sha256Hex } from "../../src/foundation/crypto.js";
import {
  sealTaskFlowRecord, type OperationAttemptRecord, type OperationTransitionRecord, type WorkspaceBaselineRecord,
} from "../../src/task-flow/domain.js";
import { createTestAuthority, type TestAuthority } from "./authority.js";
import {
  finalizeTaskFlowPlan, reviewAndFinalizeTaskFlowContract, taskAcceptanceFacets, taskAdmissionMetadata,
  taskAuthorization, taskBaseline, taskContractProposal, taskFlowMemoryMigrations, taskRoute,
} from "./task-flow.js";
import { passingGoalFitAssessment } from "./goal-fit.js";

export interface Phase6Authority extends TestAuthority {
  readonly artifacts: ArtifactStore;
  readonly goalId: string;
  readonly lease: LeaseToken;
  readonly version: number;
  readonly receiptId: string;
  readonly memory: MemoryEngine;
  readonly memoryConfig: MemoryEngineConfig;
  context(expectedVersion: number): MemoryMutationContext;
}

export function createPhase6Authority(
  indexMode: "FTS5" | "TAG_PATH" = "FTS5",
  enabled = true,
  mode: MemoryEngineConfig["mode"] = enabled ? "EXPERIMENTAL" : "OFF",
  baseDirectory?: string,
): Phase6Authority {
  const authority = createTestAuthority({
    ...(baseDirectory === undefined ? {} : { baseDirectory }),
    memoryMigrations: { ...taskFlowMemoryMigrations, forceIndexMode: indexMode },
    taskFlowMigrationPath: resolve("schemas", "sql", "011_task_flow_kernel_v1.sql"),
    inputContextMigrationPath: resolve("schemas", "sql", "012_input_context_v1.sql"),
    harnessMigrationPath: resolve("schemas", "sql", "013_coding_harness_v1.sql"),
  });
  const goalId = "GOAL-MEMORY-TEST-001";
  const admitted = authority.store.transactTaskFlow({
    type: "ADMIT_TASK_FLOW", goalId,
    workspace: {
      workspaceId: "WS-TEST-001", workspaceHmac: sha256Hex("test-workspace"),
      filesystemKind: "LOCAL_TEST", localLockingVerified: true,
    },
    originSessionId: "SESSION-MEMORY-TEST-001", objective: "Verify durable Memory behavior",
    intent: "BUILD", lane: "ADAPTIVE_ROUTE", sourceIntakeSha256: sha256Hex("memory-test-input"),
    sourceText: "memory-test-input",
    activationSha256: sha256Hex("memory-test-activation"),
    ...taskAdmissionMetadata("ADAPTIVE_ROUTE"),
  }, { expectedVersion: 0, idempotencyKey: "memory-test:admit", actor: "RUNTIME" });
  const lease = authority.store.acquireLease(goalId, "SESSION-MEMORY-TEST-001", 60_000);
  const contractResult = authority.store.transactTaskFlow({
    type: "SUBMIT_GOAL_CONTRACT", goalId, proposal: taskContractProposal(), acceptanceFacets: taskAcceptanceFacets(),
    goalFitAssessment: passingGoalFitAssessment(),
  }, {
    expectedVersion: admitted.goalVersion, idempotencyKey: "memory-test:contract", actor: "RUNTIME", lease,
  });
  let version = reviewAndFinalizeTaskFlowContract(
    authority, goalId, lease, contractResult.goalVersion, "memory-test",
  );
  const contract = authority.store.readTaskFlowView(goalId)?.contract;
  if (!contract) throw new Error("Phase 6 fixture contract was not frozen");
  const route = taskRoute(contract, authority.clock.now());
  authority.store.transactTaskFlow({
    type: "SUBMIT_ROUTE_SKELETON", goalId, route, contract, goalFitAssessment: passingGoalFitAssessment(),
  }, {
    expectedVersion: version, idempotencyKey: "memory-test:route", actor: "RUNTIME", lease,
  });
  version += 1;
  const plan = finalizeTaskFlowPlan(authority, goalId, lease, version, "memory-test");
  version = plan.nextVersion;
  const baseline = taskBaseline(goalId, authority.clock.now());
  authority.store.transactTaskFlow({ type: "RECORD_WORKSPACE_BASELINE", goalId, baseline }, {
    expectedVersion: version, idempotencyKey: "memory-test:baseline", actor: "RUNTIME", lease,
  });
  version += 1;
  const authorization = taskAuthorization(
    goalId, contract, baseline, lease.generation, lease.fencingToken, authority.clock.now(),
    plan.decisionClosureSha256,
  );
  authority.store.transactTaskFlow({ type: "AUTHORIZE_WORK_CELL", goalId, authorization }, {
    expectedVersion: version, idempotencyKey: "memory-test:authorize", actor: "RUNTIME", lease,
  });
  version += 1;
  const cell = route.work_cells[0]!;
  const attempt = sealTaskFlowRecord<OperationAttemptRecord, "record_sha256">("PCH-OPERATION-ATTEMPT-V1", {
    schema_version: 1, attempt_id: "ATTEMPT-MEMORY-TEST-001", operation_id: "OPERATION-MEMORY-TEST-001",
    goal_id: goalId, work_cell_id: cell.work_cell_id, authorization_id: authorization.authorization_id,
    attempt_number: 1, operation_kind: "VALIDATION", normalized_target_hmac: sha256Hex("src/example.ts"),
    normalized_payload_sha256: sha256Hex("memory-test-validation"),
    execution_fingerprint_sha256: sha256Hex("memory-test-execution"), baseline_sha256: baseline.record_sha256,
    environment_sha256: baseline.environment_sha256, oracle_sha256: canonicalJsonSha256(cell.oracle),
    idempotency_key_hmac: sha256Hex("memory-test-operation-key"), created_at_ms: authority.clock.now(),
  }, "record_sha256");
  const prepared = sealTaskFlowRecord<OperationTransitionRecord, "transition_sha256">(
    "PCH-OPERATION-TRANSITION-V1",
    {
      schema_version: 1, transition_id: "TRANSITION-MEMORY-TEST-000", attempt_id: attempt.attempt_id,
      ordinal: 0, state: "PREPARED", output_sha256: null, readback_sha256: null,
      failure_signature_sha256: null, postcondition: "UNKNOWN", predecessor_sha256: null,
      created_at_ms: authority.clock.now(),
    },
    "transition_sha256",
  );
  authority.store.transactTaskFlow({
    type: "PREPARE_OPERATION", goalId, attempt, prepared, reconcileLocator: null,
    oracleExecution: { command: "npm test", policySha256: sha256Hex("memory-test-oracle-policy") },
  }, {
    expectedVersion: version, idempotencyKey: "memory-test:prepare", actor: "RUNTIME", lease,
  });
  version += 1;
  let predecessor = prepared.transition_sha256;
  let terminalTransitionId = "";
  for (const [ordinal, state] of [[1, "DISPATCHED"], [2, "OBSERVED"], [3, "COMMITTED"]] as const) {
    const transition = sealTaskFlowRecord<OperationTransitionRecord, "transition_sha256">(
      "PCH-OPERATION-TRANSITION-V1",
      {
        schema_version: 1, transition_id: `TRANSITION-MEMORY-TEST-00${ordinal}`, attempt_id: attempt.attempt_id,
        ordinal, state, output_sha256: state === "COMMITTED" ? sha256Hex("memory-test-output") : null,
        readback_sha256: state === "OBSERVED" || state === "COMMITTED" ? sha256Hex("memory-test-readback") : null,
        failure_signature_sha256: null, postcondition: state === "COMMITTED" ? "PASS" : "UNKNOWN",
        predecessor_sha256: predecessor, created_at_ms: authority.clock.now(),
      },
      "transition_sha256",
    );
    authority.store.transactTaskFlow({ type: "TRANSITION_OPERATION", goalId, transition }, {
      expectedVersion: version, idempotencyKey: `memory-test:transition-${ordinal}`, actor: "RUNTIME", lease,
    });
    version += 1;
    predecessor = transition.transition_sha256;
    if (state === "COMMITTED") terminalTransitionId = transition.transition_id;
  }
  const postimage = sealTaskFlowRecord<WorkspaceBaselineRecord, "record_sha256">("PCH-WORKSPACE-BASELINE-V1", {
    schema_version: 1, baseline_id: "BASELINE-MEMORY-POST-VALIDATION", workspace_id: baseline.workspace_id,
    goal_id: baseline.goal_id, filesystem_identity_hmac: baseline.filesystem_identity_hmac,
    content_root_sha256: sha256Hex("memory-test-postimage"), created_at_ms: authority.clock.now(),
    environment_sha256: baseline.environment_sha256, oracle_set_sha256: baseline.oracle_set_sha256,
    scope_manifest: baseline.scope_manifest,
  }, "record_sha256");
  authority.store.transactTaskFlow({ type: "RECORD_WORKSPACE_BASELINE", goalId, baseline: postimage }, {
    expectedVersion: version, idempotencyKey: "memory-test:postimage", actor: "RUNTIME", lease,
  });
  version += 1;
  const evidenceResult = authority.store.transactTaskFlow({
    type: "DERIVE_ACCEPTANCE_EVIDENCE_V2", goalId, attemptId: attempt.attempt_id, terminalTransitionId,
  }, {
    expectedVersion: version, idempotencyKey: "memory-test:evidence-v2", actor: "RUNTIME", lease,
  });
  const connection = openAuthorityConnection({ path: authority.databasePath });
  let receiptId: string;
  try {
    const row = connection.prepare(`SELECT pass_receipt_id FROM oracle_pass_receipts_v2
      WHERE goal_id=? ORDER BY pass_receipt_id LIMIT 1`).get(goalId) as { readonly pass_receipt_id?: unknown } | undefined;
    if (typeof row?.pass_receipt_id !== "string") throw new Error("Phase 6 fixture lacks an Oracle PASS receipt");
    receiptId = row.pass_receipt_id;
  } finally {
    closeAuthorityConnection(connection);
  }
  const memoryConfig: MemoryEngineConfig = {
    enabled, mode, epoch: `MEMORY-V3-${indexMode}-TEST`, softProjectionTokens: 600,
    hardProjectionTokens: 1200, maxResults: 12, maxPolicyResults: 6, maxEvidenceResults: 4,
    maxExperienceResults: 2, maxStructuredScanRows: 5000, maxPayloadBytes: 1_048_576,
    indexDrainBatch: 128, indexDrainDebounceMs: 50,
  };
  const memory = new MemoryEngine(authority.store, memoryConfig, () => authority.clock.now());
  return {
    ...authority, artifacts: new ArtifactStore(authority.casPath), goalId, lease,
    version: evidenceResult.goalVersion, receiptId, memory, memoryConfig,
    context: (expectedVersion) => ({
      goalId, workspaceId: "WS-TEST-001", workspaceRoot: authority.directory,
      mutation: {
        expectedVersion: evidenceResult.goalVersion + expectedVersion - 3,
        idempotencyKey: "memory-test:mutation", actor: "USER", lease,
      },
    }),
  };
}
