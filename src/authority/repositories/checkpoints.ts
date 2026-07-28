import { canonicalJson, canonicalJsonSha256, parseCanonicalJson } from "../canonical-json.js";
import type { AuthorityConnection } from "../database.js";
import type { ProtectedTaskState } from "../../context/protected-projection.js";
import { validateProtectedState } from "../../context/protected-projection.js";
import { AuthorityIntegrityError } from "../../foundation/errors.js";
import type { MemoryCheckpointSnapshotRecord } from "../../memory/types.js";
import { verifyMemoryCheckpointSnapshot } from "../../memory/checkpoint.js";

export type CheckpointReason =
  | "CAPABILITY_PROBE" | "ASSUMPTION_CHANGED" | "SCHEMA_FROZEN" | "PLAN_FROZEN" | "STAGE_EXIT"
  | "FIRST_END_TO_END" | "BLOCKER_CHANGED" | "ROUTE_CHANGED" | "VALIDATION_RESULT"
  | "DO_NOT_REPEAT_RECORDED" | "PRE_COMPACTION" | "LONG_PAUSE" | "ENVIRONMENT_CHANGE"
  | "PERIODIC_EVENT_BOUND";

export interface MilestoneCheckpointRecord {
  readonly schema_version: 2;
  readonly record_type: "MILESTONE_CHECKPOINT";
  readonly record_id: string;
  readonly goal_id: string;
  readonly goal_version: number;
  readonly event_sequence: number;
  readonly reason: CheckpointReason;
  readonly created_at: string;
  readonly protected_state: ProtectedTaskState;
  readonly protected_state_sha256: string;
  readonly prev_checkpoint_sha256: string | null;
  readonly record_sha256: string;
}

export interface CheckpointInsert {
  readonly record: MilestoneCheckpointRecord;
  readonly snapshotId: string;
  readonly snapshotSha256: string;
  readonly memorySnapshot?: MemoryCheckpointSnapshotRecord;
}

function recordCore(record: MilestoneCheckpointRecord): Omit<MilestoneCheckpointRecord, "record_sha256"> {
  const { record_sha256: recordSha256, ...core } = record;
  void recordSha256;
  return core;
}

export function computeCheckpointRecordSha256(record: Omit<MilestoneCheckpointRecord, "record_sha256">): string {
  return canonicalJsonSha256(record);
}

export function computeProgressSnapshotSha256(input: {
  readonly snapshotId: string;
  readonly record: MilestoneCheckpointRecord;
}): string {
  return canonicalJsonSha256({
    snapshotId: input.snapshotId,
    goalId: input.record.goal_id,
    goalVersion: input.record.goal_version,
    eventSequence: input.record.event_sequence,
    reason: input.record.reason,
    protectedStateSha256: input.record.protected_state_sha256,
    createdAt: input.record.created_at,
  });
}

export function verifyCheckpointInsert(input: CheckpointInsert): void {
  const { record } = input;
  validateProtectedState(record.protected_state);
  const createdAtMs = Date.parse(record.created_at);
  if (!input.snapshotId || record.schema_version !== 2 || record.record_type !== "MILESTONE_CHECKPOINT"
    || record.goal_version !== record.event_sequence || !Number.isFinite(createdAtMs)
    || canonicalJsonSha256(record.protected_state) !== record.protected_state_sha256
    || computeCheckpointRecordSha256(recordCore(record)) !== record.record_sha256
    || computeProgressSnapshotSha256({ snapshotId: input.snapshotId, record }) !== input.snapshotSha256) {
    throw new AuthorityIntegrityError("Checkpoint record fields or hashes are inconsistent");
  }
  if (input.memorySnapshot) {
    verifyMemoryCheckpointSnapshot(input.memorySnapshot);
    if (record.reason !== "PRE_COMPACTION"
      || input.memorySnapshot.checkpoint_id !== record.record_id
      || input.memorySnapshot.checkpoint_sha256 !== record.record_sha256
      || input.memorySnapshot.goal_id !== record.goal_id
      || input.memorySnapshot.created_at !== record.created_at) {
      throw new AuthorityIntegrityError("Memory checkpoint snapshot binding is inconsistent");
    }
  }
}

