CREATE TABLE execution_integration_journals_v2 (
  integration_attempt_id TEXT PRIMARY KEY
    REFERENCES execution_integration_attempts_v2(integration_attempt_id),
  journal_artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
  journal_sha256 TEXT NOT NULL CHECK(length(journal_sha256)=64),
  journal_record_sha256 TEXT NOT NULL CHECK(length(journal_record_sha256)=64),
  entry_count INTEGER NOT NULL CHECK(entry_count BETWEEN 1 AND 256),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1)
) STRICT;

CREATE TABLE execution_integration_preimages_v2 (
  integration_attempt_id TEXT NOT NULL
    REFERENCES execution_integration_journals_v2(integration_attempt_id),
  ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 255),
  path TEXT NOT NULL CHECK(length(path) BETWEEN 1 AND 4096),
  operation TEXT NOT NULL CHECK(operation IN ('CREATE','MODIFY','DELETE')),
  expected_before_sha256 TEXT CHECK(expected_before_sha256 IS NULL OR length(expected_before_sha256)=64),
  observed_before_sha256 TEXT CHECK(observed_before_sha256 IS NULL OR length(observed_before_sha256)=64),
  expected_after_sha256 TEXT CHECK(expected_after_sha256 IS NULL OR length(expected_after_sha256)=64),
  byte_length INTEGER NOT NULL CHECK(byte_length BETWEEN 0 AND 8388608),
  preimage_artifact_id TEXT REFERENCES artifacts(artifact_id),
  preimage_artifact_sha256 TEXT REFERENCES artifacts(sha256),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  PRIMARY KEY(integration_attempt_id,ordinal),
  UNIQUE(integration_attempt_id,path),
  CHECK((observed_before_sha256 IS NULL AND preimage_artifact_id IS NULL AND preimage_artifact_sha256 IS NULL)
    OR (observed_before_sha256 IS NOT NULL AND preimage_artifact_id IS NOT NULL
      AND preimage_artifact_sha256=observed_before_sha256)),
  CHECK((operation='CREATE' AND expected_before_sha256 IS NULL AND expected_after_sha256 IS NOT NULL)
    OR (operation='MODIFY' AND expected_before_sha256 IS NOT NULL AND expected_after_sha256 IS NOT NULL)
    OR (operation='DELETE' AND expected_before_sha256 IS NOT NULL AND expected_after_sha256 IS NULL)),
  CHECK((operation='DELETE' AND byte_length=0) OR operation<>'DELETE')
) WITHOUT ROWID, STRICT;

CREATE TRIGGER validate_execution_integration_journal_v2
BEFORE INSERT ON execution_integration_journals_v2
WHEN NOT EXISTS (
  SELECT 1 FROM execution_integration_attempts_v2 i
  JOIN artifacts a ON a.artifact_id=NEW.journal_artifact_id
  WHERE i.integration_attempt_id=NEW.integration_attempt_id
    AND a.sha256=NEW.journal_sha256
    AND a.media_type='application/vnd.pch.patch-transaction+json'
    AND a.classification<>'SECRET'
)
BEGIN SELECT RAISE(ABORT,'Execution integration journal artifact identity mismatch'); END;

CREATE TRIGGER validate_execution_integration_preimage_v2
BEFORE INSERT ON execution_integration_preimages_v2
WHEN NEW.preimage_artifact_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM artifacts a
  WHERE a.artifact_id=NEW.preimage_artifact_id
    AND a.sha256=NEW.preimage_artifact_sha256
    AND a.byte_length<=8388608
    AND a.classification<>'SECRET'
)
BEGIN SELECT RAISE(ABORT,'Execution integration preimage artifact identity mismatch'); END;

CREATE TRIGGER no_update_execution_integration_journals_v2
BEFORE UPDATE ON execution_integration_journals_v2
BEGIN SELECT RAISE(ABORT,'Execution integration journals V2 are immutable'); END;
CREATE TRIGGER no_delete_execution_integration_journals_v2
BEFORE DELETE ON execution_integration_journals_v2
BEGIN SELECT RAISE(ABORT,'Execution integration journals V2 are immutable'); END;
CREATE TRIGGER no_update_execution_integration_preimages_v2
BEFORE UPDATE ON execution_integration_preimages_v2
BEGIN SELECT RAISE(ABORT,'Execution integration preimages V2 are immutable'); END;
CREATE TRIGGER no_delete_execution_integration_preimages_v2
BEFORE DELETE ON execution_integration_preimages_v2
BEGIN SELECT RAISE(ABORT,'Execution integration preimages V2 are immutable'); END;
