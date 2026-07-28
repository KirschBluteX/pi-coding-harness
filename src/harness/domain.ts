import { canonicalJsonSha256, omitProperty } from "../authority/canonical-json.js";

export const executionTopologies = ["SINGLE", "MULTI"] as const;
export const workerRoles = ["PLANNER", "EXPLORER", "IMPLEMENTER", "VERIFIER", "INTEGRATOR"] as const;
export const workShardStatuses = [
  "PROPOSED", "READY", "LEASED", "RUNNING", "RESULT_SUBMITTED", "INTEGRATING",
  "SUCCEEDED", "REJECTED", "CANCELED", "SUPERSEDED", "FAILED",
] as const;
export const sandboxKinds = ["NONE_READ_ONLY", "SCOPED_MIRROR", "DIRECTORY_CLONE", "GIT_WORKTREE", "CONTAINER_OVERLAY"] as const;

export type ExecutionTopology = typeof executionTopologies[number];
export type WorkerRole = typeof workerRoles[number];
export type WorkShardStatus = typeof workShardStatuses[number];
export type SandboxKind = typeof sandboxKinds[number];
export type ManagedRunStatus = "ACTIVE" | "PAUSED" | "RECONCILING" | "SUCCEEDED" | "FAILED" | "CANCELED";
export type WorkerRunState = "STARTING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "ABORTED" | "TIMED_OUT" | "FENCED";

export interface ManagedRunRecord {
  readonly schema_version: 1;
  readonly run_id: string;
  readonly goal_id: string;
  readonly workspace_id: string;
  readonly created_by_host_hmac: string;
  readonly initial_config_sha256: string;
  readonly created_at_ms: number;
  readonly record_sha256: string;
}

export interface TopologyRevisionRecord {
  readonly schema_version: 1;
  readonly run_id: string;
  readonly revision: number;
  readonly requested_topology: ExecutionTopology;
  readonly effective_topology: ExecutionTopology;
  readonly reason_code: string;
  readonly decision_sha256: string;
  readonly config_sha256: string;
  readonly created_at_ms: number;
  readonly record_sha256: string;
}

export interface WorkShardRecord {
  readonly schema_version: 1;
  readonly shard_id: string;
  readonly run_id: string;
  readonly goal_id: string;
  readonly work_cell_id: string;
  readonly logical_key: string;
  readonly ordinal: number;
  readonly role: "SUPERVISOR" | WorkerRole;
  readonly outcome: string;
  readonly dependencies: readonly string[];
  readonly read_roots: readonly string[];
  readonly write_roots: readonly string[];
  readonly oracle: Readonly<Record<string, unknown>>;
  readonly packet_budget: Readonly<Record<string, unknown>>;
  readonly spec_sha256: string;
}

export interface TaskPacketRecord {
  readonly schema_version: 1;
  readonly packet_id: string;
  readonly run_id: string;
  readonly shard_id: string;
  readonly attempt: number;
  readonly subject_binding_sha256: string;
  readonly task: string;
  readonly goal_contract_sha256: string;
  readonly route_sha256: string;
  readonly work_cell_sha256: string;
  readonly evidence_refs: readonly string[];
  readonly shared_memory: {
    readonly schema_version: 1;
    readonly audience: "VERIFIED_SHARED";
    readonly content: string;
    readonly manifest_sha256: string;
    readonly binding_sha256s: readonly string[];
  } | null;
  readonly failure_signatures: readonly string[];
  readonly packet_sha256: string;
  readonly capability_hmac: string;
  readonly expires_at_ms: number;
}

export interface ShardLeaseGenerationRecord {
  readonly schema_version: 1;
  readonly shard_id: string;
  readonly generation: number;
  readonly fencing_token: number;
  readonly owner_hmac: string;
  readonly expires_at_ms: number;
  readonly lease_sha256: string;
}