export function checkpointSemanticSha256(input: CheckpointInsert): string {
  verifyCheckpointInsert(input);
  const memory = input.memorySnapshot
    ? {
        schema_version: input.memorySnapshot.schema_version,
        record_type: input.memorySnapshot.record_type,
        goal_id: input.memorySnapshot.goal_id,
        workspace_id: input.memorySnapshot.workspace_id,
        memory_epoch: input.memorySnapshot.memory_epoch,
        memory_mode: input.memorySnapshot.memory_mode,
        manifest_sha256: input.memorySnapshot.manifest_sha256,
        policy_snapshot_sha256: input.memorySnapshot.policy_snapshot_sha256,
        evidence_delta_sha256: input.memorySnapshot.evidence_delta_sha256,
        selected_claims: input.memorySnapshot.selected_claims,
        index_mode: input.memorySnapshot.index_mode,
        index_watermark: input.memorySnapshot.index_watermark,
        index_lag_count: input.memorySnapshot.index_lag_count,
      }
    : null;
  return canonicalJsonSha256({
    domain: "PCH-CHECKPOINT-COMMAND-SEMANTIC-V1",
    schema_version: input.record.schema_version,
    record_type: input.record.record_type,
    goal_id: input.record.goal_id,
    goal_version: input.record.goal_version,
    event_sequence: input.record.event_sequence,
    reason: input.record.reason,
    protected_state: input.record.protected_state,
    protected_state_sha256: input.record.protected_state_sha256,
    prev_checkpoint_sha256: input.record.prev_checkpoint_sha256,
    memory,
  });
}

function decode(row: Record<string, unknown>): CheckpointInsert {
  const previous = row.prev_checkpoint_sha256;
  if (previous !== null && typeof previous !== "string") {
    throw new AuthorityIntegrityError("Checkpoint predecessor hash must be text or null");
  }
  const protectedState = JSON.parse(String(row.protected_state_json)) as ProtectedTaskState;
  const record: MilestoneCheckpointRecord = {
    schema_version: 2,
    record_type: "MILESTONE_CHECKPOINT",
    record_id: String(row.checkpoint_id),
    goal_id: String(row.goal_id),
    goal_version: Number(row.goal_version),
    event_sequence: Number(row.event_sequence),
    reason: String(row.checkpoint_reason) as CheckpointReason,
    created_at: new Date(Number(row.created_at_ms)).toISOString(),
    protected_state: protectedState,
    protected_state_sha256: String(row.protected_state_sha256),
    prev_checkpoint_sha256: previous,
    record_sha256: String(row.checkpoint_sha256),
  };
  validateProtectedState(record.protected_state);
  if (canonicalJson(record.protected_state) !== String(row.protected_state_json)
    || canonicalJsonSha256(record.protected_state) !== record.protected_state_sha256
    || computeCheckpointRecordSha256(recordCore(record)) !== record.record_sha256
    || computeProgressSnapshotSha256({ snapshotId: String(row.snapshot_id), record }) !== String(row.snapshot_sha256)) {
    throw new AuthorityIntegrityError(`Checkpoint hash mismatch at ${record.record_id}`);
  }
  return { record, snapshotId: String(row.snapshot_id), snapshotSha256: String(row.snapshot_sha256) };
}

const checkpointProjection = `SELECT c.checkpoint_id,c.goal_id,c.snapshot_id,c.reason AS checkpoint_reason,
  c.prev_checkpoint_sha256,c.checkpoint_sha256,c.created_at_ms,s.goal_version,s.event_sequence,
  s.protected_state_json,s.protected_state_sha256,s.snapshot_sha256
  FROM milestone_checkpoints c JOIN progress_snapshots s ON s.snapshot_id=c.snapshot_id`;

export class CheckpointRepository {
  constructor(private readonly connection: AuthorityConnection) {}

  latest(goalId: string): CheckpointInsert | null {
    const row = this.connection.prepare(`${checkpointProjection} WHERE c.goal_id=? ORDER BY s.event_sequence DESC LIMIT 1`).get(goalId) as Record<string, unknown> | undefined;
    return row ? decode(row) : null;
  }

  atVersion(goalId: string, goalVersion: number): CheckpointInsert | null {
    const row = this.connection.prepare(`${checkpointProjection} WHERE c.goal_id=? AND s.goal_version=? LIMIT 1`)
      .get(goalId, goalVersion) as Record<string, unknown> | undefined;
    return row ? decode(row) : null;
  }

