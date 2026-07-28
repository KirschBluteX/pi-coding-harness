import { resolve } from "node:path";
import { omitProperty } from "../../src/authority/canonical-json.js";
import { sha256Hex } from "../../src/foundation/crypto.js";
import {
  makeExecutionSubjectRefV2, packetContentSha256, sealHarnessRecord,
  type ExecutionSubjectRefV2, type ExecutionTopology, type ManagedRunRecord,
  type ShardLeaseGenerationRecord, type TaskPacketRecord, type TopologyRevisionRecord,
  type WorkerRole, type WorkerRunRecord, type WorkerRunTransitionRecord, type WorkShardRecord,
} from "../../src/harness/domain.js";
import type { LeaseToken } from "../../src/authority/lease.js";
import { createTestAuthority, type TestAuthority } from "./authority.js";
import {
  taskAdmissionMetadata, taskAuthorization, taskBaseline, taskContract, taskFlowMemoryMigrations, taskRoute,
} from "./task-flow.js";
import { sealTaskFlowRecord, type WorkspaceBaselineRecord } from "../../src/task-flow/domain.js";

export interface HarnessFixture {
  readonly authority: TestAuthority;
  readonly goalId: string;
  readonly lease: LeaseToken;
  readonly contract: ReturnType<typeof taskContract>;
  readonly route: ReturnType<typeof taskRoute>;
  readonly baseline: ReturnType<typeof taskBaseline>;
  readonly authorization: ReturnType<typeof taskAuthorization>;
  readonly run: ManagedRunRecord;
  readonly topology: TopologyRevisionRecord;
  readonly version: number;
}

export const zeroWorkerUsage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: null, turns: 0, wallTimeMs: 0,
} as const;

export function harnessMutation(fixture: Pick<HarnessFixture, "lease">, version: number, key: string) {
  return { expectedVersion: version, idempotencyKey: key, actor: "RUNTIME" as const, lease: fixture.lease };
}