export interface WorkerRunRecord {
  readonly schema_version: 1;
  readonly worker_run_id: string;
  readonly run_id: string;
  readonly shard_id: string;
  readonly packet_id: string;
  readonly role: WorkerRole;
  readonly attempt: number;
  readonly lease_generation: number;
  readonly fencing_token: number;
  readonly sandbox_kind: SandboxKind;
  readonly model_fingerprint_hmac: string;
  readonly created_at_ms: number;
  readonly record_sha256: string;
}

export interface WorkerUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly reasoning: number | null;
  readonly cost: number | null;
  readonly turns: number;
  readonly wallTimeMs: number;
}

export interface WorkerRunTransitionRecord {
  readonly schema_version: 1;
  readonly transition_id: string;
  readonly worker_run_id: string;
  readonly ordinal: number;
  readonly state: WorkerRunState;
  readonly output_sha256: string | null;
  readonly usage: WorkerUsage;
  readonly failure_signature_sha256: string | null;
  readonly predecessor_sha256: string | null;
  readonly created_at_ms: number;
  readonly transition_sha256: string;
}

export interface WorkerResultRecord {
  readonly schema_version: 1;
  readonly result_id: string;
  readonly worker_run_id: string;
  readonly run_id: string;
  readonly shard_id: string;
  readonly result_kind: "ANALYSIS" | "PLAN" | "PATCH" | "VERIFICATION" | "INTEGRATION" | "NO_CHANGES";
  readonly artifact_sha256: string;
  readonly artifact_locator_hmac: string;
  readonly trust: "UNVERIFIED" | "VERIFIED" | "REJECTED";
  readonly created_at_ms: number;
  readonly record_sha256: string;
}

export interface PatchEntry {
  readonly operation: "CREATE" | "MODIFY" | "DELETE";
  readonly path: string;
  readonly before_sha256: string | null;
  readonly after_sha256: string | null;
  readonly content_locator: string | null;
  readonly byte_length: number;
}

export interface PatchSetRecord {
  readonly schema_version: 1;
  readonly patch_set_id: string;
  readonly run_id: string;
  readonly shard_id: string;
  readonly worker_run_id: string;
  readonly baseline_sha256: string;
  readonly entries: readonly PatchEntry[];
  readonly patch_sha256: string;
  readonly created_at_ms: number;
}

export interface IntegrationReceiptRecord {
  readonly schema_version: 1;
  readonly integration_id: string;
  readonly run_id: string;
  readonly shard_id: string;
  readonly patch_set_id: string | null;
  readonly transaction_journal_sha256: string | null;
  readonly result: "APPLIED" | "NO_CHANGES" | "CONFLICT" | "REJECTED" | "OUTCOME_UNKNOWN";
  readonly preimage_root_sha256: string;
  readonly postimage_root_sha256: string | null;
  readonly conflict_paths: readonly string[];
  readonly operation_ids: readonly string[];
  readonly created_at_ms: number;
  readonly receipt_sha256: string;
}

export interface ExecutionSubjectRefV2 {
  readonly kind: "NONE" | "GOAL" | "WORK_CELL" | "WORK_SHARD" | "WORKER_RUN" | "INTEGRATION";
  readonly run_id: string | null;
  readonly goal_id: string | null;
  readonly work_cell_id: string | null;
  readonly shard_id: string | null;
  readonly worker_run_id: string | null;
  readonly role: "SUPERVISOR" | WorkerRole | null;
  readonly topology_revision: number | null;
  readonly attempt: number | null;
  readonly goal_contract_sha256: string | null;
  readonly route_sha256: string | null;
  readonly authorization_sha256: string | null;
  readonly binding_sha256: string;
}

export interface MemoryVisibilityBindingRecord {
  readonly schema_version: 1;
  readonly claim_id: string;
  readonly claim_version: number;
  readonly audience: "SUPERVISOR_PRIVATE" | "ROLE_LOCAL" | "VERIFIED_SHARED";
  readonly role: WorkerRole | null;
  readonly module_key: string | null;
  readonly verifier_receipt_sha256: string | null;
  readonly binding_sha256: string;
}

const idPattern = /^[A-Z][A-Z0-9_:-]{0,159}$/u;
const shaPattern = /^[a-f0-9]{64}$/u;
const casPattern = /^pch-cas:\/\/sha256\/[a-f0-9]{64}$/u;