  insert(input: CheckpointInsert, createdAtMs: number): void {
    const { record } = input;
    verifyCheckpointInsert(input);
    const recordCreatedAtMs = new Date(record.created_at).getTime();
    if (recordCreatedAtMs > createdAtMs || createdAtMs - recordCreatedAtMs > 60_000) {
      throw new AuthorityIntegrityError("Checkpoint record fields or hashes are inconsistent");
    }
    const latest = this.latest(record.goal_id);
    if ((latest?.record.record_sha256 ?? null) !== record.prev_checkpoint_sha256) {
      throw new AuthorityIntegrityError("Checkpoint predecessor does not match the current chain head");
    }
    this.connection.prepare(`INSERT INTO progress_snapshots(snapshot_id,goal_id,goal_version,event_sequence,reason,
      protected_state_json,protected_state_sha256,snapshot_sha256,created_at_ms) VALUES(?,?,?,?,?,?,?,?,?)`).run(
      input.snapshotId, record.goal_id, record.goal_version, record.event_sequence, record.reason,
      canonicalJson(record.protected_state), record.protected_state_sha256, input.snapshotSha256, recordCreatedAtMs,
    );
    this.connection.prepare(`INSERT INTO milestone_checkpoints(checkpoint_id,goal_id,snapshot_id,reason,
      prev_checkpoint_sha256,checkpoint_sha256,created_at_ms) VALUES(?,?,?,?,?,?,?)`).run(
      record.record_id, record.goal_id, input.snapshotId, record.reason,
      record.prev_checkpoint_sha256, record.record_sha256, recordCreatedAtMs,
    );
    if (input.memorySnapshot) this.insertMemorySnapshot(input.memorySnapshot, record, createdAtMs);
  }

