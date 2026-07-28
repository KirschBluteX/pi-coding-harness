PRAGMA foreign_keys = ON;
PRAGMA trusted_schema = OFF;
BEGIN IMMEDIATE;

CREATE TABLE IF NOT EXISTS memory_versions (
  memory_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version >= 1),
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  goal_id TEXT REFERENCES goals(goal_id),
  kind TEXT NOT NULL CHECK(kind IN ('EPISODIC', 'PREFERENCE', 'SEMANTIC', 'LESSON')),
  scope TEXT NOT NULL CHECK(scope IN ('GOAL', 'WORKSPACE', 'GLOBAL')),
  status TEXT NOT NULL CHECK(status IN ('PROPOSED', 'ACTIVE', 'SUPERSEDED', 'TOMBSTONED', 'EXPIRED')),
  source_kind TEXT NOT NULL CHECK(source_kind IN ('USER_EXPLICIT', 'PROJECT_FILE', 'AUTHORITY_RECEIPT', 'MODEL_INFERENCE')),
  source_locator TEXT NOT NULL,
  source_sha256 TEXT NOT NULL CHECK(length(source_sha256) = 64),
  tags_json TEXT NOT NULL,
  path_key TEXT,
  dependency_keys_json TEXT NOT NULL,
  pinned INTEGER NOT NULL CHECK(pinned IN (0,1)),
  content_text TEXT,
  content_artifact_id TEXT REFERENCES artifacts(artifact_id),
  content_sha256 TEXT NOT NULL CHECK(length(content_sha256) = 64),
  content_token_estimate INTEGER NOT NULL CHECK(content_token_estimate >= 0),
  confidence_basis TEXT NOT NULL CHECK(confidence_basis IN ('USER_CONFIRMED', 'AUTHORITY_VERIFIED', 'FILE_HASHED', 'INFERRED')),
  classification TEXT NOT NULL CHECK(classification IN ('PUBLIC', 'INTERNAL', 'SENSITIVE', 'SECRET')),
  valid_from_ms INTEGER NOT NULL,
  expires_at_ms INTEGER,
  supersedes_version INTEGER,
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence >= 1),
  PRIMARY KEY(memory_id, version),
  CHECK(content_text IS NOT NULL OR content_artifact_id IS NOT NULL)
) STRICT;

CREATE TABLE IF NOT EXISTS memory_index_outbox (
  memory_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('UPSERT', 'DELETE')),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence >= 1),
  indexed_at_ms INTEGER,
  PRIMARY KEY(memory_id, version),
  FOREIGN KEY(memory_id, version) REFERENCES memory_versions(memory_id, version)
) STRICT;

CREATE TABLE IF NOT EXISTS memory_lookup_terms (
  memory_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  workspace_id TEXT NOT NULL,
  term_kind TEXT NOT NULL CHECK(term_kind IN ('TAG', 'PATH', 'DEPENDENCY')),
  term TEXT NOT NULL,
  PRIMARY KEY(memory_id, version, term_kind, term),
  FOREIGN KEY(memory_id, version) REFERENCES memory_versions(memory_id, version)
) STRICT;

CREATE TRIGGER IF NOT EXISTS no_update_memory_versions BEFORE UPDATE ON memory_versions BEGIN SELECT RAISE(ABORT, 'memory versions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_memory_versions BEFORE DELETE ON memory_versions BEGIN SELECT RAISE(ABORT, 'memory versions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_memory_index_outbox BEFORE DELETE ON memory_index_outbox BEGIN SELECT RAISE(ABORT, 'memory index history is immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_update_memory_lookup_terms BEFORE UPDATE ON memory_lookup_terms BEGIN SELECT RAISE(ABORT, 'memory lookup terms are immutable'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_memory_lookup_terms BEFORE DELETE ON memory_lookup_terms BEGIN SELECT RAISE(ABORT, 'memory lookup terms are immutable'); END;
CREATE INDEX IF NOT EXISTS ix_memory_scope ON memory_versions(workspace_id, goal_id, scope, status);
CREATE INDEX IF NOT EXISTS ix_memory_source ON memory_versions(workspace_id, source_locator, source_sha256);
CREATE INDEX IF NOT EXISTS ix_memory_pinned ON memory_versions(workspace_id, pinned, valid_from_ms);
CREATE INDEX IF NOT EXISTS ix_memory_lookup_term ON memory_lookup_terms(workspace_id, term, memory_id, version);

COMMIT;