export function createHarnessFixture(
  topology: ExecutionTopology,
  suffix = "001",
  options: { readonly baseDirectory?: string } = {},
): HarnessFixture {
  const authority = createTestAuthority({
    ...(options.baseDirectory === undefined ? {} : { baseDirectory: options.baseDirectory }),
    memoryMigrations: taskFlowMemoryMigrations,
    taskFlowMigrationPath: resolve("schemas", "sql", "011_task_flow_kernel_v1.sql"),
    inputContextMigrationPath: resolve("schemas", "sql", "012_input_context_v1.sql"),
    harnessMigrationPath: resolve("schemas", "sql", "013_coding_harness_v1.sql"),
  });
  const goalId = `GOAL-HARNESS-${suffix}`;
  const admitted = authority.store.transactTaskFlow({
    type: "ADMIT_TASK_FLOW", goalId,
    workspace: { workspaceId: `WS-HARNESS-${suffix}`, workspaceHmac: sha256Hex(`workspace:${suffix}`), filesystemKind: "LOCAL_TEST", localLockingVerified: true },
    originSessionId: `SESSION-HARNESS-${suffix}`, objective: "Produce a verified bounded code change",
    intent: "BUILD", lane: "DIRECT_CELL", sourceIntakeSha256: sha256Hex(`intake:${suffix}`), activationSha256: sha256Hex(`activation:${suffix}`),
    ...taskAdmissionMetadata("DIRECT_CELL"),
  }, { expectedVersion: 0, idempotencyKey: `admit:${suffix}`, actor: "RUNTIME" });
  const lease = authority.store.acquireLease(goalId, `SESSION-HARNESS-${suffix}`, 120_000);
  const contract = taskContract(goalId, authority.clock.now());
  const contractResult = authority.store.transactTaskFlow({ type: "SUBMIT_GOAL_CONTRACT", goalId, contract },
    { expectedVersion: admitted.goalVersion, idempotencyKey: `contract:${suffix}`, actor: "RUNTIME", lease });
  const route = taskRoute(contract, authority.clock.now());
  const routeResult = authority.store.transactTaskFlow({ type: "SUBMIT_ROUTE_SKELETON", goalId, route, contract },
    { expectedVersion: contractResult.goalVersion, idempotencyKey: `route:${suffix}`, actor: "RUNTIME", lease });
  const originalBaseline = taskBaseline(goalId, authority.clock.now());
  const baselineValue = omitProperty(originalBaseline, "record_sha256");
  const finalBaseline = sealTaskFlowRecord<WorkspaceBaselineRecord, "record_sha256">("PCH-WORKSPACE-BASELINE-V1", {
    ...baselineValue, workspace_id: `WS-HARNESS-${suffix}`,
  }, "record_sha256");
  const baselineResult = authority.store.transactTaskFlow({ type: "RECORD_WORKSPACE_BASELINE", goalId, baseline: finalBaseline },
    { expectedVersion: routeResult.goalVersion, idempotencyKey: `baseline:${suffix}`, actor: "RUNTIME", lease });
  const authorization = taskAuthorization(goalId, contract, finalBaseline, lease.generation, lease.fencingToken, authority.clock.now());
  const authorizationResult = authority.store.transactTaskFlow({ type: "AUTHORIZE_WORK_CELL", goalId, authorization },
    { expectedVersion: baselineResult.goalVersion, idempotencyKey: `authorization:${suffix}`, actor: "RUNTIME", lease });
  const run = sealHarnessRecord<ManagedRunRecord, "record_sha256">("PCH-MANAGED-RUN-V1", {
    schema_version: 1, run_id: `RUN-HARNESS-${suffix}`, goal_id: goalId, workspace_id: `WS-HARNESS-${suffix}`,
    created_by_host_hmac: sha256Hex(`host:${suffix}`), initial_config_sha256: sha256Hex(`config:${suffix}`), created_at_ms: authority.clock.now(),
  }, "record_sha256");
  const topologyRecord = sealHarnessRecord<TopologyRevisionRecord, "record_sha256">("PCH-TOPOLOGY-REVISION-V1", {
    schema_version: 1, run_id: run.run_id, revision: 1, requested_topology: topology, effective_topology: topology,
    reason_code: "USER_SELECTED", decision_sha256: sha256Hex(`topology-decision:${suffix}`), config_sha256: run.initial_config_sha256,
    created_at_ms: authority.clock.now(),
  }, "record_sha256");
  const runResult = authority.store.transactHarness({ type: "CREATE_MANAGED_RUN", goalId, run, topology: topologyRecord },
    { expectedVersion: authorizationResult.goalVersion, idempotencyKey: `run:${suffix}`, actor: "RUNTIME", lease });
  return { authority, goalId, lease, contract, route, baseline: finalBaseline, authorization, run, topology: topologyRecord, version: runResult.goalVersion };
}

export function workShard(
  fixture: HarnessFixture,
  input: { readonly id: string; readonly ordinal: number; readonly role: "SUPERVISOR" | WorkerRole; readonly dependencies?: readonly string[]; readonly writeRoots?: readonly string[] },
): WorkShardRecord {
  return sealHarnessRecord<WorkShardRecord, "spec_sha256">("PCH-WORK-SHARD-V1", {
    schema_version: 1, shard_id: input.id, run_id: fixture.run.run_id, goal_id: fixture.goalId,
    work_cell_id: fixture.route.work_cells[0]!.work_cell_id, logical_key: input.id.toLowerCase(), ordinal: input.ordinal,
    role: input.role, outcome: `${input.role} completes its bounded outcome`, dependencies: input.dependencies ?? [],
    read_roots: ["src"], write_roots: input.writeRoots ?? [], oracle: { command: "npm test" }, packet_budget: { max_attempts: 2 },
  }, "spec_sha256");
}