function object(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
}

function id(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !idPattern.test(value)) throw new TypeError(`${label} is invalid`);
}

function sha(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !shaPattern.test(value)) throw new TypeError(`${label} is invalid`);
}

function nullableSha(value: unknown, label: string): asserts value is string | null {
  if (value !== null) sha(value, label);
}

function integer(value: unknown, label: string, minimum = 0): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new TypeError(`${label} is invalid`);
}

function boundedText(value: unknown, label: string, maximum = 32768): asserts value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || value !== value.normalize("NFC")) {
    throw new TypeError(`${label} is invalid`);
  }
}

function enumValue<T extends string>(value: unknown, values: readonly T[], label: string): asserts value is T {
  if (typeof value !== "string" || !values.includes(value as T)) throw new TypeError(`${label} is invalid`);
}

function stringArray(value: unknown, label: string, maximum = 4096): asserts value is readonly string[] {
  if (!Array.isArray(value) || value.length > maximum || value.some((entry) => typeof entry !== "string")) {
    throw new TypeError(`${label} is invalid`);
  }
}

function relativePath(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 1024 || value.includes("\\") || value.startsWith("/")
    || value.includes("\0") || value.split("/").some((part) => part === "" || part === "." || part === "..")
    || /^[A-Za-z]:/u.test(value)) throw new TypeError(`${label} is not a canonical relative path`);
}

function assertSealed(domain: string, value: object, field: string): void {
  const row = value as Record<string, unknown>;
  const actual = row[field];
  sha(actual, `${domain}.${field}`);
  const expected = canonicalJsonSha256({
    domain,
    ...Object.fromEntries(Object.entries(row).filter(([key]) => key !== field)),
  });
  if (actual !== expected) throw new TypeError(`${domain} canonical hash mismatch`);
}

export function assertManagedRun(value: unknown): asserts value is ManagedRunRecord {
  object(value, "ManagedRun");
  if (value.schema_version !== 1) throw new TypeError("ManagedRun schema version is invalid");
  id(value.run_id, "ManagedRun.run_id"); id(value.goal_id, "ManagedRun.goal_id"); id(value.workspace_id, "ManagedRun.workspace_id");
  sha(value.created_by_host_hmac, "ManagedRun.created_by_host_hmac"); sha(value.initial_config_sha256, "ManagedRun.initial_config_sha256");
  integer(value.created_at_ms, "ManagedRun.created_at_ms");
  assertSealed("PCH-MANAGED-RUN-V1", value, "record_sha256");
}

export function assertTopologyRevision(value: unknown): asserts value is TopologyRevisionRecord {
  object(value, "TopologyRevision");
  if (value.schema_version !== 1) throw new TypeError("TopologyRevision schema version is invalid");
  id(value.run_id, "TopologyRevision.run_id"); integer(value.revision, "TopologyRevision.revision", 1);
  enumValue(value.requested_topology, executionTopologies, "TopologyRevision.requested_topology");
  enumValue(value.effective_topology, executionTopologies, "TopologyRevision.effective_topology");
  boundedText(value.reason_code, "TopologyRevision.reason_code", 160); sha(value.decision_sha256, "TopologyRevision.decision_sha256");
  sha(value.config_sha256, "TopologyRevision.config_sha256"); integer(value.created_at_ms, "TopologyRevision.created_at_ms");
  assertSealed("PCH-TOPOLOGY-REVISION-V1", value, "record_sha256");
}

