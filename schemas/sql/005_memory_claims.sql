PRAGMA foreign_keys = ON;
PRAGMA trusted_schema = OFF;
BEGIN IMMEDIATE;

CREATE TABLE IF NOT EXISTS memory_claim_versions (
  claim_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version >= 1),
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  actor_goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  scope TEXT NOT NULL CHECK(scope IN ('GOAL', 'WORKSPACE')),
  scope_goal_id TEXT REFERENCES goals(goal_id),
  channel TEXT NOT NULL CHECK(channel IN ('POLICY', 'EVIDENCE', 'EXPERIENCE')),
  status TEXT NOT NULL CHECK(status IN ('PROPOSED', 'ACTIVE')),
  payload_json TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256) = 64),
  source_attestation_json TEXT NOT NULL,
  source_attestation_sha256 TEXT NOT NULL CHECK(length(source_attestation_sha256) = 64),
  tags_json TEXT NOT NULL,
  path_key TEXT,
  dependency_keys_json TEXT NOT NULL,
  classification TEXT NOT NULL CHECK(classification IN ('PUBLIC', 'INTERNAL')),
  valid_from_ms INTEGER NOT NULL CHECK(valid_from_ms >= 0),
  expires_at_ms INTEGER,
  supersedes_version INTEGER,
  content_text TEXT NOT NULL,
  content_sha256 TEXT NOT NULL CHECK(length(content_sha256) = 64),
  content_token_estimate INTEGER NOT NULL CHECK(content_token_estimate >= 0),
  claim_sha256 TEXT NOT NULL CHECK(length(claim_sha256) = 64),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence >= 1),
  PRIMARY KEY(claim_id, version),
  UNIQUE(claim_id, claim_sha256),
  CHECK((scope = 'GOAL' AND scope_goal_id IS NOT NULL) OR (scope = 'WORKSPACE' AND scope_goal_id IS NULL)),
  CHECK(expires_at_ms IS NULL OR expires_at_ms > valid_from_ms),
  CHECK((version = 1 AND supersedes_version IS NULL) OR (version > 1 AND supersedes_version = version - 1))
) STRICT;

CREATE TABLE IF NOT EXISTS memory_claim_heads (
  claim_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  workspace_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK(scope IN ('GOAL', 'WORKSPACE')),
  scope_goal_id TEXT,
  channel TEXT NOT NULL CHECK(channel IN ('POLICY', 'EVIDENCE', 'EXPERIENCE')),
  status TEXT NOT NULL CHECK(status IN ('PROPOSED', 'ACTIVE')),
  claim_sha256 TEXT NOT NULL CHECK(length(claim_sha256) = 64),
  last_event_sequence INTEGER NOT NULL CHECK(last_event_sequence >= 1),
  FOREIGN KEY(claim_id, version) REFERENCES memory_claim_versions(claim_id, version)
) STRICT;

CREATE TABLE IF NOT EXISTS memory_claim_actions (
  action_id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL,
  target_version INTEGER NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  actor_goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  action_type TEXT NOT NULL CHECK(action_type IN ('ENDORSE', 'REVOKE_ENDORSEMENT', 'FORGET', 'RESTORE')),
  action_family TEXT NOT NULL CHECK(action_family IN ('ENDORSEMENT', 'VISIBILITY')),
  reason TEXT NOT NULL,
  predecessor_action_id TEXT REFERENCES memory_claim_actions(action_id),
  action_sha256 TEXT NOT NULL UNIQUE CHECK(length(action_sha256) = 64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence >= 1),
  FOREIGN KEY(claim_id, target_version) REFERENCES memory_claim_versions(claim_id, version)
) STRICT;

CREATE TABLE IF NOT EXISTS memory_action_heads (
  claim_id TEXT NOT NULL,
  action_family TEXT NOT NULL CHECK(action_family IN ('ENDORSEMENT', 'VISIBILITY')),
  action_id TEXT NOT NULL REFERENCES memory_claim_actions(action_id),
  last_event_sequence INTEGER NOT NULL CHECK(last_event_sequence >= 1),
  PRIMARY KEY(claim_id, action_family)
) STRICT;

CREATE TABLE IF NOT EXISTS memory_claim_terms (
  claim_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  workspace_id TEXT NOT NULL,
  term_kind TEXT NOT NULL CHECK(term_kind IN ('TAG', 'PATH', 'DEPENDENCY')),
  term TEXT NOT NULL,
  PRIMARY KEY(claim_id, version, term_kind, term),
  FOREIGN KEY(claim_id, version) REFERENCES memory_claim_versions(claim_id, version)
) STRICT;

CREATE TABLE IF NOT EXISTS memory_index_v2_outbox (
  outbox_id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  action_id TEXT REFERENCES memory_claim_actions(action_id),
  workspace_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('UPSERT', 'DELETE')),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence >= 1),
  UNIQUE(claim_id, version, action_id),
  FOREIGN KEY(claim_id, version) REFERENCES memory_claim_versions(claim_id, version)
) STRICT;

CREATE TABLE IF NOT EXISTS memory_index_v2_receipts (
  outbox_id TEXT PRIMARY KEY REFERENCES memory_index_v2_outbox(outbox_id),
  indexed_at_ms INTEGER NOT NULL CHECK(indexed_at_ms >= 0),
  indexed_claim_sha256 TEXT NOT NULL CHECK(length(indexed_claim_sha256) = 64),
  result TEXT NOT NULL CHECK(result IN ('UPSERTED', 'DELETED', 'SUPERSEDED'))
) STRICT;

