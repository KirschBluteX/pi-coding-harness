import type { AuthorityConnection } from "../authority/database.js";
import { canonicalJson } from "../authority/canonical-json.js";
import { AuthorityIntegrityError } from "../foundation/errors.js";
import { registerArtifact, type ArtifactMetadata } from "../authority/repositories/common.js";
import {
  assertExecutionSubjectRefV2,
  assertIntegrationReceipt,
  assertManagedRun,
  assertMemoryVisibilityBinding,
  assertPatchSet,
  assertShardLease,
  assertTaskPacket,
  assertTopologyRevision,
  assertWorkerResult,
  assertWorkerRun,
  assertWorkerTransition,
  assertWorkShard,
  type ExecutionSubjectRefV2,
  type IntegrationReceiptRecord,
  type ManagedRunRecord,
  type ManagedRunStatus,
  type MemoryVisibilityBindingRecord,
  type PatchSetRecord,
  type ShardLeaseGenerationRecord,
  type TaskPacketRecord,
  type TopologyRevisionRecord,
  type WorkerResultRecord,
  type WorkerRunRecord,
  type WorkerRunState,
  type WorkerRunTransitionRecord,
  type WorkShardRecord,
  type WorkShardStatus,
} from "./domain.js";

interface RunHeadRow {
  readonly run_id: string;
  readonly goal_id: string;
  readonly workspace_id: string;
  readonly requested_topology: "SINGLE" | "MULTI";
  readonly effective_topology: "SINGLE" | "MULTI";
  readonly topology_revision: number;
  readonly status: ManagedRunStatus;
}

interface ShardHeadRow {
  readonly shard_id: string;
  readonly run_id: string;
  readonly goal_id: string;
  readonly work_cell_id: string;
  readonly role: WorkShardRecord["role"];
  readonly packet_budget_json: string;
  readonly status: WorkShardStatus;
  readonly attempt_count: number;
  readonly latest_worker_run_id: string | null;
  readonly result_sha256: string | null;
}

export interface HarnessShardView {
  readonly shardId: string;
  readonly workCellId: string;
  readonly role: WorkShardRecord["role"];
  readonly status: WorkShardStatus;
  readonly attemptCount: number;
  readonly latestWorkerRunId: string | null;
  readonly resultSha256: string | null;
}

export interface HarnessCurrentView {
  readonly runId: string;
  readonly goalId: string;
  readonly workspaceId: string;
  readonly requestedTopology: "SINGLE" | "MULTI";
  readonly effectiveTopology: "SINGLE" | "MULTI";
  readonly topologyRevision: number;
  readonly status: ManagedRunStatus;
  readonly nextReadyShardId: string | null;
  readonly unresolvedWorkerRunIds: readonly string[];
  readonly shards: readonly HarnessShardView[];
}

export interface ActiveManagedRunRef {
  readonly runId: string;
  readonly goalId: string;
  readonly status: ManagedRunStatus;
  readonly taskFlowTerminalStatus: "SUCCEEDED" | "FAILED" | "CANCELED" | null;
}

export interface HarnessShardExecutionView {
  readonly spec: WorkShardRecord;
  readonly status: WorkShardStatus;
  readonly attemptCount: number;
  readonly latestWorkerRunId: string | null;
  readonly resultSha256: string | null;
  readonly latestLeaseGeneration: number;
  readonly latestFencingToken: number;
  readonly dependencyEvidence: readonly HarnessDependencyEvidence[];
}

export interface HarnessDependencyEvidence {
  readonly shardId: string;
  readonly role: WorkShardRecord["role"];
  readonly resultKind: WorkerResultRecord["result_kind"];
  readonly artifactSha256: string;
  readonly trust: WorkerResultRecord["trust"];
}

export interface HarnessIntegritySummary {
  readonly available: boolean;
  readonly runs: number;
  readonly topologyRevisions: number;
  readonly shards: number;
  readonly workerRuns: number;
  readonly integrations: number;
  readonly patchTransactions: number;
  readonly openPatchTransactions: number;
  readonly headMismatches: number;
  readonly leaseMismatches: number;
  readonly dependencyMismatches: number;
  readonly patchTransactionMismatches: number;
}

export interface HarnessWorkerRecoveryView {
  readonly workerRunId: string;
  readonly runId: string;
  readonly shardId: string;
  readonly attempt: number;
  readonly state: "STARTING" | "RUNNING";
  readonly ordinal: number;
  readonly transitionSha256: string;
}

export interface OpenPatchTransactionView {
  readonly patchSetId: string;
  readonly patchSha256: string;
  readonly runId: string;
  readonly shardId: string;
  readonly journalSha256: string;
  readonly journalLocator: string;
  readonly preimageRootSha256: string;
  readonly affectedPaths: readonly string[];
}

function tableExists(connection: AuthorityConnection, table: string): boolean {
  const row = connection.prepare("SELECT count(*) count FROM sqlite_master WHERE type='table' AND name=?").get(table) as { count?: unknown } | undefined;
  return Number(row?.count ?? 0) === 1;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new AuthorityIntegrityError(`${label} is invalid`);
  return value;
}

function sha(value: unknown, label: string): string {
  const result = text(value, label);
  if (!/^[a-f0-9]{64}$/u.test(result)) throw new AuthorityIntegrityError(`${label} is invalid`);
  return result;
}

function integer(value: unknown, label: string, minimum = 0): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum) throw new AuthorityIntegrityError(`${label} is invalid`);
  return result;
}

function rootsOverlap(left: string, right: string): boolean {
  return left === "." || right === "." || left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function graphReaches(graph: ReadonlyMap<string, readonly string[]>, from: string, target: string): boolean {
  const pending = [...(graph.get(from) ?? [])];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === target) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    pending.push(...(graph.get(current) ?? []));
  }
  return false;
}

function parseJson<T>(value: unknown, label: string): T {
  if (typeof value !== "string") throw new AuthorityIntegrityError(`${label} is not JSON text`);
  try { return JSON.parse(value) as T; }
  catch (error) { throw new AuthorityIntegrityError(`${label} is invalid JSON`, error); }
}

function normalizedRoot(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/+$/u, "").toLowerCase();
}

function containedByAny(candidate: string, allowed: readonly string[]): boolean {
  const normalized = normalizedRoot(candidate);
  return allowed.some((root) => {
    const parent = normalizedRoot(root);
    return parent === "." || parent === "" || normalized === parent || normalized.startsWith(`${parent}/`);
  });
}

function assertAcyclic(shards: ReadonlyMap<string, readonly string[]>): void {
  const state = new Map<string, 0 | 1 | 2>();
  const visit = (id: string): void => {
    const current = state.get(id) ?? 0;
    if (current === 1) throw new AuthorityIntegrityError("WorkShard dependency graph contains a cycle");
    if (current === 2) return;
    state.set(id, 1);
    for (const dependency of shards.get(id) ?? []) visit(dependency);
    state.set(id, 2);
  };
  for (const id of shards.keys()) visit(id);
}

const terminalWorkerStates: readonly WorkerRunState[] = ["SUCCEEDED", "FAILED", "ABORTED", "TIMED_OUT", "FENCED"];

export class HarnessRepository {
  constructor(private readonly connection: AuthorityConnection) {}

  available(): boolean {
    return tableExists(this.connection, "managed_runs_v1")
      && tableExists(this.connection, "work_shards_v1")
      && tableExists(this.connection, "worker_run_transitions_v1");
  }

  private assertAvailable(): void {
    if (!this.available()) throw new AuthorityIntegrityError("Pi Coding Harness migration 013 is not available");
  }

  private runHead(runId: string): RunHeadRow {
    this.assertAvailable();
    const row = this.connection.prepare(`SELECT r.run_id,r.goal_id,r.workspace_id,h.requested_topology,
      h.effective_topology,h.topology_revision,h.status
      FROM managed_runs_v1 r JOIN managed_run_heads_v1 h ON h.run_id=r.run_id WHERE r.run_id=?`).get(runId) as Record<string, unknown> | undefined;
    if (!row) throw new AuthorityIntegrityError(`ManagedRun ${runId} does not exist`);
    return {
      run_id: text(row.run_id, "run_id"), goal_id: text(row.goal_id, "goal_id"), workspace_id: text(row.workspace_id, "workspace_id"),
      requested_topology: text(row.requested_topology, "requested_topology") as RunHeadRow["requested_topology"],
      effective_topology: text(row.effective_topology, "effective_topology") as RunHeadRow["effective_topology"],
      topology_revision: integer(row.topology_revision, "topology_revision", 1), status: text(row.status, "status") as ManagedRunStatus,
    };
  }

  private shardHead(shardId: string): ShardHeadRow {
    const row = this.connection.prepare(`SELECT s.shard_id,s.run_id,s.goal_id,s.work_cell_id,s.role,s.packet_budget_json,
      h.status,h.attempt_count,h.latest_worker_run_id,h.result_sha256
      FROM work_shards_v1 s JOIN work_shard_heads_v1 h ON h.shard_id=s.shard_id WHERE s.shard_id=?`).get(shardId) as Record<string, unknown> | undefined;
    if (!row) throw new AuthorityIntegrityError(`WorkShard ${shardId} does not exist`);
    return {
      shard_id: text(row.shard_id, "shard_id"), run_id: text(row.run_id, "run_id"), goal_id: text(row.goal_id, "goal_id"),
      work_cell_id: text(row.work_cell_id, "work_cell_id"), role: text(row.role, "role") as WorkShardRecord["role"],
      packet_budget_json: text(row.packet_budget_json, "packet_budget_json"), status: text(row.status, "status") as WorkShardStatus,
      attempt_count: integer(row.attempt_count, "attempt_count"),
      latest_worker_run_id: row.latest_worker_run_id === null ? null : text(row.latest_worker_run_id, "latest_worker_run_id"),
      result_sha256: row.result_sha256 === null ? null : sha(row.result_sha256, "result_sha256"),
    };
  }