export function assertWorkShard(value: unknown): asserts value is WorkShardRecord {
  object(value, "WorkShard");
  if (value.schema_version !== 1) throw new TypeError("WorkShard schema version is invalid");
  id(value.shard_id, "WorkShard.shard_id"); id(value.run_id, "WorkShard.run_id"); id(value.goal_id, "WorkShard.goal_id");
  id(value.work_cell_id, "WorkShard.work_cell_id"); boundedText(value.logical_key, "WorkShard.logical_key", 160);
  integer(value.ordinal, "WorkShard.ordinal");
  enumValue(value.role, ["SUPERVISOR", ...workerRoles] as const, "WorkShard.role"); boundedText(value.outcome, "WorkShard.outcome");
  stringArray(value.dependencies, "WorkShard.dependencies"); stringArray(value.read_roots, "WorkShard.read_roots");
  stringArray(value.write_roots, "WorkShard.write_roots"); object(value.oracle, "WorkShard.oracle"); object(value.packet_budget, "WorkShard.packet_budget");
  for (const dependency of value.dependencies) id(dependency, "WorkShard.dependencies[]");
  assertSealed("PCH-WORK-SHARD-V1", value, "spec_sha256");
}

export function packetContentSha256(value: Omit<TaskPacketRecord, "packet_sha256" | "capability_hmac">): string {
  return canonicalJsonSha256({ domain: "PCH-TASK-PACKET-V1", ...value });
}

export function assertTaskPacket(value: unknown): asserts value is TaskPacketRecord {
  object(value, "TaskPacket");
  if (value.schema_version !== 1) throw new TypeError("TaskPacket schema version is invalid");
  id(value.packet_id, "TaskPacket.packet_id"); id(value.run_id, "TaskPacket.run_id"); id(value.shard_id, "TaskPacket.shard_id");
  integer(value.attempt, "TaskPacket.attempt", 1); sha(value.subject_binding_sha256, "TaskPacket.subject_binding_sha256");
  boundedText(value.task, "TaskPacket.task", 131072); sha(value.goal_contract_sha256, "TaskPacket.goal_contract_sha256");
  sha(value.route_sha256, "TaskPacket.route_sha256"); sha(value.work_cell_sha256, "TaskPacket.work_cell_sha256");
  stringArray(value.evidence_refs, "TaskPacket.evidence_refs"); stringArray(value.failure_signatures, "TaskPacket.failure_signatures");
  if (value.shared_memory !== null) {
    object(value.shared_memory, "TaskPacket.shared_memory");
    if (value.shared_memory.schema_version !== 1 || value.shared_memory.audience !== "VERIFIED_SHARED") {
      throw new TypeError("TaskPacket shared Memory contract is invalid");
    }
    boundedText(value.shared_memory.content, "TaskPacket.shared_memory.content", 16_384);
    sha(value.shared_memory.manifest_sha256, "TaskPacket.shared_memory.manifest_sha256");
    stringArray(value.shared_memory.binding_sha256s, "TaskPacket.shared_memory.binding_sha256s", 64);
    if (value.shared_memory.binding_sha256s.length === 0) throw new TypeError("TaskPacket shared Memory requires bindings");
    for (const binding of value.shared_memory.binding_sha256s) sha(binding, "TaskPacket.shared_memory.binding_sha256s[]");
  }
  for (const signature of value.failure_signatures) sha(signature, "TaskPacket.failure_signatures[]");
  sha(value.packet_sha256, "TaskPacket.packet_sha256"); sha(value.capability_hmac, "TaskPacket.capability_hmac");
  integer(value.expires_at_ms, "TaskPacket.expires_at_ms");
  const content = omitProperty(omitProperty(value as unknown as TaskPacketRecord, "packet_sha256"), "capability_hmac");
  if (value.packet_sha256 !== packetContentSha256(content)) throw new TypeError("TaskPacket canonical hash mismatch");
}

export function assertShardLease(value: unknown): asserts value is ShardLeaseGenerationRecord {
  object(value, "ShardLease");
  if (value.schema_version !== 1) throw new TypeError("ShardLease schema version is invalid");
  id(value.shard_id, "ShardLease.shard_id"); integer(value.generation, "ShardLease.generation", 1);
  integer(value.fencing_token, "ShardLease.fencing_token", 1); sha(value.owner_hmac, "ShardLease.owner_hmac");
  integer(value.expires_at_ms, "ShardLease.expires_at_ms"); assertSealed("PCH-SHARD-LEASE-V1", value, "lease_sha256");
}