export function workerDispatch(
  fixture: HarnessFixture,
  shard: WorkShardRecord,
  attempt = 1,
): { readonly subject: ExecutionSubjectRefV2; readonly packet: TaskPacketRecord; readonly lease: ShardLeaseGenerationRecord } {
  const subject = makeExecutionSubjectRefV2({
    kind: "WORK_SHARD", run_id: fixture.run.run_id, goal_id: fixture.goalId, work_cell_id: shard.work_cell_id,
    shard_id: shard.shard_id, worker_run_id: null, role: shard.role, topology_revision: fixture.topology.revision, attempt,
    goal_contract_sha256: fixture.contract.record_sha256, route_sha256: fixture.route.record_sha256,
    authorization_sha256: fixture.authorization.record_sha256,
  });
  const content = {
    schema_version: 1 as const, packet_id: `PACKET-${shard.shard_id}-${attempt}`, run_id: fixture.run.run_id, shard_id: shard.shard_id, attempt,
    subject_binding_sha256: subject.binding_sha256, task: shard.outcome, goal_contract_sha256: fixture.contract.record_sha256,
    route_sha256: fixture.route.record_sha256, work_cell_sha256: fixture.route.work_cells[0]!.spec_sha256,
    evidence_refs: [], shared_memory: null, failure_signatures: [], expires_at_ms: fixture.authority.clock.now() + 60_000,
  };
  const packet: TaskPacketRecord = { ...content, packet_sha256: packetContentSha256(content), capability_hmac: sha256Hex(`capability:${shard.shard_id}:${attempt}`) };
  const lease = sealHarnessRecord<ShardLeaseGenerationRecord, "lease_sha256">("PCH-SHARD-LEASE-V1", {
    schema_version: 1, shard_id: shard.shard_id, generation: attempt, fencing_token: attempt,
    owner_hmac: sha256Hex(`worker-owner:${shard.shard_id}:${attempt}`), expires_at_ms: packet.expires_at_ms,
  }, "lease_sha256");
  return { subject, packet, lease };
}

export function workerStart(
  fixture: HarnessFixture,
  shard: WorkShardRecord,
  dispatch: ReturnType<typeof workerDispatch>,
  sandbox: WorkerRunRecord["sandbox_kind"],
): { readonly worker: WorkerRunRecord; readonly subject: ExecutionSubjectRefV2; readonly transition: WorkerRunTransitionRecord } {
  const worker = sealHarnessRecord<WorkerRunRecord, "record_sha256">("PCH-WORKER-RUN-V1", {
    schema_version: 1, worker_run_id: `WORKER-${shard.shard_id}-${dispatch.packet.attempt}`, run_id: fixture.run.run_id,
    shard_id: shard.shard_id, packet_id: dispatch.packet.packet_id, role: shard.role as WorkerRole, attempt: dispatch.packet.attempt,
    lease_generation: dispatch.lease.generation, fencing_token: dispatch.lease.fencing_token, sandbox_kind: sandbox,
    model_fingerprint_hmac: sha256Hex("user-configured-model"), created_at_ms: fixture.authority.clock.now(),
  }, "record_sha256");
  const subject = makeExecutionSubjectRefV2({
    ...dispatch.subject, kind: "WORKER_RUN", worker_run_id: worker.worker_run_id, role: worker.role,
  });
  const transition = sealHarnessRecord<WorkerRunTransitionRecord, "transition_sha256">("PCH-WORKER-TRANSITION-V1", {
    schema_version: 1, transition_id: `WTRANS-${shard.shard_id}-${dispatch.packet.attempt}-0`, worker_run_id: worker.worker_run_id, ordinal: 0,
    state: "STARTING", output_sha256: null, usage: zeroWorkerUsage, failure_signature_sha256: null,
    predecessor_sha256: null, created_at_ms: fixture.authority.clock.now(),
  }, "transition_sha256");
  return { worker, subject, transition };
}

export function workerTransition(
  fixture: HarnessFixture,
  worker: WorkerRunRecord,
  ordinal: number,
  state: WorkerRunTransitionRecord["state"],
  predecessor: string,
  outputSha256: string | null = null,
): WorkerRunTransitionRecord {
  return sealHarnessRecord<WorkerRunTransitionRecord, "transition_sha256">("PCH-WORKER-TRANSITION-V1", {
    schema_version: 1, transition_id: `WTRANS-${worker.shard_id}-${worker.attempt}-${ordinal}`, worker_run_id: worker.worker_run_id, ordinal, state,
    output_sha256: outputSha256, usage: zeroWorkerUsage, failure_signature_sha256: state === "FAILED" ? sha256Hex("worker-failure") : null,
    predecessor_sha256: predecessor, created_at_ms: fixture.authority.clock.now(),
  }, "transition_sha256");
}
