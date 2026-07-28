import { resolve } from "node:path";
import { ArtifactStore } from "../../src/artifacts/artifact-store.js";
import type { LeaseToken } from "../../src/authority/lease.js";
import { MemoryEngine } from "../../src/memory/engine.js";
import type { MemoryEngineConfig, MemoryMutationContext } from "../../src/memory/types.js";
import { sha256Hex } from "../../src/foundation/crypto.js";
import { sealTaskFlowRecord, type EvidenceAttestationRecord } from "../../src/task-flow/domain.js";
import { createTestAuthority, type TestAuthority } from "./authority.js";
import { taskAdmissionMetadata, taskContract, taskFlowMemoryMigrations, taskRoute } from "./task-flow.js";

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
    activationSha256: sha256Hex("memory-test-activation"),
    ...taskAdmissionMetadata("ADAPTIVE_ROUTE"),
  }, { expectedVersion: 0, idempotencyKey: "memory-test:admit", actor: "RUNTIME" });
  const lease = authority.store.acquireLease(goalId, "SESSION-MEMORY-TEST-001", 60_000);
  const contract = taskContract(goalId, authority.clock.now());
  const contractResult = authority.store.transactTaskFlow({ type: "SUBMIT_GOAL_CONTRACT", goalId, contract }, {
    expectedVersion: admitted.goalVersion, idempotencyKey: "memory-test:contract", actor: "RUNTIME", lease,
  });
  const route = taskRoute(contract, authority.clock.now());
  const routeResult = authority.store.transactTaskFlow({ type: "SUBMIT_ROUTE_SKELETON", goalId, route, contract }, {
    expectedVersion: contractResult.goalVersion, idempotencyKey: "memory-test:route", actor: "RUNTIME", lease,
  });
  const attestation = sealTaskFlowRecord<EvidenceAttestationRecord, "record_sha256">("PCH-EVIDENCE-ATTESTATION-V1", {
    schema_version: 1, attestation_id: "ATTESTATION-MEMORY-TEST-001", goal_id: goalId,
    work_cell_id: route.work_cells[0]!.work_cell_id, operation_id: null,
    obligation_id: contract.obligations[0]!.obligation_id, oracle_sha256: sha256Hex("memory-test-oracle"),
    input_closure_sha256: sha256Hex("memory-test-input-closure"), output_sha256: sha256Hex("memory-test-output"),
    baseline_sha256: sha256Hex("memory-test-baseline"), environment_sha256: sha256Hex("memory-test-environment"),
    result: "PASS", freshness: "CURRENT", postcondition: "PASS", artifact_id: null,
    created_at_ms: authority.clock.now(),
  }, "record_sha256");
  const attestationResult = authority.store.transactTaskFlow({ type: "ATTEST_EVIDENCE", goalId, attestation }, {
    expectedVersion: routeResult.goalVersion, idempotencyKey: "memory-test:attestation", actor: "RUNTIME", lease,
  });
  const memoryConfig: MemoryEngineConfig = {
    enabled, mode, epoch: `MEMORY-V3-${indexMode}-TEST`, softProjectionTokens: 600,
    hardProjectionTokens: 1200, maxResults: 12, maxPolicyResults: 6, maxEvidenceResults: 4,
    maxExperienceResults: 2, maxStructuredScanRows: 5000, maxPayloadBytes: 1_048_576,
    indexDrainBatch: 128, indexDrainDebounceMs: 50,
  };
  const memory = new MemoryEngine(authority.store, memoryConfig, () => authority.clock.now());
  return {
    ...authority, artifacts: new ArtifactStore(authority.casPath), goalId, lease,
    version: attestationResult.goalVersion, receiptId: attestation.attestation_id, memory, memoryConfig,
    context: (expectedVersion) => ({
      goalId, workspaceId: "WS-TEST-001", workspaceRoot: authority.directory,
      mutation: {
        expectedVersion: attestationResult.goalVersion + expectedVersion - 3,
        idempotencyKey: "memory-test:mutation", actor: "USER", lease,
      },
    }),
  };
}