  createRun(run: ManagedRunRecord, topology: TopologyRevisionRecord, eventSequence: number): void {
    this.assertAvailable(); assertManagedRun(run); assertTopologyRevision(topology);
    if (topology.run_id !== run.run_id || topology.revision !== 1 || topology.config_sha256 !== run.initial_config_sha256) {
      throw new AuthorityIntegrityError("Initial topology does not bind the ManagedRun creation record");
    }
    const goal = this.connection.prepare(`SELECT g.workspace_id,h.status FROM goals g
      JOIN task_flow_goal_heads_v1 h ON h.goal_id=g.goal_id WHERE g.goal_id=?`).get(run.goal_id) as Record<string, unknown> | undefined;
    if (!goal || goal.workspace_id !== run.workspace_id || ["SUCCEEDED", "FAILED", "CANCELED"].includes(String(goal.status))) {
      throw new AuthorityIntegrityError("ManagedRun requires the matching non-terminal Task Flow Goal");
    }
    const owner = this.connection.prepare(`SELECT r.run_id FROM managed_runs_v1 r JOIN managed_run_heads_v1 h ON h.run_id=r.run_id
      WHERE r.workspace_id=? AND h.status NOT IN ('SUCCEEDED','FAILED','CANCELED') LIMIT 1`).get(run.workspace_id) as { run_id?: unknown } | undefined;
    if (owner?.run_id !== undefined) throw new AuthorityIntegrityError(`Workspace already has active ManagedRun ${text(owner.run_id, "run_id")}`);
    this.connection.prepare(`INSERT INTO managed_runs_v1(run_id,goal_id,workspace_id,created_by_host_hmac,initial_config_sha256,
      record_sha256,created_at_ms,created_event_sequence) VALUES(?,?,?,?,?,?,?,?)`).run(
      run.run_id, run.goal_id, run.workspace_id, run.created_by_host_hmac, run.initial_config_sha256,
      run.record_sha256, run.created_at_ms, eventSequence,
    );
    this.connection.prepare(`INSERT INTO managed_run_heads_v1(run_id,requested_topology,effective_topology,topology_revision,status,updated_event_sequence)
      VALUES(?,?,?,?,?,?)`).run(run.run_id, topology.requested_topology, topology.effective_topology, 1, "ACTIVE", eventSequence);
    this.insertTopologyRevision(topology, eventSequence, true);
  }

  reviseTopology(topology: TopologyRevisionRecord, eventSequence: number): void {
    this.assertAvailable(); assertTopologyRevision(topology);
    const head = this.runHead(topology.run_id);
    if (!["ACTIVE", "PAUSED"].includes(head.status)) throw new AuthorityIntegrityError("Topology can change only on an active or paused ManagedRun");
    if (topology.revision !== head.topology_revision + 1) throw new AuthorityIntegrityError("Topology revision does not extend the current head");
    const inFlight = this.connection.prepare(`SELECT count(*) count FROM work_shards_v1 s JOIN work_shard_heads_v1 h ON h.shard_id=s.shard_id
      WHERE s.run_id=? AND h.status IN ('LEASED','RUNNING','RESULT_SUBMITTED','INTEGRATING')`).get(topology.run_id) as { count?: unknown } | undefined;
    if (Number(inFlight?.count ?? 0) !== 0) throw new AuthorityIntegrityError("Topology cannot change while a WorkShard is in flight");
    this.insertTopologyRevision(topology, eventSequence, false);
    this.connection.prepare(`UPDATE managed_run_heads_v1 SET requested_topology=?,effective_topology=?,topology_revision=?,updated_event_sequence=? WHERE run_id=?`)
      .run(topology.requested_topology, topology.effective_topology, topology.revision, eventSequence, topology.run_id);
  }