export function assertWorkerRun(value: unknown): asserts value is WorkerRunRecord {
  object(value, "WorkerRun");
  if (value.schema_version !== 1) throw new TypeError("WorkerRun schema version is invalid");
  id(value.worker_run_id, "WorkerRun.worker_run_id"); id(value.run_id, "WorkerRun.run_id"); id(value.shard_id, "WorkerRun.shard_id");
  id(value.packet_id, "WorkerRun.packet_id"); enumValue(value.role, workerRoles, "WorkerRun.role");
  integer(value.attempt, "WorkerRun.attempt", 1); integer(value.lease_generation, "WorkerRun.lease_generation", 1);
  integer(value.fencing_token, "WorkerRun.fencing_token", 1); enumValue(value.sandbox_kind, sandboxKinds, "WorkerRun.sandbox_kind");
  sha(value.model_fingerprint_hmac, "WorkerRun.model_fingerprint_hmac"); integer(value.created_at_ms, "WorkerRun.created_at_ms");
  assertSealed("PCH-WORKER-RUN-V1", value, "record_sha256");
}

export function assertWorkerTransition(value: unknown): asserts value is WorkerRunTransitionRecord {
  object(value, "WorkerRunTransition");
  if (value.schema_version !== 1) throw new TypeError("WorkerRunTransition schema version is invalid");
  id(value.transition_id, "WorkerRunTransition.transition_id"); id(value.worker_run_id, "WorkerRunTransition.worker_run_id");
  integer(value.ordinal, "WorkerRunTransition.ordinal");
  enumValue(value.state, ["STARTING", "RUNNING", "SUCCEEDED", "FAILED", "ABORTED", "TIMED_OUT", "FENCED"] as const, "WorkerRunTransition.state");
  nullableSha(value.output_sha256, "WorkerRunTransition.output_sha256"); nullableSha(value.failure_signature_sha256, "WorkerRunTransition.failure_signature_sha256");
  nullableSha(value.predecessor_sha256, "WorkerRunTransition.predecessor_sha256"); object(value.usage, "WorkerRunTransition.usage");
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "turns", "wallTimeMs"] as const) integer(value.usage[key], `WorkerUsage.${key}`);
  if (value.usage.reasoning !== null) integer(value.usage.reasoning, "WorkerUsage.reasoning");
  if (value.usage.cost !== null && (typeof value.usage.cost !== "number" || !Number.isFinite(value.usage.cost) || value.usage.cost < 0)) throw new TypeError("WorkerUsage.cost is invalid");
  integer(value.created_at_ms, "WorkerRunTransition.created_at_ms"); assertSealed("PCH-WORKER-TRANSITION-V1", value, "transition_sha256");
}

export function assertWorkerResult(value: unknown): asserts value is WorkerResultRecord {
  object(value, "WorkerResult");
  if (value.schema_version !== 1) throw new TypeError("WorkerResult schema version is invalid");
  id(value.result_id, "WorkerResult.result_id"); id(value.worker_run_id, "WorkerResult.worker_run_id");
  id(value.run_id, "WorkerResult.run_id"); id(value.shard_id, "WorkerResult.shard_id");
  enumValue(value.result_kind, ["ANALYSIS", "PLAN", "PATCH", "VERIFICATION", "INTEGRATION", "NO_CHANGES"] as const, "WorkerResult.result_kind");
  sha(value.artifact_sha256, "WorkerResult.artifact_sha256"); sha(value.artifact_locator_hmac, "WorkerResult.artifact_locator_hmac");
  enumValue(value.trust, ["UNVERIFIED", "VERIFIED", "REJECTED"] as const, "WorkerResult.trust");
  integer(value.created_at_ms, "WorkerResult.created_at_ms"); assertSealed("PCH-WORKER-RESULT-V1", value, "record_sha256");
}

