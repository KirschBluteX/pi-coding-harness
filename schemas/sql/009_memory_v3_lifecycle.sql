PRAGMA foreign_keys = ON;
PRAGMA trusted_schema = OFF;
BEGIN IMMEDIATE;

CREATE TEMP TABLE __pch_memory_v3_pre_lifecycle_guard (
  existing_claims INTEGER NOT NULL CHECK(existing_claims = 0)
) STRICT;
INSERT INTO __pch_memory_v3_pre_lifecycle_guard(existing_claims)
SELECT count(*) FROM memory_v3_claim_versions;
DROP TABLE __pch_memory_v3_pre_lifecycle_guard;

ALTER TABLE memory_v3_events ADD COLUMN record_sha256 TEXT
  CHECK(record_sha256 IS NULL OR length(record_sha256) = 64);

ALTER TABLE memory_v3_claim_versions ADD COLUMN authority_metadata_sha256 TEXT
  CHECK(authority_metadata_sha256 IS NULL OR length(authority_metadata_sha256) = 64);
ALTER TABLE memory_v3_claim_versions ADD COLUMN wrapped_key_sha256 TEXT
  CHECK(wrapped_key_sha256 IS NULL OR length(wrapped_key_sha256) = 64);

ALTER TABLE memory_v3_claim_heads ADD COLUMN proposal_state TEXT NOT NULL DEFAULT 'ACTIVE'
  CHECK(proposal_state IN ('PROPOSED','ACTIVE','REJECTED'));
ALTER TABLE memory_v3_claim_heads ADD COLUMN visibility TEXT NOT NULL DEFAULT 'VISIBLE'
  CHECK(visibility IN ('VISIBLE','FORGOTTEN'));
ALTER TABLE memory_v3_claim_heads ADD COLUMN purge_state TEXT NOT NULL DEFAULT 'PRESENT'
  CHECK(purge_state IN ('PRESENT','PURGED_LOCAL_KEY','INTEGRITY_FAILED'));
ALTER TABLE memory_v3_claim_heads ADD COLUMN endorsed INTEGER NOT NULL DEFAULT 0
  CHECK(endorsed IN (0,1));

ALTER TABLE memory_v3_actions ADD COLUMN purge_intent_id TEXT;

CREATE TABLE memory_v3_purge_intents (
  intent_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  claim_id TEXT NOT NULL REFERENCES memory_v3_claim_heads(claim_id),
  target_version INTEGER NOT NULL CHECK(target_version >= 1),
  version_manifest_sha256 TEXT NOT NULL CHECK(length(version_manifest_sha256) = 64),
  idempotency_key_sha256 TEXT NOT NULL CHECK(length(idempotency_key_sha256) = 64),
  requested_by TEXT NOT NULL CHECK(requested_by IN ('USER','RUNTIME')),
  intent_sha256 TEXT NOT NULL UNIQUE CHECK(length(intent_sha256) = 64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  UNIQUE(workspace_id, idempotency_key_sha256)
) STRICT;

CREATE TABLE memory_v3_purge_receipts (
  receipt_id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL UNIQUE REFERENCES memory_v3_purge_intents(intent_id),
  action_id TEXT NOT NULL UNIQUE REFERENCES memory_v3_actions(action_id),
  result TEXT NOT NULL CHECK(result = 'PURGED_LOCAL_KEY'),
  limitation_contract_sha256 TEXT NOT NULL CHECK(length(limitation_contract_sha256) = 64),
  receipt_sha256 TEXT NOT NULL UNIQUE CHECK(length(receipt_sha256) = 64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0)
) STRICT;

CREATE TRIGGER IF NOT EXISTS memory_v3_claim_crypto_required
BEFORE INSERT ON memory_v3_claim_versions
WHEN NEW.authority_metadata_sha256 IS NULL OR NEW.wrapped_key_sha256 IS NULL
BEGIN
  SELECT RAISE(ABORT, 'memory v3 claim cryptographic metadata is required');
END;

CREATE TRIGGER memory_v3_purge_action_intent_required
BEFORE INSERT ON memory_v3_actions
WHEN (NEW.action_type = 'PURGE_LOCAL_KEY' AND NEW.purge_intent_id IS NULL)
  OR (NEW.action_type <> 'PURGE_LOCAL_KEY' AND NEW.purge_intent_id IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'memory v3 purge intent binding is invalid');
END;

CREATE TRIGGER no_update_memory_v3_purge_intents BEFORE UPDATE ON memory_v3_purge_intents
BEGIN SELECT RAISE(ABORT, 'memory v3 purge intents are immutable'); END;
CREATE TRIGGER no_delete_memory_v3_purge_intents BEFORE DELETE ON memory_v3_purge_intents
BEGIN SELECT RAISE(ABORT, 'memory v3 purge intents are immutable'); END;
CREATE TRIGGER no_update_memory_v3_purge_receipts BEFORE UPDATE ON memory_v3_purge_receipts
BEGIN SELECT RAISE(ABORT, 'memory v3 purge receipts are immutable'); END;
CREATE TRIGGER no_delete_memory_v3_purge_receipts BEFORE DELETE ON memory_v3_purge_receipts
BEGIN SELECT RAISE(ABORT, 'memory v3 purge receipts are immutable'); END;

CREATE INDEX IF NOT EXISTS ix_memory_v3_heads_active ON memory_v3_claim_heads(
  workspace_id, scope, scope_goal_id, channel, proposal_state, visibility, purge_state,
  last_stream_sequence DESC
);
CREATE INDEX ix_memory_v3_purge_pending ON memory_v3_purge_intents(workspace_id,claim_id,created_at_ms);

COMMIT;