  private insertTopologyRevision(topology: TopologyRevisionRecord, eventSequence: number, initial: boolean): void {
    if (initial && topology.revision !== 1) throw new AuthorityIntegrityError("Initial topology revision must be 1");
    this.connection.prepare(`INSERT INTO topology_revisions_v1(run_id,revision,requested_topology,effective_topology,reason_code,
      decision_sha256,config_sha256,record_sha256,created_at_ms,created_event_sequence) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
      topology.run_id, topology.revision, topology.requested_topology, topology.effective_topology,
      topology.reason_code, topology.decision_sha256, topology.config_sha256, topology.record_sha256,
      topology.created_at_ms, eventSequence,
    );
  }

  defineShards(runId: string, goalId: string, workCellId: string, shards: readonly WorkShardRecord[], eventSequence: number): void {
    this.assertAvailable();
    if (shards.length === 0 || shards.length > 4096) throw new AuthorityIntegrityError("WorkShard batch size is invalid");
    const run = this.runHead(runId);
    if (run.goal_id !== goalId || run.status !== "ACTIVE") throw new AuthorityIntegrityError("WorkShard definition requires the active matching ManagedRun");
    const cell = this.connection.prepare(`SELECT c.read_roots_json,c.write_roots_json,c.spec_sha256,h.status
      FROM work_cells_v1 c JOIN work_cell_heads_v1 h ON h.work_cell_id=c.work_cell_id
      JOIN route_skeleton_heads_v1 r ON r.route_id=c.route_id AND r.goal_id=c.goal_id
      WHERE c.work_cell_id=? AND c.goal_id=?`).get(workCellId, goalId) as Record<string, unknown> | undefined;
    if (!cell || !["READY", "RUNNING", "REPAIRING"].includes(String(cell.status))) throw new AuthorityIntegrityError("WorkShard definition requires a current executable WorkCell");
    const allowedReads = parseJson<string[]>(cell.read_roots_json, "WorkCell read roots");
    const allowedWrites = parseJson<string[]>(cell.write_roots_json, "WorkCell write roots");
    const existingRows = this.connection.prepare("SELECT shard_id FROM work_shards_v1 WHERE run_id=? AND work_cell_id=?").all(runId, workCellId) as Record<string, unknown>[];
    if (run.effective_topology === "SINGLE") {
      throw new AuthorityIntegrityError("SINGLE topology executes the authorized WorkCell directly and cannot define WorkShards");
    }
    if (run.effective_topology === "MULTI" && shards.some((shard) => shard.role === "SUPERVISOR")) {
      throw new AuthorityIntegrityError("MULTI topology dispatches only bounded worker roles");
    }
    const ids = new Set(existingRows.map((row) => text(row.shard_id, "shard_id")));
    for (const shard of shards) {
      assertWorkShard(shard);
      if (shard.run_id !== runId || shard.goal_id !== goalId || shard.work_cell_id !== workCellId || ids.has(shard.shard_id)) {
        throw new AuthorityIntegrityError("WorkShard identity or binding is invalid");
      }
      if (shard.read_roots.some((root) => !containedByAny(root, allowedReads))
        || shard.write_roots.some((root) => !containedByAny(root, allowedWrites))) {
        throw new AuthorityIntegrityError("WorkShard scope exceeds its WorkCell");
      }
      ids.add(shard.shard_id);
    }
    const graph = new Map<string, readonly string[]>();
    const existingDependencies = this.connection.prepare(`SELECT s.shard_id,d.depends_on_shard_id FROM work_shards_v1 s
      LEFT JOIN work_shard_dependencies_v1 d ON d.shard_id=s.shard_id WHERE s.run_id=? AND s.work_cell_id=?`).all(runId, workCellId) as Record<string, unknown>[];
    for (const id of existingRows.map((row) => text(row.shard_id, "shard_id"))) graph.set(id, []);
    for (const row of existingDependencies) {
      const id = text(row.shard_id, "shard_id");
      if (row.depends_on_shard_id !== null) graph.set(id, [...(graph.get(id) ?? []), text(row.depends_on_shard_id, "depends_on_shard_id")]);
    }
    for (const shard of shards) {
      if (shard.dependencies.some((dependency) => !ids.has(dependency))) throw new AuthorityIntegrityError("WorkShard dependency is outside its WorkCell shard graph");
      graph.set(shard.shard_id, shard.dependencies);
    }
    assertAcyclic(graph);
    const existingScopes = this.connection.prepare(`SELECT shard_id,read_roots_json,write_roots_json FROM work_shards_v1
      WHERE run_id=? AND work_cell_id=?`).all(runId, workCellId) as Record<string, unknown>[];
    const scopes = [
      ...existingScopes.map((row) => ({
        id: text(row.shard_id, "shard_id"), reads: parseJson<string[]>(row.read_roots_json, "read roots"),
        writes: parseJson<string[]>(row.write_roots_json, "write roots"),
      })),
      ...shards.map((shard) => ({ id: shard.shard_id, reads: shard.read_roots, writes: shard.write_roots })),
    ];
    for (let leftIndex = 0; leftIndex < scopes.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < scopes.length; rightIndex += 1) {
        const left = scopes[leftIndex]!; const right = scopes[rightIndex]!;
        const conflicts = left.writes.some((root) => [...right.reads, ...right.writes].some((other) => rootsOverlap(root, other)))
          || right.writes.some((root) => left.reads.some((other) => rootsOverlap(root, other)));
        if (conflicts && !graphReaches(graph, left.id, right.id) && !graphReaches(graph, right.id, left.id)) {
          throw new AuthorityIntegrityError("Conflicting WorkShard read/write scopes require an explicit dependency");
        }
      }
    }
    const insertShard = this.connection.prepare(`INSERT INTO work_shards_v1(shard_id,run_id,goal_id,work_cell_id,logical_key,ordinal,role,outcome,
      read_roots_json,write_roots_json,oracle_json,packet_budget_json,spec_sha256,created_event_sequence) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insertDependency = this.connection.prepare("INSERT INTO work_shard_dependencies_v1(shard_id,depends_on_shard_id) VALUES(?,?)");
    const insertHead = this.connection.prepare(`INSERT INTO work_shard_heads_v1(shard_id,status,attempt_count,latest_worker_run_id,result_sha256,updated_event_sequence)
      VALUES(?,?,0,NULL,NULL,?)`);
    const newShardIds = new Set(shards.map((shard) => shard.shard_id));
    for (const shard of shards) {
      insertShard.run(shard.shard_id, shard.run_id, shard.goal_id, shard.work_cell_id, shard.logical_key, shard.ordinal, shard.role, shard.outcome,
        canonicalJson(shard.read_roots), canonicalJson(shard.write_roots), canonicalJson(shard.oracle), canonicalJson(shard.packet_budget),
        shard.spec_sha256, eventSequence);
    }
    for (const shard of shards) {
      for (const dependency of shard.dependencies) insertDependency.run(shard.shard_id, dependency);
    }
    for (const shard of shards) {
      const ready = shard.dependencies.every((dependency) => !newShardIds.has(dependency) && this.shardHead(dependency).status === "SUCCEEDED");
      insertHead.run(shard.shard_id, ready ? "READY" : "PROPOSED", eventSequence);
    }
  }

  leaseShard(packet: TaskPacketRecord, subject: ExecutionSubjectRefV2, lease: ShardLeaseGenerationRecord, eventSequence: number, nowMs: number): void {
    this.assertAvailable(); assertTaskPacket(packet); assertExecutionSubjectRefV2(subject); assertShardLease(lease);
    const shard = this.shardHead(packet.shard_id);
    const run = this.runHead(packet.run_id);
    if (run.goal_id !== shard.goal_id || shard.run_id !== run.run_id || run.status !== "ACTIVE" || run.effective_topology !== "MULTI") {
      throw new AuthorityIntegrityError("Worker dispatch requires an active MULTI ManagedRun");
    }
    if (shard.status !== "READY" || packet.attempt !== shard.attempt_count + 1 || lease.shard_id !== shard.shard_id) {
      throw new AuthorityIntegrityError("WorkShard is not eligible for the requested attempt");
    }
    const authority = this.connection.prepare(`SELECT a.record_sha256,a.expires_at_ms,c.spec_sha256,g.contract_sha256,r.route_sha256
      FROM work_cells_v1 c JOIN execution_authorizations_v1 a ON a.work_cell_id=c.work_cell_id AND a.revoked_at_ms IS NULL
      JOIN goal_contract_heads_v1 g ON g.goal_id=c.goal_id JOIN route_skeleton_heads_v1 r ON r.goal_id=c.goal_id AND r.route_id=c.route_id
      WHERE c.work_cell_id=? AND c.goal_id=? ORDER BY a.created_event_sequence DESC LIMIT 1`).get(shard.work_cell_id, shard.goal_id) as Record<string, unknown> | undefined;
    if (!authority || integer(authority.expires_at_ms, "authorization expiry") <= nowMs) throw new AuthorityIntegrityError("Worker dispatch requires a current WorkCell authorization");
    if (packet.goal_contract_sha256 !== authority.contract_sha256 || packet.route_sha256 !== authority.route_sha256
      || packet.work_cell_sha256 !== authority.spec_sha256 || packet.subject_binding_sha256 !== subject.binding_sha256) {
      throw new AuthorityIntegrityError("TaskPacket authority closure is stale");
    }
    if (subject.kind !== "WORK_SHARD" || subject.run_id !== run.run_id || subject.goal_id !== run.goal_id
      || subject.work_cell_id !== shard.work_cell_id || subject.shard_id !== shard.shard_id || subject.worker_run_id !== null
      || subject.role !== shard.role || subject.topology_revision !== run.topology_revision || subject.attempt !== packet.attempt
      || subject.goal_contract_sha256 !== packet.goal_contract_sha256 || subject.route_sha256 !== packet.route_sha256
      || subject.authorization_sha256 !== authority.record_sha256) throw new AuthorityIntegrityError("TaskPacket execution subject is invalid");
    if (lease.expires_at_ms <= nowMs || packet.expires_at_ms !== lease.expires_at_ms || lease.expires_at_ms > Number(authority.expires_at_ms)) {
      throw new AuthorityIntegrityError("Worker lease expiry exceeds its authority closure");
    }
    const currentLease = this.connection.prepare("SELECT generation,fencing_token FROM shard_lease_heads_v1 WHERE shard_id=?").get(shard.shard_id) as Record<string, unknown> | undefined;
    const expectedGeneration = currentLease ? integer(currentLease.generation, "lease generation", 1) + 1 : 1;
    const previousFence = currentLease ? integer(currentLease.fencing_token, "fencing token", 1) : 0;
    if (lease.generation !== expectedGeneration || lease.fencing_token <= previousFence) throw new AuthorityIntegrityError("Shard lease generation or fencing token is stale");
    this.insertSubject(subject, eventSequence);
    this.connection.prepare(`INSERT INTO task_packets_v1(packet_id,run_id,shard_id,attempt,subject_binding_sha256,packet_json,packet_sha256,
      capability_hmac,expires_at_ms,created_event_sequence) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
      packet.packet_id, packet.run_id, packet.shard_id, packet.attempt, packet.subject_binding_sha256, canonicalJson(packet),
      packet.packet_sha256, packet.capability_hmac, packet.expires_at_ms, eventSequence,
    );
    this.connection.prepare(`INSERT INTO shard_lease_generations_v1(shard_id,generation,fencing_token,owner_hmac,expires_at_ms,lease_sha256,created_event_sequence)
      VALUES(?,?,?,?,?,?,?)`).run(lease.shard_id, lease.generation, lease.fencing_token, lease.owner_hmac, lease.expires_at_ms, lease.lease_sha256, eventSequence);
    this.connection.prepare(`INSERT INTO shard_lease_heads_v1(shard_id,generation,fencing_token,owner_hmac,worker_run_id,expires_at_ms,released_at_ms,updated_event_sequence)
      VALUES(?,?,?,?,NULL,?,NULL,?) ON CONFLICT(shard_id) DO UPDATE SET generation=excluded.generation,fencing_token=excluded.fencing_token,
      owner_hmac=excluded.owner_hmac,worker_run_id=NULL,expires_at_ms=excluded.expires_at_ms,released_at_ms=NULL,updated_event_sequence=excluded.updated_event_sequence`)
      .run(lease.shard_id, lease.generation, lease.fencing_token, lease.owner_hmac, lease.expires_at_ms, eventSequence);
    this.connection.prepare("UPDATE work_shard_heads_v1 SET status='LEASED',attempt_count=?,updated_event_sequence=? WHERE shard_id=? AND status='READY'")
      .run(packet.attempt, eventSequence, shard.shard_id);
  }

  startWorker(worker: WorkerRunRecord, subject: ExecutionSubjectRefV2, transition: WorkerRunTransitionRecord, eventSequence: number, nowMs: number): void {
    this.assertAvailable(); assertWorkerRun(worker); assertExecutionSubjectRefV2(subject); assertWorkerTransition(transition);
    const shard = this.shardHead(worker.shard_id);
    const packet = this.connection.prepare("SELECT run_id,attempt,expires_at_ms,packet_json,subject_binding_sha256 FROM task_packets_v1 WHERE packet_id=? AND shard_id=?")
      .get(worker.packet_id, worker.shard_id) as Record<string, unknown> | undefined;
    const lease = this.connection.prepare("SELECT generation,fencing_token,expires_at_ms,released_at_ms FROM shard_lease_heads_v1 WHERE shard_id=?")
      .get(worker.shard_id) as Record<string, unknown> | undefined;
    if (!packet || !lease || shard.status !== "LEASED" || packet.run_id !== worker.run_id || worker.run_id !== shard.run_id
      || integer(packet.attempt, "packet attempt", 1) !== worker.attempt || worker.attempt !== shard.attempt_count
      || integer(lease.generation, "lease generation", 1) !== worker.lease_generation
      || integer(lease.fencing_token, "fencing token", 1) !== worker.fencing_token || lease.released_at_ms !== null
      || integer(lease.expires_at_ms, "lease expiry") <= nowMs || integer(packet.expires_at_ms, "packet expiry") <= nowMs) {
      throw new AuthorityIntegrityError("WorkerRun does not own the current live shard lease");
    }
    if (worker.role !== shard.role || worker.role === "IMPLEMENTER" && worker.sandbox_kind === "NONE_READ_ONLY") {
      throw new AuthorityIntegrityError("Worker role or sandbox does not satisfy the WorkShard contract");
    }
    const packetRecord = parseJson<TaskPacketRecord>(packet.packet_json, "TaskPacket");
    assertTaskPacket(packetRecord);
    const parentRow = this.connection.prepare("SELECT record_json FROM execution_subject_bindings_v2 WHERE binding_sha256=?")
      .get(sha(packet.subject_binding_sha256, "TaskPacket subject binding")) as { record_json?: unknown } | undefined;
    const parentSubject = parentRow ? parseJson<ExecutionSubjectRefV2>(parentRow.record_json, "WorkShard execution subject") : null;
    if (!parentSubject) throw new AuthorityIntegrityError("WorkerRun is missing its WorkShard execution subject");
    assertExecutionSubjectRefV2(parentSubject);
    if (transition.worker_run_id !== worker.worker_run_id || transition.ordinal !== 0 || transition.state !== "STARTING"
      || transition.predecessor_sha256 !== null || transition.output_sha256 !== null) throw new AuthorityIntegrityError("WorkerRun must begin with STARTING ordinal 0");
    const run = this.runHead(worker.run_id);
    if (subject.kind !== "WORKER_RUN" || subject.run_id !== worker.run_id || subject.goal_id !== shard.goal_id
      || subject.work_cell_id !== shard.work_cell_id || subject.shard_id !== shard.shard_id || subject.worker_run_id !== worker.worker_run_id
      || subject.role !== worker.role || subject.topology_revision !== run.topology_revision || subject.attempt !== worker.attempt
      || subject.goal_contract_sha256 !== packetRecord.goal_contract_sha256 || subject.route_sha256 !== packetRecord.route_sha256
      || subject.authorization_sha256 !== parentSubject.authorization_sha256) {
      throw new AuthorityIntegrityError("WorkerRun execution subject is invalid");
    }
    this.connection.prepare(`INSERT INTO worker_runs_v1(worker_run_id,run_id,shard_id,packet_id,role,attempt,lease_generation,fencing_token,
      sandbox_kind,model_fingerprint_hmac,record_sha256,created_at_ms,created_event_sequence) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      worker.worker_run_id, worker.run_id, worker.shard_id, worker.packet_id, worker.role, worker.attempt,
      worker.lease_generation, worker.fencing_token, worker.sandbox_kind, worker.model_fingerprint_hmac,
      worker.record_sha256, worker.created_at_ms, eventSequence,
    );
    this.insertSubject(subject, eventSequence);
    this.insertWorkerTransition(transition, eventSequence);
    this.connection.prepare("UPDATE shard_lease_heads_v1 SET worker_run_id=?,updated_event_sequence=? WHERE shard_id=?")
      .run(worker.worker_run_id, eventSequence, worker.shard_id);
    this.connection.prepare("UPDATE work_shard_heads_v1 SET status='RUNNING',latest_worker_run_id=?,updated_event_sequence=? WHERE shard_id=? AND status='LEASED'")
      .run(worker.worker_run_id, eventSequence, worker.shard_id);
  }

  transitionWorker(transition: WorkerRunTransitionRecord, eventSequence: number, nowMs: number): void {
    this.assertAvailable(); assertWorkerTransition(transition);
    const current = this.workerState(transition.worker_run_id);
    const allowed: Readonly<Record<WorkerRunState, readonly WorkerRunState[]>> = {
      STARTING: ["RUNNING", "FAILED", "ABORTED", "TIMED_OUT", "FENCED"], RUNNING: ["FAILED", "ABORTED", "TIMED_OUT", "FENCED"],
      SUCCEEDED: [], FAILED: [], ABORTED: [], TIMED_OUT: [], FENCED: [],
    };
    if (!allowed[current.state].includes(transition.state) || transition.ordinal !== current.ordinal + 1
      || transition.predecessor_sha256 !== current.transitionSha256 || transition.state === "SUCCEEDED") {
      throw new AuthorityIntegrityError("WorkerRun transition is not legal");
    }
    const live = this.currentWorkerLease(current.shardId, transition.worker_run_id, nowMs);
    if (transition.state === "RUNNING" && !live) throw new AuthorityIntegrityError("A stale worker cannot enter RUNNING");
    if (!live && transition.state !== "FENCED") throw new AuthorityIntegrityError("A stale worker may only be fenced");
    this.insertWorkerTransition(transition, eventSequence);
    if (terminalWorkerStates.includes(transition.state)) {
      this.connection.prepare("UPDATE work_shard_heads_v1 SET status='FAILED',result_sha256=?,updated_event_sequence=? WHERE shard_id=? AND latest_worker_run_id=?")
        .run(transition.failure_signature_sha256, eventSequence, current.shardId, transition.worker_run_id);
      this.releaseLease(current.shardId, transition.worker_run_id, eventSequence, nowMs);
    }
  }

  recoverWorker(transition: WorkerRunTransitionRecord, eventSequence: number, nowMs: number): void {
    if (transition.state !== "FENCED") throw new AuthorityIntegrityError("Worker recovery must fence the orphaned run");
    this.transitionWorker(transition, eventSequence, nowMs);
    const worker = this.connection.prepare("SELECT shard_id,attempt FROM worker_runs_v1 WHERE worker_run_id=?")
      .get(transition.worker_run_id) as Record<string, unknown> | undefined;
    if (!worker) throw new AuthorityIntegrityError("Recovered WorkerRun is missing");
    const shard = this.shardHead(text(worker.shard_id, "shard_id"));
    const budget = parseJson<Record<string, unknown>>(shard.packet_budget_json, "WorkShard packet budget");
    const maxAttempts = Number(budget.max_attempts ?? 1);
    if (Number.isSafeInteger(maxAttempts) && shard.attempt_count < maxAttempts) {
      this.connection.prepare("UPDATE work_shard_heads_v1 SET status='READY',updated_event_sequence=? WHERE shard_id=? AND status='FAILED'")
        .run(eventSequence, shard.shard_id);
    }
  }

  requeueShard(runId: string, goalId: string, shardId: string, reasonSha256: string, routeDecisionSha256: string, eventSequence: number): void {
    sha(reasonSha256, "retry reason"); sha(routeDecisionSha256, "route decision");
    const run = this.runHead(runId); const shard = this.shardHead(shardId);
    if (run.goal_id !== goalId || shard.run_id !== runId || run.status !== "ACTIVE" || shard.status !== "FAILED") {
      throw new AuthorityIntegrityError("Only a failed shard in the active ManagedRun can be retried");
    }
    const budget = parseJson<Record<string, unknown>>(shard.packet_budget_json, "WorkShard packet budget");
    const maxAttempts = Number(budget.max_attempts ?? 1);
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || shard.attempt_count >= maxAttempts) throw new AuthorityIntegrityError("WorkShard retry budget is exhausted");
    const decision = this.connection.prepare("SELECT count(*) count FROM route_health_records_v1 WHERE goal_id=? AND record_sha256=? AND level IN ('H1_RETRY','H2_REPAIR')")
      .get(goalId, routeDecisionSha256) as { count?: unknown } | undefined;
    if (Number(decision?.count ?? 0) !== 1) throw new AuthorityIntegrityError("WorkShard retry requires a current RouteHealth decision");
    this.connection.prepare("UPDATE work_shard_heads_v1 SET status='READY',updated_event_sequence=? WHERE shard_id=? AND status='FAILED'")
      .run(eventSequence, shardId);
  }