export function assertPatchSet(value: unknown): asserts value is PatchSetRecord {
  object(value, "PatchSet");
  if (value.schema_version !== 1) throw new TypeError("PatchSet schema version is invalid");
  id(value.patch_set_id, "PatchSet.patch_set_id"); id(value.run_id, "PatchSet.run_id"); id(value.shard_id, "PatchSet.shard_id");
  id(value.worker_run_id, "PatchSet.worker_run_id"); sha(value.baseline_sha256, "PatchSet.baseline_sha256");
  if (!Array.isArray(value.entries) || value.entries.length > 4096) throw new TypeError("PatchSet.entries is invalid");
  const paths = new Set<string>();
  for (const entry of value.entries) {
    object(entry, "PatchEntry"); enumValue(entry.operation, ["CREATE", "MODIFY", "DELETE"] as const, "PatchEntry.operation");
    relativePath(entry.path, "PatchEntry.path");
    if (paths.has(entry.path)) throw new TypeError("PatchSet contains duplicate paths");
    paths.add(entry.path); nullableSha(entry.before_sha256, "PatchEntry.before_sha256"); nullableSha(entry.after_sha256, "PatchEntry.after_sha256");
    if (entry.content_locator !== null && (typeof entry.content_locator !== "string" || !casPattern.test(entry.content_locator))) throw new TypeError("PatchEntry.content_locator is invalid");
    integer(entry.byte_length, "PatchEntry.byte_length");
    if (entry.operation === "CREATE" && (entry.before_sha256 !== null || entry.after_sha256 === null || entry.content_locator === null)) throw new TypeError("CREATE patch contract is invalid");
    if (entry.operation === "MODIFY" && (entry.before_sha256 === null || entry.after_sha256 === null || entry.content_locator === null)) throw new TypeError("MODIFY patch contract is invalid");
    if (entry.operation === "DELETE" && (entry.before_sha256 === null || entry.after_sha256 !== null || entry.content_locator !== null || entry.byte_length !== 0)) throw new TypeError("DELETE patch contract is invalid");
  }
  integer(value.created_at_ms, "PatchSet.created_at_ms"); assertSealed("PCH-PATCH-SET-V1", value, "patch_sha256");
}

export function assertIntegrationReceipt(value: unknown): asserts value is IntegrationReceiptRecord {
  object(value, "IntegrationReceipt");
  if (value.schema_version !== 1) throw new TypeError("IntegrationReceipt schema version is invalid");
  id(value.integration_id, "IntegrationReceipt.integration_id"); id(value.run_id, "IntegrationReceipt.run_id"); id(value.shard_id, "IntegrationReceipt.shard_id");
  if (value.patch_set_id !== null) id(value.patch_set_id, "IntegrationReceipt.patch_set_id");
  nullableSha(value.transaction_journal_sha256, "IntegrationReceipt.transaction_journal_sha256");
  enumValue(value.result, ["APPLIED", "NO_CHANGES", "CONFLICT", "REJECTED", "OUTCOME_UNKNOWN"] as const, "IntegrationReceipt.result");
  sha(value.preimage_root_sha256, "IntegrationReceipt.preimage_root_sha256"); nullableSha(value.postimage_root_sha256, "IntegrationReceipt.postimage_root_sha256");
  stringArray(value.conflict_paths, "IntegrationReceipt.conflict_paths"); for (const path of value.conflict_paths) relativePath(path, "IntegrationReceipt.conflict_paths[]");
  stringArray(value.operation_ids, "IntegrationReceipt.operation_ids"); for (const operationId of value.operation_ids) id(operationId, "IntegrationReceipt.operation_ids[]");
  if (value.result === "CONFLICT" && value.conflict_paths.length === 0) throw new TypeError("CONFLICT requires conflict paths");
  if (!["CONFLICT", "OUTCOME_UNKNOWN"].includes(value.result) && value.conflict_paths.length > 0) {
    throw new TypeError("Only CONFLICT or OUTCOME_UNKNOWN may contain affected paths");
  }
  if (["APPLIED", "NO_CHANGES"].includes(value.result) && value.postimage_root_sha256 === null) throw new TypeError("Successful integration requires postimage");
  if ((value.patch_set_id === null) !== (value.transaction_journal_sha256 === null)) {
    throw new TypeError("Patch integrations require exactly one transaction journal binding");
  }
  integer(value.created_at_ms, "IntegrationReceipt.created_at_ms"); assertSealed("PCH-INTEGRATION-RECEIPT-V1", value, "receipt_sha256");
}

