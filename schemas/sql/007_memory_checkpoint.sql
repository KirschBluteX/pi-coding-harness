PRAGMA foreign_keys = ON;
PRAGMA trusted_schema = OFF;
BEGIN IMMEDIATE;

CREATE TABLE IF NOT EXISTS memory_checkpoint_snapshots (
  memory_snapshot_id TEXT PRIMARY KEY,
  checkpoint_id TEXT NOT NULL UNIQUE REFERENCES milestone_checkpoints(checkpoint_id),
  checkpoint_sha256 TEXT NOT NULL CHECK(length(checkpoint_sha256) = 64),
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  memory_epoch TEXT NOT NULL,
  memory_mode TEXT NOT NULL CHECK(memory_mode IN ('EXPLICIT_ONLY', 'VERIFIED_JIT', 'EXPERIMENTAL')),
  manifest_sha256 TEXT NOT NULL CHECK(length(manifest_sha256) = 64),
  policy_snapshot_sha256 TEXT NOT NULL CHECK(length(policy_snapshot_sha256) = 64),
  evidence_delta_sha256 TEXT NOT NULL CHECK(length(evidence_delta_sha256) = 64),
  selected_claims_json TEXT NOT NULL CHECK(json_valid(selected_claims_json)),
  index_mode TEXT NOT NULL CHECK(index_mode IN ('TAG_PATH', 'FTS5', 'ERROR')),
  index_watermark INTEGER NOT NULL CHECK(index_watermark >= 0),
  index_lag_count INTEGER NOT NULL CHECK(index_lag_count >= 0),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256) = 64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0)
) STRICT;

CREATE TRIGGER IF NOT EXISTS no_update_memory_checkpoint_snapshots
BEFORE UPDATE ON memory_checkpoint_snapshots
BEGIN SELECT RAISE(ABORT, 'memory checkpoint snapshots are immutable'); END;

CREATE TRIGGER IF NOT EXISTS no_delete_memory_checkpoint_snapshots
BEFORE DELETE ON memory_checkpoint_snapshots
BEGIN SELECT RAISE(ABORT, 'memory checkpoint snapshots are immutable'); END;

CREATE INDEX IF NOT EXISTS ix_memory_checkpoint_goal
ON memory_checkpoint_snapshots(goal_id, created_at_ms DESC, memory_snapshot_id);

COMMIT;