  submitWorkerResult(result: WorkerResultRecord, transition: WorkerRunTransitionRecord, patchSet: PatchSetRecord | null, artifacts: readonly ArtifactMetadata[], eventSequence: number, nowMs: number): void {
    this.assertAvailable(); assertWorkerResult(result); assertWorkerTransition(transition);
    if (patchSet !== null) assertPatchSet(patchSet);
    const current = this.workerState(result.worker_run_id);
    const worker = this.connection.prepare("SELECT run_id,shard_id,role FROM worker_runs_v1 WHERE worker_run_id=?").get(result.worker_run_id) as Record<string, unknown> | undefined;
    if (!worker || current.state !== "RUNNING" || transition.state !== "SUCCEEDED" || transition.ordinal !== current.ordinal + 1
      || transition.predecessor_sha256 !== current.transitionSha256 || transition.output_sha256 !== result.artifact_sha256
      || result.run_id !== worker.run_id || result.shard_id !== worker.shard_id || !this.currentWorkerLease(current.shardId, result.worker_run_id, nowMs)) {
      throw new AuthorityIntegrityError("Worker result does not close the current live WorkerRun");
    }
    if ((result.result_kind === "PATCH" || result.result_kind === "INTEGRATION") !== (patchSet !== null)) {
      throw new AuthorityIntegrityError("Patch-bearing worker result and PatchSet must be submitted together");
    }
    if (result.trust !== "UNVERIFIED") throw new AuthorityIntegrityError("Worker results remain unverified until independent evidence or integration closes them");
    if (patchSet && (patchSet.worker_run_id !== result.worker_run_id || patchSet.run_id !== result.run_id || patchSet.shard_id !== result.shard_id
      || !["IMPLEMENTER", "INTEGRATOR"].includes(String(worker.role)))) throw new AuthorityIntegrityError("PatchSet is not bound to an eligible worker");
    if (artifacts.length === 0 || artifacts.length > 4097) throw new AuthorityIntegrityError("Worker result artifact set is invalid");
    const artifactHashes = new Set(artifacts.map((artifact) => artifact.sha256));
    if (!artifactHashes.has(result.artifact_sha256)) throw new AuthorityIntegrityError("Worker result artifact is not registered in the same transaction");
    if (patchSet) for (const entry of patchSet.entries) {
      if (entry.content_locator !== null && (!entry.after_sha256 || !artifactHashes.has(entry.after_sha256)
        || !artifacts.some((artifact) => artifact.sha256 === entry.after_sha256 && artifact.locator === entry.content_locator))) {
        throw new AuthorityIntegrityError("PatchSet content is not registered in the same transaction");
      }
    }
    for (const artifact of artifacts) registerArtifact(this.connection, artifact, nowMs);
    this.connection.prepare(`INSERT INTO worker_results_v1(result_id,worker_run_id,run_id,shard_id,result_kind,artifact_sha256,
      artifact_locator_hmac,trust,record_sha256,created_at_ms,created_event_sequence) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
      result.result_id, result.worker_run_id, result.run_id, result.shard_id, result.result_kind, result.artifact_sha256,
      result.artifact_locator_hmac, result.trust, result.record_sha256, result.created_at_ms, eventSequence,
    );
    if (patchSet) this.connection.prepare(`INSERT INTO patch_sets_v1(patch_set_id,run_id,shard_id,worker_run_id,baseline_sha256,entries_json,
      patch_sha256,created_at_ms,created_event_sequence) VALUES(?,?,?,?,?,?,?,?,?)`).run(
      patchSet.patch_set_id, patchSet.run_id, patchSet.shard_id, patchSet.worker_run_id, patchSet.baseline_sha256,
      canonicalJson(patchSet.entries), patchSet.patch_sha256, patchSet.created_at_ms, eventSequence,
    );
    this.insertWorkerTransition(transition, eventSequence);
    this.connection.prepare("UPDATE work_shard_heads_v1 SET status='RESULT_SUBMITTED',result_sha256=?,updated_event_sequence=? WHERE shard_id=? AND latest_worker_run_id=?")
      .run(result.record_sha256, eventSequence, result.shard_id, result.worker_run_id);
    this.releaseLease(result.shard_id, result.worker_run_id, eventSequence, nowMs);
  }

  preparePatchTransaction(input: {
    readonly goalId: string;
    readonly runId: string;
    readonly shardId: string;
    readonly patchSetId: string;
    readonly journalSha256: string;
    readonly journalArtifact: ArtifactMetadata;
    readonly preimageArtifacts: readonly ArtifactMetadata[];
  }, eventSequence: number, nowMs: number): void {
    this.assertAvailable();
    if (!/^[a-f0-9]{64}$/u.test(input.journalSha256) || input.journalArtifact.sha256 !== input.journalSha256) {
      throw new AuthorityIntegrityError("Patch transaction journal artifact binding is invalid");
    }
    if (input.preimageArtifacts.length > 256) throw new AuthorityIntegrityError("Patch transaction preimage artifact set is unbounded");
    const patch = this.connection.prepare(`SELECT p.run_id,p.shard_id,s.goal_id,h.status
      FROM patch_sets_v1 p JOIN work_shards_v1 s ON s.shard_id=p.shard_id
      JOIN work_shard_heads_v1 h ON h.shard_id=p.shard_id WHERE p.patch_set_id=?`).get(input.patchSetId) as Record<string, unknown> | undefined;
    if (!patch || patch.goal_id !== input.goalId || patch.run_id !== input.runId || patch.shard_id !== input.shardId
      || patch.status !== "RESULT_SUBMITTED") {
      throw new AuthorityIntegrityError("Patch transaction does not bind the current submitted Worker PatchSet");
    }
    registerArtifact(this.connection, input.journalArtifact, nowMs);
    for (const artifact of input.preimageArtifacts) registerArtifact(this.connection, artifact, nowMs);
    this.connection.prepare(`INSERT INTO patch_transaction_preparations_v1(
      patch_set_id,goal_id,run_id,shard_id,journal_artifact_id,journal_sha256,created_at_ms,created_event_sequence
    ) VALUES(?,?,?,?,?,?,?,?)`).run(
      input.patchSetId, input.goalId, input.runId, input.shardId, input.journalArtifact.artifactId,
      input.journalSha256, nowMs, eventSequence,
    );
    this.connection.prepare("UPDATE work_shard_heads_v1 SET status='INTEGRATING',updated_event_sequence=? WHERE shard_id=?")
      .run(eventSequence, input.shardId);
  }

  recordIntegration(receipt: IntegrationReceiptRecord, eventSequence: number): void {
    this.assertAvailable(); assertIntegrationReceipt(receipt);
    const shard = this.shardHead(receipt.shard_id);
    if (shard.run_id !== receipt.run_id || !["RESULT_SUBMITTED", "INTEGRATING"].includes(shard.status)) {
      throw new AuthorityIntegrityError("Integration receipt does not settle an eligible WorkShard");
    }
    if (receipt.patch_set_id === null) {
      if (receipt.result !== "NO_CHANGES") throw new AuthorityIntegrityError("A patchless integration may only report NO_CHANGES");
      if (receipt.transaction_journal_sha256 !== null) throw new AuthorityIntegrityError("Patchless integration cannot bind a transaction journal");
    } else {
      const patch = this.connection.prepare("SELECT run_id,shard_id FROM patch_sets_v1 WHERE patch_set_id=?").get(receipt.patch_set_id) as Record<string, unknown> | undefined;
      if (!patch || patch.run_id !== receipt.run_id || patch.shard_id !== receipt.shard_id) throw new AuthorityIntegrityError("Integration receipt PatchSet binding is invalid");
      const preparation = this.connection.prepare("SELECT journal_sha256 FROM patch_transaction_preparations_v1 WHERE patch_set_id=?")
        .get(receipt.patch_set_id) as { journal_sha256?: unknown } | undefined;
      if (!preparation || receipt.transaction_journal_sha256 !== preparation.journal_sha256) {
        throw new AuthorityIntegrityError("Integration receipt is not bound to its prepared PatchTransaction journal");
      }
    }
    if (receipt.result === "APPLIED") {
      if (receipt.operation_ids.length === 0) throw new AuthorityIntegrityError("APPLIED integration requires committed canonical operations");
      for (const operationId of receipt.operation_ids) {
        const operation = this.connection.prepare(`SELECT count(*) count FROM operation_heads_v1
          WHERE goal_id=? AND work_cell_id=? AND operation_id=? AND state='COMMITTED'`).get(shard.goal_id, shard.work_cell_id, operationId) as { count?: unknown } | undefined;
        if (Number(operation?.count ?? 0) === 0) throw new AuthorityIntegrityError("Integration receipt references an operation without a committed canonical outcome");
      }
    }
    this.connection.prepare(`INSERT INTO integration_receipts_v1(integration_id,run_id,shard_id,patch_set_id,result,preimage_root_sha256,
      postimage_root_sha256,conflict_paths_json,operation_ids_json,receipt_sha256,created_at_ms,created_event_sequence,transaction_journal_sha256)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      receipt.integration_id, receipt.run_id, receipt.shard_id, receipt.patch_set_id, receipt.result,
      receipt.preimage_root_sha256, receipt.postimage_root_sha256, canonicalJson(receipt.conflict_paths),
      canonicalJson(receipt.operation_ids), receipt.receipt_sha256, receipt.created_at_ms, eventSequence,
      receipt.transaction_journal_sha256,
    );
    const next: WorkShardStatus = ["APPLIED", "NO_CHANGES"].includes(receipt.result) ? "SUCCEEDED"
      : receipt.result === "OUTCOME_UNKNOWN" ? "INTEGRATING" : "REJECTED";
    this.connection.prepare("UPDATE work_shard_heads_v1 SET status=?,updated_event_sequence=? WHERE shard_id=?")
      .run(next, eventSequence, receipt.shard_id);
    if (next === "SUCCEEDED") this.unlockDependents(receipt.shard_id, eventSequence);
    if (receipt.result === "OUTCOME_UNKNOWN") this.connection.prepare("UPDATE managed_run_heads_v1 SET status='RECONCILING',updated_event_sequence=? WHERE run_id=?")
      .run(eventSequence, receipt.run_id);
    else if (shard.status === "INTEGRATING") this.connection.prepare("UPDATE managed_run_heads_v1 SET status='ACTIVE',updated_event_sequence=? WHERE run_id=? AND status='RECONCILING'")
      .run(eventSequence, receipt.run_id);
  }

