PRAGMA foreign_keys = ON;
PRAGMA trusted_schema = OFF;
BEGIN IMMEDIATE;

CREATE TABLE IF NOT EXISTS memory_v3_workspace_stream_heads (
  workspace_id TEXT PRIMARY KEY,
  stream_sequence INTEGER NOT NULL CHECK(stream_sequence >= 0),
  last_event_sha256 TEXT NOT NULL CHECK(length(last_event_sha256) = 64),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)
) STRICT;

CREATE TABLE IF NOT EXISTS memory_v3_events (
  event_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  stream_sequence INTEGER NOT NULL CHECK(stream_sequence >= 1),
  event_type TEXT NOT NULL CHECK(event_type IN (
    'CAPTURE_ROUTED','CLAIM_STORED','PROPOSAL_RESOLVED','ACTION_APPLIED','PURGE_RECONCILED'
  )),
  source_kind TEXT NOT NULL CHECK(source_kind IN (
    'USER_INPUT','AUTHORITY_DECISION','ROUTE_FAILURE','AGENT_PROPOSAL','MANUAL_COMMAND','RECOVERY'
  )),
  source_actor TEXT NOT NULL CHECK(source_actor IN ('USER','AGENT','RUNTIME')),
  decision_actor TEXT NOT NULL CHECK(decision_actor IN ('USER','RUNTIME')),
  route TEXT NOT NULL CHECK(route IN ('EXPLICIT_AUTO','AUTHORITY_DERIVED','PROPOSE_ONLY','REJECT','MANUAL')),
  disposition TEXT NOT NULL CHECK(disposition IN (
    'MEMORY_ELIGIBLE','REQUIREMENT_FIRST','PLAN_FIRST','UNCERTAIN_PROPOSE','NOT_APPLICABLE'
  )),
  reason_codes_json TEXT NOT NULL CHECK(json_valid(reason_codes_json) AND json_type(reason_codes_json) = 'array'),
  candidate_sha256 TEXT NOT NULL CHECK(length(candidate_sha256) = 64),
  source_locator_sha256 TEXT NOT NULL CHECK(length(source_locator_sha256) = 64),
  source_content_sha256 TEXT NOT NULL CHECK(length(source_content_sha256) = 64),
  goal_id TEXT,
  claim_id TEXT,
  claim_version INTEGER CHECK(claim_version IS NULL OR claim_version >= 1),
  channel TEXT CHECK(channel IS NULL OR channel IN ('POLICY','EVIDENCE','EXPERIENCE')),
  scope TEXT CHECK(scope IS NULL OR scope IN ('GOAL','WORKSPACE')),
  classification TEXT CHECK(classification IS NULL OR classification IN ('PUBLIC','INTERNAL')),
  semantic_key_sha256 TEXT CHECK(semantic_key_sha256 IS NULL OR length(semantic_key_sha256) = 64),
  value_sha256 TEXT CHECK(value_sha256 IS NULL OR length(value_sha256) = 64),
  body_sha256 TEXT CHECK(body_sha256 IS NULL OR length(body_sha256) = 64),
  vault_ref_sha256 TEXT CHECK(vault_ref_sha256 IS NULL OR length(vault_ref_sha256) = 64),
  previous_event_sha256 TEXT NOT NULL CHECK(length(previous_event_sha256) = 64),
  event_sha256 TEXT NOT NULL UNIQUE CHECK(length(event_sha256) = 64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  UNIQUE(workspace_id, stream_sequence)
) STRICT;

CREATE TABLE IF NOT EXISTS memory_v3_commands (
  command_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  idempotency_key_sha256 TEXT NOT NULL CHECK(length(idempotency_key_sha256) = 64),
  command_sha256 TEXT NOT NULL CHECK(length(command_sha256) = 64),
  result_event_id TEXT NOT NULL REFERENCES memory_v3_events(event_id),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  UNIQUE(workspace_id, idempotency_key_sha256)
) STRICT;

CREATE TABLE IF NOT EXISTS memory_v3_claim_versions (
  claim_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version >= 1),
  workspace_id TEXT NOT NULL,
  source_goal_id TEXT,
  scope TEXT NOT NULL CHECK(scope IN ('GOAL','WORKSPACE')),
  scope_goal_id TEXT,
  channel TEXT NOT NULL CHECK(channel IN ('POLICY','EVIDENCE','EXPERIENCE')),
  status TEXT NOT NULL CHECK(status IN ('PROPOSED','ACTIVE')),
  classification TEXT NOT NULL CHECK(classification IN ('PUBLIC','INTERNAL')),
  payload_type TEXT NOT NULL CHECK(payload_type IN ('TYPED_POLICY','EVIDENCE_LOCATOR','EXPERIENCE_RECORD')),
  policy_operator TEXT CHECK(policy_operator IS NULL OR policy_operator IN ('PREFER','AVOID','REQUIRE','FORBID','SET')),
  semantic_key_sha256 TEXT CHECK(semantic_key_sha256 IS NULL OR length(semantic_key_sha256) = 64),
  value_sha256 TEXT CHECK(value_sha256 IS NULL OR length(value_sha256) = 64),
  body_sha256 TEXT NOT NULL CHECK(length(body_sha256) = 64),
  source_locator_sha256 TEXT NOT NULL CHECK(length(source_locator_sha256) = 64),
  source_content_sha256 TEXT NOT NULL CHECK(length(source_content_sha256) = 64),
  vault_ref_sha256 TEXT NOT NULL CHECK(length(vault_ref_sha256) = 64),
  key_ref_sha256 TEXT NOT NULL CHECK(length(key_ref_sha256) = 64),
  ciphertext_sha256 TEXT NOT NULL CHECK(length(ciphertext_sha256) = 64),
  valid_from_ms INTEGER NOT NULL CHECK(valid_from_ms >= 0),
  expires_at_ms INTEGER,
  supersedes_version INTEGER,
  claim_sha256 TEXT NOT NULL UNIQUE CHECK(length(claim_sha256) = 64),
  created_stream_sequence INTEGER NOT NULL CHECK(created_stream_sequence >= 1),
  PRIMARY KEY(claim_id, version),
  CHECK((scope = 'GOAL' AND scope_goal_id IS NOT NULL) OR (scope = 'WORKSPACE' AND scope_goal_id IS NULL)),
  CHECK(expires_at_ms IS NULL OR expires_at_ms > valid_from_ms),
  CHECK((version = 1 AND supersedes_version IS NULL) OR (version > 1 AND supersedes_version = version - 1)),
  FOREIGN KEY(workspace_id, created_stream_sequence) REFERENCES memory_v3_events(workspace_id, stream_sequence)
) STRICT;

