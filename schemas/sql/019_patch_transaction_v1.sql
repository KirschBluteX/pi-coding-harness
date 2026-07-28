ALTER TABLE integration_receipts_v1
  ADD COLUMN transaction_journal_sha256 TEXT
  CHECK(transaction_journal_sha256 IS NULL OR length(transaction_journal_sha256)=64);

CREATE TABLE patch_transaction_preparations_v1 (
  patch_set_id TEXT PRIMARY KEY REFERENCES patch_sets_v1(patch_set_id),
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  run_id TEXT NOT NULL REFERENCES managed_runs_v1(run_id),
  shard_id TEXT NOT NULL REFERENCES work_shards_v1(shard_id),
  journal_artifact_id TEXT NOT NULL UNIQUE REFERENCES artifacts(artifact_id),
  journal_sha256 TEXT NOT NULL UNIQUE CHECK(length(journal_sha256)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1)
) STRICT;

CREATE INDEX ix_patch_transaction_goal_v1
  ON patch_transaction_preparations_v1(goal_id,created_event_sequence);

CREATE TRIGGER no_update_patch_transaction_preparations_v1
BEFORE UPDATE ON patch_transaction_preparations_v1
BEGIN SELECT RAISE(ABORT,'patch transaction preparations are immutable'); END;

CREATE TRIGGER no_delete_patch_transaction_preparations_v1
BEFORE DELETE ON patch_transaction_preparations_v1
BEGIN SELECT RAISE(ABORT,'patch transaction preparations are immutable'); END;