  openPatchTransactions(goalId: string): readonly OpenPatchTransactionView[] {
    this.assertAvailable();
    return (this.connection.prepare(`SELECT p.patch_set_id,p.run_id,p.shard_id,p.journal_sha256,a.locator,
        s.patch_sha256,s.entries_json,b.content_root_sha256
      FROM patch_transaction_preparations_v1 p JOIN artifacts a ON a.artifact_id=p.journal_artifact_id
      JOIN patch_sets_v1 s ON s.patch_set_id=p.patch_set_id
      JOIN workspace_baselines_v1 b ON b.record_sha256=s.baseline_sha256
      LEFT JOIN integration_receipts_v1 i ON i.patch_set_id=p.patch_set_id
      WHERE p.goal_id=? AND i.integration_id IS NULL ORDER BY p.created_event_sequence`).all(goalId) as Record<string, unknown>[])
      .map((row) => {
        let entries: unknown;
        try { entries = JSON.parse(text(row.entries_json, "Patch transaction entries")); }
        catch (error) { throw new AuthorityIntegrityError("Open PatchTransaction entries are invalid", error); }
        if (!Array.isArray(entries) || entries.length < 1 || entries.length > 256) {
          throw new AuthorityIntegrityError("Open PatchTransaction entry count is invalid");
        }
        const affectedPaths = entries.map((entry) => {
          if (typeof entry !== "object" || entry === null || Array.isArray(entry)
            || typeof (entry as Record<string, unknown>).path !== "string") {
            throw new AuthorityIntegrityError("Open PatchTransaction entry path is invalid");
          }
          return text((entry as Record<string, unknown>).path, "Patch transaction path");
        });
        return {
          patchSetId: text(row.patch_set_id, "patch_set_id"), patchSha256: sha(row.patch_sha256, "patch_sha256"),
          runId: text(row.run_id, "run_id"), shardId: text(row.shard_id, "shard_id"),
          journalSha256: sha(row.journal_sha256, "journal_sha256"), journalLocator: text(row.locator, "journal locator"),
          preimageRootSha256: sha(row.content_root_sha256, "preimage content root"), affectedPaths,
        };
      });
  }

