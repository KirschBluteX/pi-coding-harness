import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore, type ArtifactRecord } from "../../src/artifacts/artifact-store.js";
import { omitProperty } from "../../src/authority/canonical-json.js";
import { AuthorityStore } from "../../src/authority/transactions.js";
import { sha256Hex } from "../../src/foundation/crypto.js";
import {
  sealHarnessRecord, type IntegrationReceiptRecord, type PatchSetRecord, type WorkerResultRecord,
} from "../../src/harness/domain.js";
import {
  sealTaskFlowRecord, type OperationAttemptRecord, type OperationTransitionRecord,
} from "../../src/task-flow/domain.js";
import { taskFlowMemoryMigrations } from "../helpers/task-flow.js";
import {
  createHarnessFixture, harnessMutation, workerDispatch, workerStart, workerTransition, workShard,
  type HarnessFixture,
} from "../helpers/harness.js";

const fixtures: HarnessFixture[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.authority.close(); });

function artifactMetadata(record: ArtifactRecord): Omit<ArtifactRecord, "created"> {
  return omitProperty(record, "created");
}

describe("Pi Coding Harness authority", () => {
  it("requires dependency ordering for shards whose read/write scopes overlap", () => {
    const fixture = createHarnessFixture("MULTI", "SCOPE-ORDER"); fixtures.push(fixture);
    const first = workShard(fixture, { id: "SHARD-SCOPE-A", ordinal: 0, role: "IMPLEMENTER", writeRoots: ["src/example.ts"] });
    const conflicting = workShard(fixture, { id: "SHARD-SCOPE-B", ordinal: 1, role: "VERIFIER" });
    expect(() => fixture.authority.store.transactHarness({
      type: "DEFINE_WORK_SHARDS", goalId: fixture.goalId, runId: fixture.run.run_id,
      workCellId: first.work_cell_id, shards: [first, conflicting],
    }, harnessMutation(fixture, fixture.version, "scope:unordered"))).toThrow("require an explicit dependency");
    expect(fixture.authority.store.readHarnessView(fixture.goalId)?.shards).toEqual([]);

    const ordered = workShard(fixture, {
      id: "SHARD-SCOPE-B", ordinal: 1, role: "VERIFIER", dependencies: [first.shard_id],
    });
    fixture.authority.store.transactHarness({
      type: "DEFINE_WORK_SHARDS", goalId: fixture.goalId, runId: fixture.run.run_id,
      workCellId: first.work_cell_id, shards: [first, ordered],
    }, harnessMutation(fixture, fixture.version, "scope:ordered"));
    expect(fixture.authority.store.readHarnessView(fixture.goalId)?.shards).toMatchObject([
      { shardId: first.shard_id, status: "READY" }, { shardId: ordered.shard_id, status: "PROPOSED" },
    ]);
  }, 15_000);

  it("keeps SINGLE direct and rejects hidden Supervisor WorkShards", () => {
    const fixture = createHarnessFixture("SINGLE", "SINGLE"); fixtures.push(fixture);
    const shard = workShard(fixture, { id: "SHARD-SINGLE-001", ordinal: 0, role: "SUPERVISOR", writeRoots: ["src/example.ts"] });
    expect(() => fixture.authority.store.transactHarness({
      type: "DEFINE_WORK_SHARDS", goalId: fixture.goalId, runId: fixture.run.run_id,
      workCellId: shard.work_cell_id, shards: [shard],
    }, harnessMutation(fixture, fixture.version, "single:define"))).toThrow("cannot define WorkShards");
    expect(fixture.authority.store.readHarnessView(fixture.goalId)).toMatchObject({
      runId: fixture.run.run_id, effectiveTopology: "SINGLE", unresolvedWorkerRunIds: [],
      shards: [],
    });
    expect(fixture.authority.store.verifyHarnessIntegrity()).toMatchObject({ available: true, runs: 1, shards: 0, workerRuns: 0, headMismatches: 0 });
  });

  it("runs MULTI worker packets through CAS results and deterministic canonical integration", () => {
    const fixture = createHarnessFixture("MULTI", "MULTI"); fixtures.push(fixture);
    const explorer = workShard(fixture, { id: "SHARD-EXPLORER-001", ordinal: 0, role: "EXPLORER" });
    const implementer = workShard(fixture, {
      id: "SHARD-IMPLEMENTER-001", ordinal: 1, role: "IMPLEMENTER", dependencies: [explorer.shard_id], writeRoots: ["src/example.ts"],
    });
    let version = fixture.authority.store.transactHarness({
      type: "DEFINE_WORK_SHARDS", goalId: fixture.goalId, runId: fixture.run.run_id,
      workCellId: explorer.work_cell_id, shards: [implementer, explorer],
    }, harnessMutation(fixture, fixture.version, "multi:define")).goalVersion;
    expect(fixture.authority.store.readHarnessView(fixture.goalId)?.shards).toMatchObject([
      { shardId: explorer.shard_id, status: "READY" }, { shardId: implementer.shard_id, status: "PROPOSED" },
    ]);

    const explorerDispatch = workerDispatch(fixture, explorer);
    version = fixture.authority.store.transactHarness({ type: "LEASE_WORK_SHARD", goalId: fixture.goalId, ...explorerDispatch },
      harnessMutation(fixture, version, "multi:explorer:lease")).goalVersion;
    const explorerStart = workerStart(fixture, explorer, explorerDispatch, "NONE_READ_ONLY");
    version = fixture.authority.store.transactHarness({ type: "START_WORKER_RUN", goalId: fixture.goalId, ...explorerStart },
      harnessMutation(fixture, version, "multi:explorer:start")).goalVersion;
    const explorerRunning = workerTransition(fixture, explorerStart.worker, 1, "RUNNING", explorerStart.transition.transition_sha256);
    version = fixture.authority.store.transactHarness({ type: "TRANSITION_WORKER_RUN", goalId: fixture.goalId, transition: explorerRunning },
      harnessMutation(fixture, version, "multi:explorer:running")).goalVersion;
    const artifacts = new ArtifactStore(fixture.authority.casPath);
    const explorerArtifact = artifacts.put("bounded analysis", { mediaType: "text/plain", classification: "INTERNAL", retentionClass: "GOAL" });
    const explorerResult = sealHarnessRecord<WorkerResultRecord, "record_sha256">("PCH-WORKER-RESULT-V1", {
      schema_version: 1, result_id: "RESULT-EXPLORER-001", worker_run_id: explorerStart.worker.worker_run_id,
      run_id: fixture.run.run_id, shard_id: explorer.shard_id, result_kind: "ANALYSIS",
      artifact_sha256: explorerArtifact.sha256, artifact_locator_hmac: sha256Hex(explorerArtifact.locator), trust: "UNVERIFIED",
      created_at_ms: fixture.authority.clock.now(),
    }, "record_sha256");
    const explorerSucceeded = workerTransition(fixture, explorerStart.worker, 2, "SUCCEEDED", explorerRunning.transition_sha256, explorerArtifact.sha256);
    version = fixture.authority.store.transactHarness({
      type: "SUBMIT_WORKER_RESULT", goalId: fixture.goalId, result: explorerResult, transition: explorerSucceeded,
      patchSet: null, artifacts: [artifactMetadata(explorerArtifact)],
    }, harnessMutation(fixture, version, "multi:explorer:result")).goalVersion;
    const explorerIntegration = sealHarnessRecord<IntegrationReceiptRecord, "receipt_sha256">("PCH-INTEGRATION-RECEIPT-V1", {
      schema_version: 1, integration_id: "INTEGRATION-EXPLORER-001", run_id: fixture.run.run_id, shard_id: explorer.shard_id,
      patch_set_id: null, transaction_journal_sha256: null, result: "NO_CHANGES", preimage_root_sha256: fixture.baseline.content_root_sha256,
      postimage_root_sha256: fixture.baseline.content_root_sha256, conflict_paths: [], operation_ids: [], created_at_ms: fixture.authority.clock.now(),
    }, "receipt_sha256");
    version = fixture.authority.store.transactHarness({ type: "RECORD_HARNESS_INTEGRATION", goalId: fixture.goalId, receipt: explorerIntegration },
      harnessMutation(fixture, version, "multi:explorer:integrate")).goalVersion;
    expect(fixture.authority.store.readHarnessView(fixture.goalId)?.nextReadyShardId).toBe(implementer.shard_id);

    const implementerDispatch = workerDispatch(fixture, implementer);
    version = fixture.authority.store.transactHarness({ type: "LEASE_WORK_SHARD", goalId: fixture.goalId, ...implementerDispatch },
      harnessMutation(fixture, version, "multi:implementer:lease")).goalVersion;
    const implementerStart = workerStart(fixture, implementer, implementerDispatch, "SCOPED_MIRROR");
    version = fixture.authority.store.transactHarness({ type: "START_WORKER_RUN", goalId: fixture.goalId, ...implementerStart },
      harnessMutation(fixture, version, "multi:implementer:start")).goalVersion;
    const implementerRunning = workerTransition(fixture, implementerStart.worker, 1, "RUNNING", implementerStart.transition.transition_sha256);
    version = fixture.authority.store.transactHarness({ type: "TRANSITION_WORKER_RUN", goalId: fixture.goalId, transition: implementerRunning },
      harnessMutation(fixture, version, "multi:implementer:running")).goalVersion;
    const fileArtifact = artifacts.put("export const value = 1;\n", { mediaType: "text/typescript", classification: "INTERNAL", retentionClass: "GOAL" });
    const manifestArtifact = artifacts.put("patch manifest", { mediaType: "text/plain", classification: "INTERNAL", retentionClass: "GOAL" });
    const patchSet = sealHarnessRecord<PatchSetRecord, "patch_sha256">("PCH-PATCH-SET-V1", {
      schema_version: 1, patch_set_id: "PATCH-IMPLEMENTER-001", run_id: fixture.run.run_id, shard_id: implementer.shard_id,
      worker_run_id: implementerStart.worker.worker_run_id, baseline_sha256: fixture.baseline.record_sha256,
      entries: [{ operation: "MODIFY", path: "src/example.ts", before_sha256: sha256Hex("old file"), after_sha256: fileArtifact.sha256, content_locator: fileArtifact.locator, byte_length: fileArtifact.byteLength }],
      created_at_ms: fixture.authority.clock.now(),
    }, "patch_sha256");
    const implementerResult = sealHarnessRecord<WorkerResultRecord, "record_sha256">("PCH-WORKER-RESULT-V1", {
      schema_version: 1, result_id: "RESULT-IMPLEMENTER-001", worker_run_id: implementerStart.worker.worker_run_id,
      run_id: fixture.run.run_id, shard_id: implementer.shard_id, result_kind: "PATCH",
      artifact_sha256: manifestArtifact.sha256, artifact_locator_hmac: sha256Hex(manifestArtifact.locator), trust: "UNVERIFIED",
      created_at_ms: fixture.authority.clock.now(),
    }, "record_sha256");
    const implementerSucceeded = workerTransition(fixture, implementerStart.worker, 2, "SUCCEEDED", implementerRunning.transition_sha256, manifestArtifact.sha256);
    version = fixture.authority.store.transactHarness({
      type: "SUBMIT_WORKER_RESULT", goalId: fixture.goalId, result: implementerResult, transition: implementerSucceeded,
      patchSet, artifacts: [artifactMetadata(manifestArtifact), artifactMetadata(fileArtifact)],
    }, harnessMutation(fixture, version, "multi:implementer:result")).goalVersion;
    const journalArtifact = artifacts.put("prepared patch transaction", {
      mediaType: "application/vnd.pch.patch-transaction+json", classification: "INTERNAL", retentionClass: "GOAL",
    });
    version = fixture.authority.store.transactHarness({
      type: "PREPARE_PATCH_TRANSACTION", goalId: fixture.goalId, runId: fixture.run.run_id,
      shardId: implementer.shard_id, patchSetId: patchSet.patch_set_id,
      journalSha256: journalArtifact.sha256, journalArtifact: artifactMetadata(journalArtifact), preimageArtifacts: [],
    }, harnessMutation(fixture, version, "multi:implementer:prepare-patch-transaction")).goalVersion;

    const attempt = sealTaskFlowRecord<OperationAttemptRecord, "record_sha256">("PCH-OPERATION-ATTEMPT-V1", {
      schema_version: 1, attempt_id: "ATTEMPT-INTEGRATION-001", operation_id: "OPERATION-INTEGRATION-001", goal_id: fixture.goalId,
      work_cell_id: implementer.work_cell_id, authorization_id: fixture.authorization.authorization_id, attempt_number: 1,
      operation_kind: "WRITE", normalized_target_hmac: sha256Hex("src/example.ts"), normalized_payload_sha256: fileArtifact.sha256,
      execution_fingerprint_sha256: sha256Hex("deterministic-integrator"), baseline_sha256: fixture.baseline.record_sha256,
      environment_sha256: fixture.baseline.environment_sha256, oracle_sha256: fixture.baseline.oracle_set_sha256,
      idempotency_key_hmac: sha256Hex("integration-operation"), created_at_ms: fixture.authority.clock.now(),
    }, "record_sha256");
    const prepared = sealTaskFlowRecord<OperationTransitionRecord, "transition_sha256">("PCH-OPERATION-TRANSITION-V1", {
      schema_version: 1, transition_id: "TRANSITION-INTEGRATION-000", attempt_id: attempt.attempt_id, ordinal: 0,
      state: "PREPARED", output_sha256: null, readback_sha256: null, failure_signature_sha256: null,
      postcondition: "UNKNOWN", predecessor_sha256: null, created_at_ms: fixture.authority.clock.now(),
    }, "transition_sha256");
    version = fixture.authority.store.transactTaskFlow({ type: "PREPARE_OPERATION", goalId: fixture.goalId, attempt, prepared, reconcileLocator: null },
      harnessMutation(fixture, version, "multi:integration:prepare")).goalVersion;
    let predecessor = prepared.transition_sha256;
    for (const [ordinal, state] of [[1, "DISPATCHED"], [2, "OBSERVED"], [3, "COMMITTED"]] as const) {
      const transition = sealTaskFlowRecord<OperationTransitionRecord, "transition_sha256">("PCH-OPERATION-TRANSITION-V1", {
        schema_version: 1, transition_id: `TRANSITION-INTEGRATION-00${ordinal}`, attempt_id: attempt.attempt_id, ordinal, state,
        output_sha256: state === "COMMITTED" ? fileArtifact.sha256 : null,
        readback_sha256: state === "OBSERVED" || state === "COMMITTED" ? fileArtifact.sha256 : null,
        failure_signature_sha256: null, postcondition: state === "COMMITTED" ? "PASS" : "UNKNOWN",
        predecessor_sha256: predecessor, created_at_ms: fixture.authority.clock.now(),
      }, "transition_sha256");
      version = fixture.authority.store.transactTaskFlow({ type: "TRANSITION_OPERATION", goalId: fixture.goalId, transition },
        harnessMutation(fixture, version, `multi:integration:${state.toLowerCase()}`)).goalVersion;
      predecessor = transition.transition_sha256;
    }
    const integration = sealHarnessRecord<IntegrationReceiptRecord, "receipt_sha256">("PCH-INTEGRATION-RECEIPT-V1", {
      schema_version: 1, integration_id: "INTEGRATION-IMPLEMENTER-001", run_id: fixture.run.run_id, shard_id: implementer.shard_id,
      patch_set_id: patchSet.patch_set_id, transaction_journal_sha256: journalArtifact.sha256,
      result: "APPLIED", preimage_root_sha256: fixture.baseline.content_root_sha256,
      postimage_root_sha256: sha256Hex("postimage-root"), conflict_paths: [], operation_ids: [attempt.operation_id], created_at_ms: fixture.authority.clock.now(),
    }, "receipt_sha256");
    fixture.authority.store.transactHarness({ type: "RECORD_HARNESS_INTEGRATION", goalId: fixture.goalId, receipt: integration },
      harnessMutation(fixture, version, "multi:implementer:integrate"));
    expect(fixture.authority.store.readHarnessView(fixture.goalId)).toMatchObject({
      effectiveTopology: "MULTI", unresolvedWorkerRunIds: [], nextReadyShardId: null,
      shards: [{ shardId: explorer.shard_id, status: "SUCCEEDED" }, { shardId: implementer.shard_id, status: "SUCCEEDED" }],
    });
    expect(fixture.authority.store.verifyHarnessIntegrity()).toMatchObject({ runs: 1, shards: 2, workerRuns: 2, integrations: 2, leaseMismatches: 0 });

    const reopened = AuthorityStore.open({
      databasePath: fixture.authority.databasePath, migrationPath: resolve("schemas", "sql", "001_core.sql"),
      memoryMigrations: taskFlowMemoryMigrations, taskFlowMigrationPath: resolve("schemas", "sql", "011_task_flow_kernel_v1.sql"),
      inputContextMigrationPath: resolve("schemas", "sql", "012_input_context_v1.sql"), harnessMigrationPath: resolve("schemas", "sql", "013_coding_harness_v1.sql"),
      clock: fixture.authority.clock,
    });
    try { expect(reopened.readHarnessView(fixture.goalId)?.unresolvedWorkerRunIds).toEqual([]); }
    finally { reopened.close(); }
  });

  it("rolls back Harness domain, event, outbox and receipt at every fault boundary", () => {
    const fixture = createHarnessFixture("MULTI", "FAULT"); fixtures.push(fixture);
    const shard = workShard(fixture, { id: "SHARD-FAULT-001", ordinal: 0, role: "IMPLEMENTER" });
    const command = { type: "DEFINE_WORK_SHARDS" as const, goalId: fixture.goalId, runId: fixture.run.run_id, workCellId: shard.work_cell_id, shards: [shard] };
    for (const point of ["after-domain-write", "after-event-write", "after-outbox-write", "after-receipt-write", "before-commit"] as const) {
      expect(() => fixture.authority.store.transactHarness(command, harnessMutation(fixture, fixture.version, `fault:${point}`), (current) => {
        if (current === point) throw new Error(`FAULT:${point}`);
      })).toThrow(`FAULT:${point}`);
      expect(fixture.authority.store.readHarnessView(fixture.goalId)?.shards).toEqual([]);
    }
    const committed = fixture.authority.store.transactHarness(command, harnessMutation(fixture, fixture.version, "fault:commit"));
    expect(fixture.authority.store.transactHarness(command, harnessMutation(fixture, fixture.version, "fault:commit"))).toEqual({ ...committed, reused: true });
  });

  it("fences a worker that returns after its persisted lease expires", () => {
    const fixture = createHarnessFixture("MULTI", "FENCE"); fixtures.push(fixture);
    const shard = workShard(fixture, { id: "SHARD-FENCE-001", ordinal: 0, role: "EXPLORER" });
    let version = fixture.authority.store.transactHarness({
      type: "DEFINE_WORK_SHARDS", goalId: fixture.goalId, runId: fixture.run.run_id, workCellId: shard.work_cell_id, shards: [shard],
    }, harnessMutation(fixture, fixture.version, "fence:define")).goalVersion;
    const dispatch = workerDispatch(fixture, shard);
    version = fixture.authority.store.transactHarness({ type: "LEASE_WORK_SHARD", goalId: fixture.goalId, ...dispatch }, harnessMutation(fixture, version, "fence:lease")).goalVersion;
    const start = workerStart(fixture, shard, dispatch, "NONE_READ_ONLY");
    version = fixture.authority.store.transactHarness({ type: "START_WORKER_RUN", goalId: fixture.goalId, ...start }, harnessMutation(fixture, version, "fence:start")).goalVersion;
    const running = workerTransition(fixture, start.worker, 1, "RUNNING", start.transition.transition_sha256);
    version = fixture.authority.store.transactHarness({ type: "TRANSITION_WORKER_RUN", goalId: fixture.goalId, transition: running }, harnessMutation(fixture, version, "fence:running")).goalVersion;
    fixture.authority.clock.advance(60_001);
    const fenced = workerTransition(fixture, start.worker, 2, "FENCED", running.transition_sha256);
    fixture.authority.store.transactHarness({ type: "TRANSITION_WORKER_RUN", goalId: fixture.goalId, transition: fenced }, harnessMutation(fixture, version, "fence:terminal"));
    expect(fixture.authority.store.readHarnessView(fixture.goalId)).toMatchObject({
      unresolvedWorkerRunIds: [], shards: [{ shardId: shard.shard_id, status: "FAILED" }],
    });
  });
});
