-- Compaction 2.1 guards Pi-native compaction with a durable, hash-only saga.

CREATE TABLE harness_compaction_attempts_v21 (
  attempt_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES managed_runs_v1(run_id),
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  checkpoint_id TEXT NOT NULL,
  checkpoint_sha256 TEXT NOT NULL CHECK(length(checkpoint_sha256)=64),
  pre_capsule_json TEXT NOT NULL CHECK(json_valid(pre_capsule_json) AND json_type(pre_capsule_json)='object' AND length(pre_capsule_json)<=131072),
  pre_capsule_sha256 TEXT NOT NULL UNIQUE CHECK(length(pre_capsule_sha256)=64),
  strategy TEXT NOT NULL CHECK(strategy IN ('NATIVE_GUARDED','FAST_STRUCTURED')),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  UNIQUE(run_id,checkpoint_id)
) STRICT;

CREATE TABLE harness_compaction_transitions_v21 (
  transition_id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES harness_compaction_attempts_v21(attempt_id),
  ordinal INTEGER NOT NULL CHECK(ordinal>=0),
  state TEXT NOT NULL CHECK(state IN ('PREPARED','PI_OWNED','VERIFIED','ABORTED','RECOVERY_REQUIRED','RECONCILED')),
  reason_code TEXT NOT NULL CHECK(length(reason_code) BETWEEN 1 AND 160),
  observed_capsule_sha256 TEXT CHECK(observed_capsule_sha256 IS NULL OR length(observed_capsule_sha256)=64),
  predecessor_sha256 TEXT CHECK(predecessor_sha256 IS NULL OR length(predecessor_sha256)=64),
  transition_sha256 TEXT NOT NULL UNIQUE CHECK(length(transition_sha256)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  UNIQUE(attempt_id,ordinal)
) STRICT;

CREATE TABLE harness_compaction_heads_v21 (
  attempt_id TEXT PRIMARY KEY REFERENCES harness_compaction_attempts_v21(attempt_id),
  state TEXT NOT NULL CHECK(state IN ('PREPARED','PI_OWNED','VERIFIED','ABORTED','RECOVERY_REQUIRED','RECONCILED')),
  ordinal INTEGER NOT NULL CHECK(ordinal>=0),
  transition_sha256 TEXT NOT NULL CHECK(length(transition_sha256)=64)
) STRICT;

CREATE INDEX harness_compaction_open_v21 ON harness_compaction_heads_v21(state,attempt_id);
CREATE INDEX harness_compaction_run_v21 ON harness_compaction_attempts_v21(run_id,created_at_ms);

CREATE TRIGGER no_update_harness_compaction_attempts_v21 BEFORE UPDATE ON harness_compaction_attempts_v21 BEGIN SELECT RAISE(ABORT,'compaction attempts are immutable'); END;
CREATE TRIGGER no_delete_harness_compaction_attempts_v21 BEFORE DELETE ON harness_compaction_attempts_v21 BEGIN SELECT RAISE(ABORT,'compaction attempts cannot be deleted'); END;
CREATE TRIGGER no_update_harness_compaction_transitions_v21 BEFORE UPDATE ON harness_compaction_transitions_v21 BEGIN SELECT RAISE(ABORT,'compaction transitions are immutable'); END;
CREATE TRIGGER no_delete_harness_compaction_transitions_v21 BEFORE DELETE ON harness_compaction_transitions_v21 BEGIN SELECT RAISE(ABORT,'compaction transitions cannot be deleted'); END;