  transitionSingle(runId: string, goalId: string, shardId: string, action: "START" | "SUCCEED" | "FAIL" | "CANCEL", resultSha256: string | null, eventSequence: number, nowMs: number): void {
    const run = this.runHead(runId); const shard = this.shardHead(shardId);
    if (run.goal_id !== goalId || run.effective_topology !== "SINGLE" || run.status !== "ACTIVE"
      || shard.run_id !== runId || shard.role !== "SUPERVISOR") throw new AuthorityIntegrityError("Single shard transition is outside the active SINGLE run");
    if (resultSha256 !== null) sha(resultSha256, "single shard result");
    const expected: Readonly<Record<typeof action, WorkShardStatus>> = { START: "READY", SUCCEED: "RUNNING", FAIL: "RUNNING", CANCEL: "RUNNING" };
    if (shard.status !== expected[action]) throw new AuthorityIntegrityError("Single shard transition lost its expected state");
    if (action === "START") {
      const authorization = this.connection.prepare(`SELECT count(*) count FROM execution_authorizations_v1
        WHERE goal_id=? AND work_cell_id=? AND revoked_at_ms IS NULL AND expires_at_ms>?`).get(goalId, shard.work_cell_id, nowMs) as { count?: unknown } | undefined;
      if (Number(authorization?.count ?? 0) !== 1) throw new AuthorityIntegrityError("Single shard start requires a current WorkCell authorization");
    } else if (resultSha256 === null) throw new AuthorityIntegrityError("A terminal Single shard transition requires a result hash");
    if (action === "SUCCEED") {
      const cell = this.connection.prepare("SELECT status FROM work_cell_heads_v1 WHERE work_cell_id=? AND goal_id=?")
        .get(shard.work_cell_id, goalId) as { status?: unknown } | undefined;
      if (cell?.status !== "SUCCEEDED") throw new AuthorityIntegrityError("Single shard success requires the Task Flow WorkCell to be succeeded first");
    }
    const next: WorkShardStatus = action === "START" ? "RUNNING" : action === "SUCCEED" ? "SUCCEEDED" : action === "CANCEL" ? "CANCELED" : "FAILED";
    this.connection.prepare("UPDATE work_shard_heads_v1 SET status=?,attempt_count=attempt_count+CASE WHEN ?='START' THEN 1 ELSE 0 END,result_sha256=COALESCE(?,result_sha256),updated_event_sequence=? WHERE shard_id=?")
      .run(next, action, resultSha256, eventSequence, shardId);
    if (next === "SUCCEEDED") this.unlockDependents(shardId, eventSequence);
  }

  controlRun(runId: string, goalId: string, action: "PAUSE" | "RESUME" | "CANCEL" | "SUCCEED" | "FAIL", reasonSha256: string, eventSequence: number, nowMs: number): void {
    sha(reasonSha256, "ManagedRun control reason");
    const run = this.runHead(runId);
    if (run.goal_id !== goalId) throw new AuthorityIntegrityError("ManagedRun control Goal binding is invalid");
    let next: ManagedRunStatus;
    if (action === "PAUSE" && ["ACTIVE", "RECONCILING"].includes(run.status)) next = "PAUSED";
    else if (action === "RESUME" && run.status === "PAUSED") next = "ACTIVE";
    else if (action === "CANCEL" && !["SUCCEEDED", "FAILED", "CANCELED"].includes(run.status)) next = "CANCELED";
    else if (action === "FAIL" && !["SUCCEEDED", "FAILED", "CANCELED"].includes(run.status)) next = "FAILED";
    else if (action === "SUCCEED" && ["ACTIVE", "PAUSED"].includes(run.status)) {
      const goal = this.connection.prepare("SELECT status FROM task_flow_goal_heads_v1 WHERE goal_id=?").get(goalId) as { status?: unknown } | undefined;
      const incomplete = this.connection.prepare(`SELECT count(*) count FROM work_shards_v1 s JOIN work_shard_heads_v1 h ON h.shard_id=s.shard_id
        WHERE s.run_id=? AND h.status NOT IN ('SUCCEEDED','SUPERSEDED')`).get(runId) as { count?: unknown } | undefined;
      if (goal?.status !== "SUCCEEDED" || Number(incomplete?.count ?? 0) !== 0) throw new AuthorityIntegrityError("ManagedRun success requires Task Flow and shard closure");
      next = "SUCCEEDED";
    } else throw new AuthorityIntegrityError(`ManagedRun cannot ${action} from ${run.status}`);
    this.connection.prepare("UPDATE managed_run_heads_v1 SET status=?,updated_event_sequence=? WHERE run_id=?").run(next, eventSequence, runId);
    if (["CANCELED", "FAILED"].includes(next)) {
      this.connection.prepare(`UPDATE work_shard_heads_v1 SET status=?,updated_event_sequence=? WHERE shard_id IN(
        SELECT shard_id FROM work_shards_v1 WHERE run_id=?) AND status IN ('PROPOSED','READY','LEASED','RUNNING','RESULT_SUBMITTED','INTEGRATING')`)
        .run(next === "CANCELED" ? "CANCELED" : "FAILED", eventSequence, runId);
      this.connection.prepare("UPDATE shard_lease_heads_v1 SET released_at_ms=COALESCE(released_at_ms,?),updated_event_sequence=? WHERE shard_id IN(SELECT shard_id FROM work_shards_v1 WHERE run_id=?)")
        .run(nowMs, eventSequence, runId);
    }
  }

  bindMemory(runId: string, goalId: string, binding: MemoryVisibilityBindingRecord, eventSequence: number): void {
    this.assertAvailable(); assertMemoryVisibilityBinding(binding);
    const run = this.runHead(runId);
    const claim = this.connection.prepare(`SELECT v.workspace_id,v.claim_sha256,v.body_sha256,v.source_content_sha256,h.visibility,h.purge_state FROM memory_v3_claim_versions v
      JOIN memory_v3_claim_heads h ON h.claim_id=v.claim_id AND h.version=v.version
      WHERE v.claim_id=? AND v.version=?`).get(binding.claim_id, binding.claim_version) as Record<string, unknown> | undefined;
    if (run.goal_id !== goalId || !claim || claim.workspace_id !== run.workspace_id || claim.visibility !== "VISIBLE" || claim.purge_state !== "PRESENT") {
      throw new AuthorityIntegrityError("Memory visibility binding requires a live claim in the ManagedRun workspace");
    }
    if (binding.audience === "VERIFIED_SHARED") {
      const evidence = this.connection.prepare(`SELECT output_sha256,postcondition FROM evidence_attestations_v1
        WHERE goal_id=? AND record_sha256=? AND result='PASS' AND freshness='CURRENT'`).get(
        goalId, binding.verifier_receipt_sha256,
      ) as Record<string, unknown> | undefined;
      if (!evidence || evidence.postcondition !== "PASS"
        || (evidence.output_sha256 !== claim.body_sha256 && evidence.output_sha256 !== claim.source_content_sha256)) {
        throw new AuthorityIntegrityError("VERIFIED_SHARED memory requires current PASS evidence for the exact claim or source content");
      }
    }
    this.connection.prepare(`INSERT INTO memory_visibility_bindings_v1(claim_id,claim_version,audience,role,module_key,
      verifier_receipt_sha256,binding_sha256,created_event_sequence) VALUES(?,?,?,?,?,?,?,?)`).run(
      binding.claim_id, binding.claim_version, binding.audience, binding.role, binding.module_key,
      binding.verifier_receipt_sha256, binding.binding_sha256, eventSequence,
    );
  }

  hasVerifiedSharedMemory(runId: string): boolean {
    this.assertAvailable();
    const run = this.runHead(runId);
    const row = this.connection.prepare(`SELECT count(*) count FROM memory_visibility_bindings_v1 b
      JOIN memory_v3_claim_versions v ON v.claim_id=b.claim_id AND v.version=b.claim_version
      JOIN memory_v3_claim_heads h ON h.claim_id=v.claim_id AND h.version=v.version
      WHERE b.audience='VERIFIED_SHARED' AND v.workspace_id=? AND h.visibility='VISIBLE' AND h.purge_state='PRESENT'`)
      .get(run.workspace_id) as { count?: unknown } | undefined;
    return Number(row?.count ?? 0) > 0;
  }

  verifiedSharedMemoryBindings(runId: string, candidates: readonly { readonly claimId: string; readonly version: number }[]): ReadonlyMap<string, string> {
    this.assertAvailable();
    if (candidates.length > 64) throw new TypeError("Shared Memory candidate set is too large");
    const run = this.runHead(runId);
    const query = this.connection.prepare(`SELECT b.binding_sha256 FROM memory_visibility_bindings_v1 b
      JOIN memory_v3_claim_versions v ON v.claim_id=b.claim_id AND v.version=b.claim_version
      JOIN memory_v3_claim_heads h ON h.claim_id=v.claim_id AND h.version=v.version
      WHERE b.claim_id=? AND b.claim_version=? AND b.audience='VERIFIED_SHARED'
        AND v.workspace_id=? AND h.visibility='VISIBLE' AND h.purge_state='PRESENT'`);
    const result = new Map<string, string>();
    for (const candidate of candidates) {
      const row = query.get(candidate.claimId, candidate.version, run.workspace_id) as { binding_sha256?: unknown } | undefined;
      if (typeof row?.binding_sha256 === "string") result.set(`${candidate.claimId}:${candidate.version}`, row.binding_sha256);
    }
    return result;
  }