export function assertExecutionSubjectRefV2(value: unknown): asserts value is ExecutionSubjectRefV2 {
  object(value, "ExecutionSubjectRefV2");
  enumValue(value.kind, ["NONE", "GOAL", "WORK_CELL", "WORK_SHARD", "WORKER_RUN", "INTEGRATION"] as const, "ExecutionSubjectRefV2.kind");
  for (const [key, item] of [["run_id", value.run_id], ["goal_id", value.goal_id], ["work_cell_id", value.work_cell_id], ["shard_id", value.shard_id], ["worker_run_id", value.worker_run_id]] as const) {
    if (item !== null) id(item, `ExecutionSubjectRefV2.${key}`);
  }
  if (value.role !== null) enumValue(value.role, ["SUPERVISOR", ...workerRoles] as const, "ExecutionSubjectRefV2.role");
  if (value.topology_revision !== null) integer(value.topology_revision, "ExecutionSubjectRefV2.topology_revision", 1);
  if (value.attempt !== null) integer(value.attempt, "ExecutionSubjectRefV2.attempt", 1);
  nullableSha(value.goal_contract_sha256, "ExecutionSubjectRefV2.goal_contract_sha256"); nullableSha(value.route_sha256, "ExecutionSubjectRefV2.route_sha256");
  nullableSha(value.authorization_sha256, "ExecutionSubjectRefV2.authorization_sha256");
  const expected = canonicalJsonSha256({ domain: "PCH-EXECUTION-SUBJECT-V2", ...Object.fromEntries(Object.entries(value).filter(([key]) => key !== "binding_sha256")) });
  sha(value.binding_sha256, "ExecutionSubjectRefV2.binding_sha256");
  if (expected !== value.binding_sha256) throw new TypeError("ExecutionSubjectRefV2 canonical hash mismatch");
}

export function assertMemoryVisibilityBinding(value: unknown): asserts value is MemoryVisibilityBindingRecord {
  object(value, "MemoryVisibilityBinding");
  if (value.schema_version !== 1) throw new TypeError("MemoryVisibilityBinding schema version is invalid");
  id(value.claim_id, "MemoryVisibilityBinding.claim_id"); integer(value.claim_version, "MemoryVisibilityBinding.claim_version", 1);
  enumValue(value.audience, ["SUPERVISOR_PRIVATE", "ROLE_LOCAL", "VERIFIED_SHARED"] as const, "MemoryVisibilityBinding.audience");
  if (value.role !== null) enumValue(value.role, workerRoles, "MemoryVisibilityBinding.role");
  if (value.module_key !== null) boundedText(value.module_key, "MemoryVisibilityBinding.module_key", 160);
  nullableSha(value.verifier_receipt_sha256, "MemoryVisibilityBinding.verifier_receipt_sha256");
  if ((value.audience === "ROLE_LOCAL") !== (value.role !== null)) throw new TypeError("ROLE_LOCAL requires exactly one role");
  if (value.audience === "VERIFIED_SHARED" && value.verifier_receipt_sha256 === null) throw new TypeError("VERIFIED_SHARED requires a verifier receipt");
  assertSealed("PCH-MEMORY-VISIBILITY-V1", value, "binding_sha256");
}

export function sealHarnessRecord<T extends object, K extends keyof T & string>(domain: string, value: Omit<T, K>, field: K): T {
  return { ...value, [field]: canonicalJsonSha256({ domain, ...value }) } as T;
}

export function makeExecutionSubjectRefV2(value: Omit<ExecutionSubjectRefV2, "binding_sha256">): ExecutionSubjectRefV2 {
  const content = omitProperty(value as Omit<ExecutionSubjectRefV2, "binding_sha256"> & { readonly binding_sha256?: unknown }, "binding_sha256");
  return { ...content, binding_sha256: canonicalJsonSha256({ domain: "PCH-EXECUTION-SUBJECT-V2", ...content }) };
}
