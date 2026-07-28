import { canonicalJsonSha256 } from "../authority/canonical-json.js";
import { AuthorityIntegrityError } from "../foundation/errors.js";
import { createId } from "../foundation/ids.js";
import type {
  MemoryCheckpointClaimRef, MemoryCheckpointSnapshotRecord, MemoryRetrievalResult,
} from "./types.js";

export interface MemoryCheckpointBuildInput {
  readonly checkpointId: string;
  readonly checkpointSha256: string;
  readonly goalId: string;
  readonly workspaceId: string;
  readonly retrieval: MemoryRetrievalResult;
  readonly createdAt: Date;
}

function recordCore(
  record: MemoryCheckpointSnapshotRecord,
): Omit<MemoryCheckpointSnapshotRecord, "record_sha256"> {
  const { record_sha256: recordSha256, ...core } = record;
  void recordSha256;
  return core;
}

export function computeMemoryCheckpointSha256(
  record: Omit<MemoryCheckpointSnapshotRecord, "record_sha256">,
): string {
  return canonicalJsonSha256(record);
}

export function buildMemoryCheckpointSnapshot(input: MemoryCheckpointBuildInput): MemoryCheckpointSnapshotRecord {
  const selectedClaims: MemoryCheckpointClaimRef[] = input.retrieval.selected.map((selection) => ({
    claim_id: selection.claimId,
    version: selection.version,
    channel: selection.channel,
    claim_sha256: selection.claimSha256,
    source_sha256: selection.sourceSha256,
  }));
  const core: Omit<MemoryCheckpointSnapshotRecord, "record_sha256"> = {
    schema_version: 1,
    record_type: "MEMORY_CHECKPOINT_SNAPSHOT",
    record_id: createId("MSNAP"),
    checkpoint_id: input.checkpointId,
    checkpoint_sha256: input.checkpointSha256,
    goal_id: input.goalId,
    workspace_id: input.workspaceId,
    memory_epoch: input.retrieval.epoch,
    memory_mode: input.retrieval.mode,
    manifest_sha256: input.retrieval.workingSet.manifestSha256,
    policy_snapshot_sha256: input.retrieval.workingSet.policySnapshotSha256,
    evidence_delta_sha256: input.retrieval.workingSet.evidenceDeltaSha256,
    selected_claims: selectedClaims,
    index_mode: input.retrieval.indexMode,
    index_watermark: input.retrieval.indexWatermark,
    index_lag_count: input.retrieval.indexLagCount,
    created_at: input.createdAt.toISOString(),
  };
  return { ...core, record_sha256: computeMemoryCheckpointSha256(core) };
}

function validSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
}

export function verifyMemoryCheckpointSnapshot(record: MemoryCheckpointSnapshotRecord): void {
  const createdAtMs = Date.parse(record.created_at);
  const recordKeys = Object.keys(record).sort();
  const expectedRecordKeys = [
    "checkpoint_id", "checkpoint_sha256", "created_at", "evidence_delta_sha256", "goal_id",
    "index_lag_count", "index_mode", "index_watermark", "manifest_sha256", "memory_epoch",
    "memory_mode", "policy_snapshot_sha256", "record_id", "record_sha256", "record_type",
    "schema_version", "selected_claims", "workspace_id",
  ].sort();
  if (record.schema_version !== 1 || record.record_type !== "MEMORY_CHECKPOINT_SNAPSHOT"
    || recordKeys.join("\0") !== expectedRecordKeys.join("\0")
    || !record.record_id || !record.checkpoint_id || !record.goal_id || !record.workspace_id
    || !record.memory_epoch || !Number.isFinite(createdAtMs)
    || !validSha256(record.checkpoint_sha256) || !validSha256(record.manifest_sha256)
    || !validSha256(record.policy_snapshot_sha256) || !validSha256(record.evidence_delta_sha256)
    || !Number.isSafeInteger(record.index_watermark) || record.index_watermark < 0
    || !Number.isSafeInteger(record.index_lag_count) || record.index_lag_count < 0
    || record.selected_claims.some((entry) => Object.keys(entry).sort().join("\0")
      !== ["channel", "claim_id", "claim_sha256", "source_sha256", "version"].sort().join("\0")
      || !entry.claim_id || !Number.isSafeInteger(entry.version) || entry.version < 1
      || !["POLICY", "EVIDENCE", "EXPERIENCE"].includes(entry.channel)
      || !validSha256(entry.claim_sha256) || !validSha256(entry.source_sha256))
    || computeMemoryCheckpointSha256(recordCore(record)) !== record.record_sha256) {
    throw new AuthorityIntegrityError(`Memory checkpoint snapshot hash or fields are invalid at ${record.record_id}`);
  }
}