  private insertSubject(subject: ExecutionSubjectRefV2, eventSequence: number): void {
    const existing = this.connection.prepare("SELECT record_json FROM execution_subject_bindings_v2 WHERE binding_sha256=?").get(subject.binding_sha256) as { record_json?: unknown } | undefined;
    const recordJson = canonicalJson(subject);
    if (existing) {
      if (existing.record_json !== recordJson) throw new AuthorityIntegrityError("Execution subject hash substitution");
      return;
    }
    this.connection.prepare(`INSERT INTO execution_subject_bindings_v2(binding_sha256,run_id,goal_id,work_cell_id,shard_id,worker_run_id,
      role,topology_revision,attempt,record_json,created_event_sequence) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
      subject.binding_sha256, subject.run_id, subject.goal_id, subject.work_cell_id, subject.shard_id, subject.worker_run_id,
      subject.role, subject.topology_revision, subject.attempt, recordJson, eventSequence,
    );
  }

  private workerState(workerRunId: string): { readonly state: WorkerRunState; readonly ordinal: number; readonly transitionSha256: string; readonly shardId: string } {
    const row = this.connection.prepare(`SELECT w.shard_id,t.state,t.ordinal,t.transition_sha256 FROM worker_runs_v1 w
      JOIN worker_run_transitions_v1 t ON t.worker_run_id=w.worker_run_id WHERE w.worker_run_id=? ORDER BY t.ordinal DESC LIMIT 1`)
      .get(workerRunId) as Record<string, unknown> | undefined;
    if (!row) throw new AuthorityIntegrityError(`WorkerRun ${workerRunId} has no transition head`);
    return { state: text(row.state, "worker state") as WorkerRunState, ordinal: integer(row.ordinal, "worker ordinal"),
      transitionSha256: sha(row.transition_sha256, "worker transition hash"), shardId: text(row.shard_id, "worker shard") };
  }

  private insertWorkerTransition(transition: WorkerRunTransitionRecord, eventSequence: number): void {
    this.connection.prepare(`INSERT INTO worker_run_transitions_v1(transition_id,worker_run_id,ordinal,state,output_sha256,usage_json,
      failure_signature_sha256,predecessor_sha256,transition_sha256,created_at_ms,created_event_sequence) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
      transition.transition_id, transition.worker_run_id, transition.ordinal, transition.state, transition.output_sha256,
      canonicalJson(transition.usage), transition.failure_signature_sha256, transition.predecessor_sha256,
      transition.transition_sha256, transition.created_at_ms, eventSequence,
    );
  }

  private currentWorkerLease(shardId: string, workerRunId: string, nowMs: number): boolean {
    const row = this.connection.prepare(`SELECT count(*) count FROM shard_lease_heads_v1 h JOIN worker_runs_v1 w
      ON w.shard_id=h.shard_id AND w.worker_run_id=h.worker_run_id AND w.lease_generation=h.generation AND w.fencing_token=h.fencing_token
      WHERE h.shard_id=? AND h.worker_run_id=? AND h.released_at_ms IS NULL AND h.expires_at_ms>?`).get(shardId, workerRunId, nowMs) as { count?: unknown } | undefined;
    return Number(row?.count ?? 0) === 1;
  }

  private releaseLease(shardId: string, workerRunId: string, eventSequence: number, nowMs: number): void {
    this.connection.prepare(`UPDATE shard_lease_heads_v1 SET released_at_ms=COALESCE(released_at_ms,?),updated_event_sequence=?
      WHERE shard_id=? AND worker_run_id=?`).run(nowMs, eventSequence, shardId, workerRunId);
  }

  private unlockDependents(shardId: string, eventSequence: number): void {
    this.connection.prepare(`UPDATE work_shard_heads_v1 SET status='READY',updated_event_sequence=?
      WHERE status='PROPOSED' AND shard_id IN(SELECT shard_id FROM work_shard_dependencies_v1 WHERE depends_on_shard_id=?)
      AND NOT EXISTS(SELECT 1 FROM work_shard_dependencies_v1 d JOIN work_shard_heads_v1 h ON h.shard_id=d.depends_on_shard_id
        WHERE d.shard_id=work_shard_heads_v1.shard_id AND h.status<>'SUCCEEDED')`).run(eventSequence, shardId);
  }

  currentView(goalId: string): HarnessCurrentView | null {
    this.assertAvailable();
    const run = this.connection.prepare(`SELECT r.run_id,r.goal_id,r.workspace_id,h.requested_topology,h.effective_topology,h.topology_revision,h.status
      FROM managed_runs_v1 r JOIN managed_run_heads_v1 h ON h.run_id=r.run_id WHERE r.goal_id=?`).get(goalId) as Record<string, unknown> | undefined;
    if (!run) return null;
    const runId = text(run.run_id, "run_id");
    const shardRows = this.connection.prepare(`SELECT s.shard_id,s.work_cell_id,s.role,h.status,h.attempt_count,h.latest_worker_run_id,h.result_sha256
      FROM work_shards_v1 s JOIN work_shard_heads_v1 h ON h.shard_id=s.shard_id WHERE s.run_id=? ORDER BY s.work_cell_id,s.ordinal`).all(runId) as Record<string, unknown>[];
    const unresolved = this.connection.prepare(`SELECT DISTINCT w.worker_run_id FROM worker_runs_v1 w
      JOIN worker_run_transitions_v1 t ON t.worker_run_id=w.worker_run_id
      WHERE w.run_id=? AND t.ordinal=(SELECT MAX(t2.ordinal) FROM worker_run_transitions_v1 t2 WHERE t2.worker_run_id=w.worker_run_id)
        AND t.state IN ('STARTING','RUNNING') ORDER BY w.created_event_sequence`).all(runId) as Record<string, unknown>[];
    const ready = shardRows.find((row) => row.status === "READY");
    return {
      runId, goalId: text(run.goal_id, "goal_id"), workspaceId: text(run.workspace_id, "workspace_id"),
      requestedTopology: text(run.requested_topology, "requested_topology") as HarnessCurrentView["requestedTopology"],
      effectiveTopology: text(run.effective_topology, "effective_topology") as HarnessCurrentView["effectiveTopology"],
      topologyRevision: integer(run.topology_revision, "topology_revision", 1), status: text(run.status, "status") as ManagedRunStatus,
      nextReadyShardId: ready ? text(ready.shard_id, "ready shard") : null,
      unresolvedWorkerRunIds: unresolved.map((row) => text(row.worker_run_id, "worker_run_id")),
      shards: shardRows.map((row) => ({
        shardId: text(row.shard_id, "shard_id"), workCellId: text(row.work_cell_id, "work_cell_id"),
        role: text(row.role, "role") as WorkShardRecord["role"], status: text(row.status, "status") as WorkShardStatus,
        attemptCount: integer(row.attempt_count, "attempt_count"), latestWorkerRunId: row.latest_worker_run_id === null ? null : text(row.latest_worker_run_id, "latest_worker_run_id"),
        resultSha256: row.result_sha256 === null ? null : sha(row.result_sha256, "result_sha256"),
      })),
    };
  }

  activeRunForWorkspace(workspaceId: string): ActiveManagedRunRef | null {
    this.assertAvailable();
    if (!workspaceId.trim()) throw new TypeError("Harness workspace ID is required");
    const rows = this.connection.prepare(`SELECT r.run_id,r.goal_id,h.status,
      CASE WHEN t.status IN ('SUCCEEDED','FAILED','CANCELED') THEN t.status ELSE NULL END task_flow_terminal_status
      FROM managed_runs_v1 r JOIN managed_run_heads_v1 h ON h.run_id=r.run_id
      JOIN task_flow_goal_heads_v1 t ON t.goal_id=r.goal_id
      WHERE r.workspace_id=? AND h.status NOT IN ('SUCCEEDED','FAILED','CANCELED')
      ORDER BY r.created_event_sequence LIMIT 2`).all(workspaceId) as Record<string, unknown>[];
    if (rows.length > 1) throw new AuthorityIntegrityError("Workspace has multiple active ManagedRuns");
    const row = rows[0];
    if (!row) return null;
    const terminal = row.task_flow_terminal_status === null ? null : text(row.task_flow_terminal_status, "Task Flow terminal status");
    if (terminal !== null && !["SUCCEEDED", "FAILED", "CANCELED"].includes(terminal)) {
      throw new AuthorityIntegrityError("Task Flow terminal status is invalid");
    }
    return {
      runId: text(row.run_id, "run_id"), goalId: text(row.goal_id, "goal_id"),
      status: text(row.status, "ManagedRun status") as ManagedRunStatus,
      taskFlowTerminalStatus: terminal as ActiveManagedRunRef["taskFlowTerminalStatus"],
    };
  }