  memorySnapshot(checkpointId: string): MemoryCheckpointSnapshotRecord | null {
    const available = this.connection.prepare(`SELECT count(*) AS count FROM sqlite_master
      WHERE type='table' AND name='memory_checkpoint_snapshots'`).get() as { count?: unknown } | undefined;
    if (Number(available?.count ?? 0) !== 1) return null;
    const row = this.connection.prepare(`SELECT m.*,c.goal_id AS checkpoint_goal_id,
      c.checkpoint_sha256 AS linked_checkpoint_sha256,c.reason AS checkpoint_reason,
      s.event_sequence AS checkpoint_event_sequence
      FROM memory_checkpoint_snapshots m
      JOIN milestone_checkpoints c ON c.checkpoint_id=m.checkpoint_id
      JOIN progress_snapshots s ON s.snapshot_id=c.snapshot_id
      WHERE m.checkpoint_id=?`).get(checkpointId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const selected = parseCanonicalJson(String(row.selected_claims_json));
    if (!Array.isArray(selected) || canonicalJson(selected) !== String(row.selected_claims_json)) {
      throw new AuthorityIntegrityError(`Memory checkpoint selected claims are invalid at ${checkpointId}`);
    }
    const record: MemoryCheckpointSnapshotRecord = {
      schema_version: 1,
      record_type: "MEMORY_CHECKPOINT_SNAPSHOT",
      record_id: String(row.memory_snapshot_id),
      checkpoint_id: String(row.checkpoint_id),
      checkpoint_sha256: String(row.checkpoint_sha256),
      goal_id: String(row.goal_id),
      workspace_id: String(row.workspace_id),
      memory_epoch: String(row.memory_epoch),
      memory_mode: String(row.memory_mode) as MemoryCheckpointSnapshotRecord["memory_mode"],
      manifest_sha256: String(row.manifest_sha256),
      policy_snapshot_sha256: String(row.policy_snapshot_sha256),
      evidence_delta_sha256: String(row.evidence_delta_sha256),
      selected_claims: selected as unknown as MemoryCheckpointSnapshotRecord["selected_claims"],
      index_mode: String(row.index_mode) as MemoryCheckpointSnapshotRecord["index_mode"],
      index_watermark: Number(row.index_watermark),
      index_lag_count: Number(row.index_lag_count),
      created_at: new Date(Number(row.created_at_ms)).toISOString(),
      record_sha256: String(row.record_sha256),
    };
    verifyMemoryCheckpointSnapshot(record);
    if (row.checkpoint_reason !== "PRE_COMPACTION" || row.checkpoint_goal_id !== record.goal_id
      || row.linked_checkpoint_sha256 !== record.checkpoint_sha256) {
      throw new AuthorityIntegrityError(`Memory checkpoint linkage is invalid at ${checkpointId}`);
    }
    const sequence = Number(row.checkpoint_event_sequence);
    const event = this.connection.prepare(`SELECT payload_json FROM events WHERE goal_id=? AND sequence=?
      AND event_type='MILESTONE_CHECKPOINTED'`).get(record.goal_id, sequence) as { payload_json?: unknown } | undefined;
    const receipt = this.connection.prepare(`SELECT body_json FROM receipts WHERE goal_id=? AND receipt_type='CHECKPOINT'
      AND subject_type='MILESTONE_CHECKPOINT' AND subject_id=? AND issued_event_sequence=?`)
      .get(record.goal_id, checkpointId, sequence) as { body_json?: unknown } | undefined;
    const eventPayload = typeof event?.payload_json === "string" ? parseCanonicalJson(event.payload_json) : null;
    const receiptBody = typeof receipt?.body_json === "string" ? parseCanonicalJson(receipt.body_json) : null;
    if (!eventPayload || typeof eventPayload !== "object" || Array.isArray(eventPayload)
      || !receiptBody || typeof receiptBody !== "object" || Array.isArray(receiptBody)
      || (eventPayload as Record<string, unknown>).memorySnapshotSha256 !== record.record_sha256
      || (eventPayload as Record<string, unknown>).memorySnapshotId !== record.record_id
      || (receiptBody as Record<string, unknown>).memorySnapshotSha256 !== record.record_sha256
      || (receiptBody as Record<string, unknown>).memorySnapshotId !== record.record_id) {
      throw new AuthorityIntegrityError(`Memory checkpoint event or receipt linkage is invalid at ${checkpointId}`);
    }
    return record;
  }

  verifyChain(goalId: string): { count: number; headSha256: string | null } {
    const rows = this.connection.prepare(`${checkpointProjection} WHERE c.goal_id=? ORDER BY s.event_sequence`).all(goalId) as Record<string, unknown>[];
    let previous: string | null = null;
    for (const row of rows) {
      const decoded = decode(row);
      if (decoded.record.prev_checkpoint_sha256 !== previous) throw new AuthorityIntegrityError(`Checkpoint predecessor mismatch at ${decoded.record.record_id}`);
      previous = decoded.record.record_sha256;
    }
    return { count: rows.length, headSha256: previous };
  }

  private insertMemorySnapshot(
    snapshot: MemoryCheckpointSnapshotRecord,
    checkpoint: MilestoneCheckpointRecord,
    transactionNowMs: number,
  ): void {
    verifyMemoryCheckpointSnapshot(snapshot);
    const createdAtMs = Date.parse(snapshot.created_at);
    const workspace = this.connection.prepare("SELECT workspace_id FROM goals WHERE goal_id=?")
      .get(checkpoint.goal_id) as { workspace_id?: unknown } | undefined;
    if (checkpoint.reason !== "PRE_COMPACTION" || snapshot.checkpoint_id !== checkpoint.record_id
      || snapshot.checkpoint_sha256 !== checkpoint.record_sha256 || snapshot.goal_id !== checkpoint.goal_id
      || workspace?.workspace_id !== snapshot.workspace_id || createdAtMs > transactionNowMs
      || transactionNowMs - createdAtMs > 60_000) {
      throw new AuthorityIntegrityError("Memory checkpoint snapshot binding is inconsistent");
    }
    this.connection.prepare(`INSERT INTO memory_checkpoint_snapshots(
      memory_snapshot_id,checkpoint_id,checkpoint_sha256,goal_id,workspace_id,memory_epoch,memory_mode,
      manifest_sha256,policy_snapshot_sha256,evidence_delta_sha256,selected_claims_json,index_mode,
      index_watermark,index_lag_count,record_sha256,created_at_ms
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      snapshot.record_id, snapshot.checkpoint_id, snapshot.checkpoint_sha256, snapshot.goal_id,
      snapshot.workspace_id, snapshot.memory_epoch, snapshot.memory_mode, snapshot.manifest_sha256,
      snapshot.policy_snapshot_sha256, snapshot.evidence_delta_sha256, canonicalJson(snapshot.selected_claims),
      snapshot.index_mode, snapshot.index_watermark, snapshot.index_lag_count,
      snapshot.record_sha256, createdAtMs,
    );
  }
}