CREATE TABLE IF NOT EXISTS memory_workspace_watermarks (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(workspace_id),
  indexed_event_sequence INTEGER NOT NULL CHECK(indexed_event_sequence >= 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)
) STRICT;

CREATE TABLE IF NOT EXISTS memory_legacy_dispositions (
  memory_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  workspace_id TEXT NOT NULL,
  disposition TEXT NOT NULL CHECK(disposition = 'QUARANTINED_V1'),
  legacy_scope TEXT NOT NULL,
  content_sha256 TEXT NOT NULL CHECK(length(content_sha256) = 64),
  reason TEXT NOT NULL,
  PRIMARY KEY(memory_id, version)
) STRICT;

INSERT OR IGNORE INTO memory_legacy_dispositions(
  memory_id, version, workspace_id, disposition, legacy_scope, content_sha256, reason
)
SELECT mv.memory_id, mv.version, mv.workspace_id, 'QUARANTINED_V1', mv.scope,
       mv.content_sha256, 'V1 caller-asserted provenance is not auto-promotable'
FROM memory_versions mv
WHERE NOT EXISTS (
  SELECT 1 FROM memory_versions newer
  WHERE newer.memory_id = mv.memory_id AND newer.version > mv.version
);

CREATE TABLE IF NOT EXISTS memory_recall_observations (
  observation_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  goal_id TEXT REFERENCES goals(goal_id),
  epoch TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('OFF', 'EXPLICIT_ONLY', 'VERIFIED_JIT', 'EXPERIMENTAL')),
  selected_manifest_sha256 TEXT NOT NULL CHECK(length(selected_manifest_sha256) = 64),
  selected_count INTEGER NOT NULL CHECK(selected_count >= 0),
  conflict_count INTEGER NOT NULL CHECK(conflict_count >= 0),
  abstention_count INTEGER NOT NULL CHECK(abstention_count >= 0),
  index_lag_count INTEGER NOT NULL CHECK(index_lag_count >= 0),
  token_estimate INTEGER NOT NULL CHECK(token_estimate >= 0),
  latency_micros INTEGER NOT NULL CHECK(latency_micros >= 0),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0)
) STRICT;

CREATE TRIGGER IF NOT EXISTS no_update_memory_claim_versions BEFORE UPDATE ON memory_claim_versions BEGIN SELECT RAISE(ABORT, 'memory claim versions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_memory_claim_versions BEFORE DELETE ON memory_claim_versions BEGIN SELECT RAISE(ABORT, 'memory claim versions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_update_memory_claim_actions BEFORE UPDATE ON memory_claim_actions BEGIN SELECT RAISE(ABORT, 'memory claim actions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_memory_claim_actions BEFORE DELETE ON memory_claim_actions BEGIN SELECT RAISE(ABORT, 'memory claim actions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_update_memory_claim_terms BEFORE UPDATE ON memory_claim_terms BEGIN SELECT RAISE(ABORT, 'memory claim terms are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_memory_claim_terms BEFORE DELETE ON memory_claim_terms BEGIN SELECT RAISE(ABORT, 'memory claim terms are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_update_memory_index_v2_outbox BEFORE UPDATE ON memory_index_v2_outbox BEGIN SELECT RAISE(ABORT, 'memory index work is immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_memory_index_v2_outbox BEFORE DELETE ON memory_index_v2_outbox BEGIN SELECT RAISE(ABORT, 'memory index work is immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_update_memory_index_v2_receipts BEFORE UPDATE ON memory_index_v2_receipts BEGIN SELECT RAISE(ABORT, 'memory index receipts are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_memory_index_v2_receipts BEFORE DELETE ON memory_index_v2_receipts BEGIN SELECT RAISE(ABORT, 'memory index receipts are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_update_memory_legacy_dispositions BEFORE UPDATE ON memory_legacy_dispositions BEGIN SELECT RAISE(ABORT, 'legacy dispositions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_memory_legacy_dispositions BEFORE DELETE ON memory_legacy_dispositions BEGIN SELECT RAISE(ABORT, 'legacy dispositions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_update_memory_recall_observations BEFORE UPDATE ON memory_recall_observations BEGIN SELECT RAISE(ABORT, 'memory observations are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_memory_recall_observations BEFORE DELETE ON memory_recall_observations BEGIN SELECT RAISE(ABORT, 'memory observations are immutable'); END;

CREATE INDEX IF NOT EXISTS ix_memory_claim_heads_scope ON memory_claim_heads(workspace_id, scope, scope_goal_id, channel, status, last_event_sequence DESC);
CREATE INDEX IF NOT EXISTS ix_memory_claim_terms_lookup ON memory_claim_terms(workspace_id, term, claim_id, version);
CREATE INDEX IF NOT EXISTS ix_memory_actions_claim ON memory_claim_actions(claim_id, action_family, created_event_sequence DESC);
CREATE INDEX IF NOT EXISTS ix_memory_index_v2_pending ON memory_index_v2_outbox(workspace_id, created_event_sequence, outbox_id);
CREATE INDEX IF NOT EXISTS ix_memory_recall_epoch ON memory_recall_observations(epoch, mode, created_at_ms);

COMMIT;