  shardExecutionView(goalId: string, shardId: string): HarnessShardExecutionView | null {
    this.assertAvailable();
    const row = this.connection.prepare(`SELECT s.*,h.status,h.attempt_count,h.latest_worker_run_id,h.result_sha256,
      COALESCE(l.generation,0) latest_lease_generation,COALESCE(l.fencing_token,0) latest_fencing_token
      FROM work_shards_v1 s JOIN work_shard_heads_v1 h ON h.shard_id=s.shard_id
      LEFT JOIN shard_lease_heads_v1 l ON l.shard_id=s.shard_id WHERE s.goal_id=? AND s.shard_id=?`).get(goalId, shardId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const dependencies = (this.connection.prepare("SELECT depends_on_shard_id FROM work_shard_dependencies_v1 WHERE shard_id=? ORDER BY depends_on_shard_id")
      .all(shardId) as Record<string, unknown>[]).map((entry) => text(entry.depends_on_shard_id, "depends_on_shard_id"));
    const spec: WorkShardRecord = {
      schema_version: 1, shard_id: text(row.shard_id, "shard_id"), run_id: text(row.run_id, "run_id"),
      goal_id: text(row.goal_id, "goal_id"), work_cell_id: text(row.work_cell_id, "work_cell_id"),
      logical_key: text(row.logical_key, "logical_key"), ordinal: integer(row.ordinal, "ordinal"),
      role: text(row.role, "role") as WorkShardRecord["role"], outcome: text(row.outcome, "outcome"), dependencies,
      read_roots: parseJson<readonly string[]>(row.read_roots_json, "read_roots"),
      write_roots: parseJson<readonly string[]>(row.write_roots_json, "write_roots"),
      oracle: parseJson<Readonly<Record<string, unknown>>>(row.oracle_json, "oracle"),
      packet_budget: parseJson<Readonly<Record<string, unknown>>>(row.packet_budget_json, "packet_budget"),
      spec_sha256: sha(row.spec_sha256, "spec_sha256"),
    };
    assertWorkShard(spec);
    const dependencyEvidence = (this.connection.prepare(`SELECT s.shard_id,s.role,r.result_kind,r.artifact_sha256,r.trust
      FROM work_shard_dependencies_v1 d JOIN work_shards_v1 s ON s.shard_id=d.depends_on_shard_id
      JOIN work_shard_heads_v1 h ON h.shard_id=s.shard_id
      JOIN worker_results_v1 r ON r.record_sha256=h.result_sha256
      WHERE d.shard_id=? AND h.status='SUCCEEDED' ORDER BY s.ordinal,s.shard_id`).all(shardId) as Record<string, unknown>[])
      .map((entry): HarnessDependencyEvidence => ({
        shardId: text(entry.shard_id, "dependency shard_id"),
        role: text(entry.role, "dependency role") as WorkShardRecord["role"],
        resultKind: text(entry.result_kind, "dependency result_kind") as WorkerResultRecord["result_kind"],
        artifactSha256: sha(entry.artifact_sha256, "dependency artifact_sha256"),
        trust: text(entry.trust, "dependency trust") as WorkerResultRecord["trust"],
      }));
    if (text(row.status, "status") === "READY" && dependencyEvidence.length !== dependencies.length) {
      throw new AuthorityIntegrityError("Ready WorkShard dependency evidence closure is incomplete");
    }
    return {
      spec, status: text(row.status, "status") as WorkShardStatus, attemptCount: integer(row.attempt_count, "attempt_count"),
      latestWorkerRunId: row.latest_worker_run_id === null ? null : text(row.latest_worker_run_id, "latest_worker_run_id"),
      resultSha256: row.result_sha256 === null ? null : sha(row.result_sha256, "result_sha256"),
      latestLeaseGeneration: integer(row.latest_lease_generation, "latest_lease_generation"),
      latestFencingToken: integer(row.latest_fencing_token, "latest_fencing_token"),
      dependencyEvidence,
    };
  }

  workerRecoveryView(goalId: string, workerRunId: string): HarnessWorkerRecoveryView | null {
    this.assertAvailable();
    const row = this.connection.prepare(`SELECT w.worker_run_id,w.run_id,w.shard_id,w.attempt,t.state,t.ordinal,t.transition_sha256
      FROM worker_runs_v1 w JOIN work_shards_v1 s ON s.shard_id=w.shard_id
      JOIN worker_run_transitions_v1 t ON t.worker_run_id=w.worker_run_id
      WHERE s.goal_id=? AND w.worker_run_id=?
        AND t.ordinal=(SELECT MAX(t2.ordinal) FROM worker_run_transitions_v1 t2 WHERE t2.worker_run_id=w.worker_run_id)
        AND t.state IN ('STARTING','RUNNING')`).get(goalId, workerRunId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      workerRunId: text(row.worker_run_id, "worker_run_id"), runId: text(row.run_id, "run_id"),
      shardId: text(row.shard_id, "shard_id"), attempt: integer(row.attempt, "attempt", 1),
      state: text(row.state, "state") as "STARTING" | "RUNNING", ordinal: integer(row.ordinal, "ordinal"),
      transitionSha256: sha(row.transition_sha256, "transition_sha256"),
    };
  }

  verifyIntegrity(): HarnessIntegritySummary {
    if (!this.available()) return {
      available: false, runs: 0, topologyRevisions: 0, shards: 0, workerRuns: 0, integrations: 0,
      patchTransactions: 0, openPatchTransactions: 0, headMismatches: 0, leaseMismatches: 0,
      dependencyMismatches: 0, patchTransactionMismatches: 0,
    };
    const count = (table: string): number => Number((this.connection.prepare(`SELECT count(*) count FROM ${table}`).get() as { count?: unknown } | undefined)?.count ?? 0);
    const headMismatches = Number((this.connection.prepare(`SELECT count(*) count FROM managed_run_heads_v1 h
      LEFT JOIN topology_revisions_v1 t ON t.run_id=h.run_id AND t.revision=h.topology_revision
      WHERE t.run_id IS NULL OR t.requested_topology<>h.requested_topology OR t.effective_topology<>h.effective_topology`).get() as { count?: unknown } | undefined)?.count ?? 0)
      + Number((this.connection.prepare(`SELECT count(*) count FROM work_shards_v1 s LEFT JOIN work_shard_heads_v1 h ON h.shard_id=s.shard_id WHERE h.shard_id IS NULL`)
        .get() as { count?: unknown } | undefined)?.count ?? 0);
    const leaseMismatches = Number((this.connection.prepare(`SELECT count(*) count FROM work_shard_heads_v1 s
      JOIN worker_runs_v1 w ON w.worker_run_id=s.latest_worker_run_id LEFT JOIN shard_lease_heads_v1 l ON l.shard_id=s.shard_id
      WHERE s.status='RUNNING' AND (l.worker_run_id<>w.worker_run_id OR l.generation<>w.lease_generation OR l.fencing_token<>w.fencing_token OR l.released_at_ms IS NOT NULL)`).get() as { count?: unknown } | undefined)?.count ?? 0);
    const dependencyMismatches = Number((this.connection.prepare(`SELECT count(*) count FROM work_shard_dependencies_v1 d
      JOIN work_shards_v1 s ON s.shard_id=d.shard_id JOIN work_shards_v1 p ON p.shard_id=d.depends_on_shard_id
      WHERE s.run_id<>p.run_id OR s.work_cell_id<>p.work_cell_id`).get() as { count?: unknown } | undefined)?.count ?? 0);
    const patchTransactionMismatches = Number((this.connection.prepare(`SELECT count(*) count
      FROM patch_transaction_preparations_v1 p
      LEFT JOIN patch_sets_v1 ps ON ps.patch_set_id=p.patch_set_id
      LEFT JOIN work_shards_v1 s ON s.shard_id=p.shard_id
      LEFT JOIN managed_runs_v1 r ON r.run_id=p.run_id
      LEFT JOIN artifacts a ON a.artifact_id=p.journal_artifact_id
      WHERE ps.patch_set_id IS NULL OR s.shard_id IS NULL OR r.run_id IS NULL OR a.artifact_id IS NULL
        OR ps.run_id<>p.run_id OR ps.shard_id<>p.shard_id OR s.goal_id<>p.goal_id OR r.goal_id<>p.goal_id
        OR a.sha256<>p.journal_sha256 OR a.media_type<>'application/vnd.pch.patch-transaction+json'`).get() as { count?: unknown } | undefined)?.count ?? 0)
      + Number((this.connection.prepare(`SELECT count(*) count FROM integration_receipts_v1 i
        LEFT JOIN patch_transaction_preparations_v1 p ON p.patch_set_id=i.patch_set_id
        WHERE (i.patch_set_id IS NULL AND i.transaction_journal_sha256 IS NOT NULL)
          OR (i.patch_set_id IS NOT NULL AND (p.patch_set_id IS NULL OR i.transaction_journal_sha256<>p.journal_sha256))`).get() as { count?: unknown } | undefined)?.count ?? 0)
      + Number((this.connection.prepare(`SELECT count(*) count FROM patch_transaction_preparations_v1 p
        JOIN work_shard_heads_v1 h ON h.shard_id=p.shard_id
        LEFT JOIN integration_receipts_v1 i ON i.patch_set_id=p.patch_set_id
        WHERE (i.integration_id IS NULL AND h.status<>'INTEGRATING')
          OR (i.result='OUTCOME_UNKNOWN' AND h.status<>'INTEGRATING')
          OR (i.result<>'OUTCOME_UNKNOWN' AND i.integration_id IS NOT NULL AND h.status='INTEGRATING')`).get() as { count?: unknown } | undefined)?.count ?? 0);
    const openPatchTransactions = Number((this.connection.prepare(`SELECT count(*) count
      FROM patch_transaction_preparations_v1 p LEFT JOIN integration_receipts_v1 i ON i.patch_set_id=p.patch_set_id
      WHERE i.integration_id IS NULL`).get() as { count?: unknown } | undefined)?.count ?? 0);
    if (headMismatches + leaseMismatches + dependencyMismatches + patchTransactionMismatches !== 0) {
      throw new AuthorityIntegrityError("Pi Coding Harness authority projections are inconsistent");
    }
    return { available: true, runs: count("managed_runs_v1"), topologyRevisions: count("topology_revisions_v1"), shards: count("work_shards_v1"),
      workerRuns: count("worker_runs_v1"), integrations: count("integration_receipts_v1"),
      patchTransactions: count("patch_transaction_preparations_v1"), openPatchTransactions,
      headMismatches, leaseMismatches, dependencyMismatches, patchTransactionMismatches };
  }
}