CREATE TABLE IF NOT EXISTS memory_v3_claim_heads (
  claim_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  workspace_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK(scope IN ('GOAL','WORKSPACE')),
  scope_goal_id TEXT,
  channel TEXT NOT NULL CHECK(channel IN ('POLICY','EVIDENCE','EXPERIENCE')),
  status TEXT NOT NULL CHECK(status IN ('PROPOSED','ACTIVE')),
  claim_sha256 TEXT NOT NULL CHECK(length(claim_sha256) = 64),
  last_stream_sequence INTEGER NOT NULL CHECK(last_stream_sequence >= 1),
  FOREIGN KEY(claim_id, version) REFERENCES memory_v3_claim_versions(claim_id, version)
) STRICT;

CREATE TABLE IF NOT EXISTS memory_v3_actions (
  action_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  target_version INTEGER NOT NULL CHECK(target_version >= 1),
  action_type TEXT NOT NULL CHECK(action_type IN ('APPROVE','REJECT','ENDORSE','REVOKE_ENDORSEMENT','FORGET','RESTORE','PURGE_LOCAL_KEY')),
  action_family TEXT NOT NULL CHECK(action_family IN ('PROPOSAL','ENDORSEMENT','VISIBILITY','PURGE')),
  source_actor TEXT NOT NULL CHECK(source_actor IN ('USER','RUNTIME')),
  reason_code TEXT NOT NULL,
  predecessor_action_id TEXT REFERENCES memory_v3_actions(action_id),
  action_sha256 TEXT NOT NULL UNIQUE CHECK(length(action_sha256) = 64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  created_stream_sequence INTEGER NOT NULL CHECK(created_stream_sequence >= 1),
  FOREIGN KEY(claim_id, target_version) REFERENCES memory_v3_claim_versions(claim_id, version),
  FOREIGN KEY(workspace_id, created_stream_sequence) REFERENCES memory_v3_events(workspace_id, stream_sequence)
) STRICT;

CREATE TABLE IF NOT EXISTS memory_v3_action_heads (
  claim_id TEXT NOT NULL,
  action_family TEXT NOT NULL CHECK(action_family IN ('PROPOSAL','ENDORSEMENT','VISIBILITY','PURGE')),
  action_id TEXT NOT NULL REFERENCES memory_v3_actions(action_id),
  last_stream_sequence INTEGER NOT NULL CHECK(last_stream_sequence >= 1),
  PRIMARY KEY(claim_id, action_family)
) STRICT;

CREATE TABLE IF NOT EXISTS memory_v3_terms (
  claim_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  workspace_id TEXT NOT NULL,
  term_kind TEXT NOT NULL CHECK(term_kind IN ('CONTENT','TAG','PATH','DEPENDENCY','SEMANTIC_KEY')),
  term_hmac TEXT NOT NULL CHECK(length(term_hmac) = 64),
  PRIMARY KEY(claim_id, version, term_kind, term_hmac),
  FOREIGN KEY(claim_id, version) REFERENCES memory_v3_claim_versions(claim_id, version)
) STRICT;

CREATE TRIGGER IF NOT EXISTS no_update_memory_v3_events BEFORE UPDATE ON memory_v3_events BEGIN SELECT RAISE(ABORT, 'memory v3 events are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_memory_v3_events BEFORE DELETE ON memory_v3_events BEGIN SELECT RAISE(ABORT, 'memory v3 events are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_update_memory_v3_commands BEFORE UPDATE ON memory_v3_commands BEGIN SELECT RAISE(ABORT, 'memory v3 commands are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_memory_v3_commands BEFORE DELETE ON memory_v3_commands BEGIN SELECT RAISE(ABORT, 'memory v3 commands are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_update_memory_v3_claim_versions BEFORE UPDATE ON memory_v3_claim_versions BEGIN SELECT RAISE(ABORT, 'memory v3 claim versions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_memory_v3_claim_versions BEFORE DELETE ON memory_v3_claim_versions BEGIN SELECT RAISE(ABORT, 'memory v3 claim versions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_update_memory_v3_actions BEFORE UPDATE ON memory_v3_actions BEGIN SELECT RAISE(ABORT, 'memory v3 actions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_memory_v3_actions BEFORE DELETE ON memory_v3_actions BEGIN SELECT RAISE(ABORT, 'memory v3 actions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_update_memory_v3_terms BEFORE UPDATE ON memory_v3_terms BEGIN SELECT RAISE(ABORT, 'memory v3 terms are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_memory_v3_terms BEFORE DELETE ON memory_v3_terms BEGIN SELECT RAISE(ABORT, 'memory v3 terms are immutable'); END;

CREATE INDEX IF NOT EXISTS ix_memory_v3_events_workspace ON memory_v3_events(workspace_id, stream_sequence);
CREATE INDEX IF NOT EXISTS ix_memory_v3_events_candidate ON memory_v3_events(workspace_id, candidate_sha256, stream_sequence DESC);
CREATE INDEX IF NOT EXISTS ix_memory_v3_heads_scope ON memory_v3_claim_heads(workspace_id, scope, scope_goal_id, channel, status, last_stream_sequence DESC);
CREATE INDEX IF NOT EXISTS ix_memory_v3_terms_lookup ON memory_v3_terms(workspace_id, term_hmac, claim_id, version);
CREATE INDEX IF NOT EXISTS ix_memory_v3_actions_claim ON memory_v3_actions(claim_id, action_family, created_stream_sequence DESC);

COMMIT;
