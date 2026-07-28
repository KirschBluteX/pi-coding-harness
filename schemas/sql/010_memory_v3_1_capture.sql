PRAGMA foreign_keys = ON;
PRAGMA trusted_schema = OFF;
BEGIN IMMEDIATE;

CREATE TABLE memory_v31_capture_intents (
  intent_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  capture_event_id TEXT NOT NULL UNIQUE REFERENCES memory_v3_events(event_id),
  idempotency_key_sha256 TEXT NOT NULL CHECK(length(idempotency_key_sha256) = 64),
  candidate_sha256 TEXT NOT NULL CHECK(length(candidate_sha256) = 64),
  concept_sha256 TEXT CHECK(concept_sha256 IS NULL OR length(concept_sha256) = 64),
  route TEXT NOT NULL CHECK(route IN ('EXPLICIT_AUTO','AUTHORITY_DERIVED','PROPOSE_ONLY')),
  source_kind TEXT NOT NULL CHECK(source_kind IN ('USER_INPUT','AUTHORITY_DECISION','ROUTE_FAILURE','AGENT_PROPOSAL')),
  source_actor TEXT NOT NULL CHECK(source_actor IN ('USER','AGENT','RUNTIME')),
  goal_id TEXT,
  scope TEXT NOT NULL CHECK(scope IN ('GOAL','WORKSPACE')),
  channel TEXT NOT NULL CHECK(channel IN ('POLICY','EVIDENCE','EXPERIENCE')),
  classification TEXT NOT NULL CHECK(classification IN ('PUBLIC','INTERNAL')),
  source_session_hmac TEXT CHECK(source_session_hmac IS NULL OR length(source_session_hmac) = 64),
  source_day_bucket INTEGER NOT NULL CHECK(source_day_bucket >= 0),
  source_content_sha256 TEXT NOT NULL CHECK(length(source_content_sha256) = 64),
  authority_context_sha256 TEXT CHECK(authority_context_sha256 IS NULL OR length(authority_context_sha256) = 64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms > created_at_ms),
  intent_sha256 TEXT NOT NULL UNIQUE CHECK(length(intent_sha256) = 64),
  UNIQUE(workspace_id,idempotency_key_sha256),
  CHECK((scope='GOAL' AND goal_id IS NOT NULL) OR scope='WORKSPACE')
) STRICT;

CREATE TABLE memory_v31_capture_outbox (
  intent_id TEXT PRIMARY KEY REFERENCES memory_v31_capture_intents(intent_id),
  state TEXT NOT NULL CHECK(state IN ('PREPARED','VAULT_PREPARED','COMMITTED','ABORTED')),
  attempt_count INTEGER NOT NULL CHECK(attempt_count >= 0),
  observation_id TEXT,
  authority_metadata_sha256 TEXT,
  body_sha256 TEXT,
  vault_ref_sha256 TEXT,
  key_ref_sha256 TEXT,
  ciphertext_sha256 TEXT,
  wrapped_key_sha256 TEXT,
  last_error_code TEXT,
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),
  CHECK((state='PREPARED' AND observation_id IS NULL)
    OR (state='VAULT_PREPARED' AND observation_id IS NOT NULL)
    OR state IN ('COMMITTED','ABORTED')),
  CHECK(observation_id IS NULL OR (
    length(authority_metadata_sha256)=64 AND length(body_sha256)=64 AND length(vault_ref_sha256)=64
    AND length(key_ref_sha256)=64 AND length(ciphertext_sha256)=64 AND length(wrapped_key_sha256)=64))
) STRICT;

CREATE TABLE memory_v31_observations (
  observation_id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL UNIQUE REFERENCES memory_v31_capture_intents(intent_id),
  workspace_id TEXT NOT NULL,
  concept_sha256 TEXT NOT NULL CHECK(length(concept_sha256) = 64),
  source_session_hmac TEXT,
  source_day_bucket INTEGER NOT NULL CHECK(source_day_bucket >= 0),
  source_message_sha256 TEXT NOT NULL CHECK(length(source_message_sha256) = 64),
  independence_key_sha256 TEXT NOT NULL CHECK(length(independence_key_sha256) = 64),
  authority_metadata_sha256 TEXT NOT NULL CHECK(length(authority_metadata_sha256) = 64),
  body_sha256 TEXT NOT NULL CHECK(length(body_sha256) = 64),
  vault_ref_sha256 TEXT NOT NULL UNIQUE CHECK(length(vault_ref_sha256) = 64),
  key_ref_sha256 TEXT NOT NULL UNIQUE CHECK(length(key_ref_sha256) = 64),
  ciphertext_sha256 TEXT NOT NULL CHECK(length(ciphertext_sha256) = 64),
  wrapped_key_sha256 TEXT NOT NULL CHECK(length(wrapped_key_sha256) = 64),
  observed_at_ms INTEGER NOT NULL CHECK(observed_at_ms >= 0),
  expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms > observed_at_ms),
  observation_sha256 TEXT NOT NULL UNIQUE CHECK(length(observation_sha256) = 64),
  CHECK(source_session_hmac IS NULL OR length(source_session_hmac) = 64),
  UNIQUE(workspace_id,independence_key_sha256)
) STRICT;

CREATE TABLE memory_v31_observation_retirements (
  retirement_id TEXT PRIMARY KEY,
  observation_id TEXT NOT NULL UNIQUE REFERENCES memory_v31_observations(observation_id),
  reason TEXT NOT NULL CHECK(reason IN ('EXPIRED','QUOTA','USER_REJECTED','PURGED')),
  retired_at_ms INTEGER NOT NULL CHECK(retired_at_ms >= 0),
  retirement_sha256 TEXT NOT NULL UNIQUE CHECK(length(retirement_sha256) = 64)
) STRICT;

CREATE TABLE memory_v31_candidate_clusters (
  workspace_id TEXT NOT NULL,
  concept_sha256 TEXT NOT NULL CHECK(length(concept_sha256) = 64),
  scope TEXT NOT NULL CHECK(scope IN ('GOAL','WORKSPACE')),
  goal_id TEXT,
  channel TEXT NOT NULL CHECK(channel IN ('POLICY','EVIDENCE','EXPERIENCE')),
  state TEXT NOT NULL CHECK(state IN ('OPEN','PROPOSED','ACTIVE','REJECTED')),
  active_observation_count INTEGER NOT NULL CHECK(active_observation_count >= 0),
  independent_session_count INTEGER NOT NULL CHECK(independent_session_count >= 0),
  independent_day_count INTEGER NOT NULL CHECK(independent_day_count >= 0),
  current_claim_id TEXT,
  first_observed_at_ms INTEGER NOT NULL CHECK(first_observed_at_ms >= 0),
  last_observed_at_ms INTEGER NOT NULL CHECK(last_observed_at_ms >= first_observed_at_ms),
  cluster_sha256 TEXT NOT NULL CHECK(length(cluster_sha256) = 64),
  PRIMARY KEY(workspace_id,concept_sha256),
  CHECK((scope='GOAL' AND goal_id IS NOT NULL) OR scope='WORKSPACE')
) STRICT;

CREATE TABLE memory_v31_proposals (
  proposal_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  concept_sha256 TEXT NOT NULL CHECK(length(concept_sha256) = 64),
  claim_id TEXT NOT NULL UNIQUE REFERENCES memory_v3_claim_heads(claim_id),
  source_intent_id TEXT NOT NULL REFERENCES memory_v31_capture_intents(intent_id),
  evidence_manifest_sha256 TEXT NOT NULL CHECK(length(evidence_manifest_sha256) = 64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms > created_at_ms),
  proposal_sha256 TEXT NOT NULL UNIQUE CHECK(length(proposal_sha256) = 64),
  UNIQUE(workspace_id,concept_sha256)
) STRICT;

CREATE TABLE memory_v31_proposal_resolutions (
  resolution_id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL UNIQUE REFERENCES memory_v31_proposals(proposal_id),
  result TEXT NOT NULL CHECK(result IN ('APPROVED','REJECTED','EXPIRED','PURGED')),
  action_id TEXT,
  resolved_at_ms INTEGER NOT NULL CHECK(resolved_at_ms >= 0),
  resolution_sha256 TEXT NOT NULL UNIQUE CHECK(length(resolution_sha256) = 64)
) STRICT;

CREATE TABLE memory_v31_capture_receipts (
  receipt_id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL UNIQUE REFERENCES memory_v31_capture_intents(intent_id),
  result TEXT NOT NULL CHECK(result IN ('ACTIVE','OBSERVED','PROPOSED','QUOTA_REJECTED','ABORTED')),
  observation_id TEXT REFERENCES memory_v31_observations(observation_id),
  claim_id TEXT REFERENCES memory_v3_claim_heads(claim_id),
  reason_code TEXT NOT NULL,
  receipt_sha256 TEXT NOT NULL UNIQUE CHECK(length(receipt_sha256) = 64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  CHECK((result='OBSERVED' AND observation_id IS NOT NULL AND claim_id IS NULL)
    OR (result IN ('ACTIVE','PROPOSED') AND claim_id IS NOT NULL)
    OR (result IN ('QUOTA_REJECTED','ABORTED') AND observation_id IS NULL AND claim_id IS NULL))
) STRICT;

CREATE INDEX ix_memory_v31_intents_pending ON memory_v31_capture_intents(workspace_id,created_at_ms,intent_id);
CREATE INDEX ix_memory_v31_observations_active ON memory_v31_observations(workspace_id,concept_sha256,expires_at_ms,observed_at_ms);
CREATE INDEX ix_memory_v31_clusters_state ON memory_v31_candidate_clusters(workspace_id,state,last_observed_at_ms);
CREATE INDEX ix_memory_v31_proposals_expiry ON memory_v31_proposals(workspace_id,expires_at_ms);
CREATE INDEX ix_memory_v31_outbox_state ON memory_v31_capture_outbox(state,updated_at_ms);

CREATE TRIGGER no_update_memory_v31_capture_intents BEFORE UPDATE ON memory_v31_capture_intents
BEGIN SELECT RAISE(ABORT, 'memory v3.1 capture intents are immutable'); END;
CREATE TRIGGER no_delete_memory_v31_capture_intents BEFORE DELETE ON memory_v31_capture_intents
BEGIN SELECT RAISE(ABORT, 'memory v3.1 capture intents are immutable'); END;
CREATE TRIGGER no_update_memory_v31_observations BEFORE UPDATE ON memory_v31_observations
BEGIN SELECT RAISE(ABORT, 'memory v3.1 observations are immutable'); END;
CREATE TRIGGER no_delete_memory_v31_observations BEFORE DELETE ON memory_v31_observations
BEGIN SELECT RAISE(ABORT, 'memory v3.1 observations are immutable'); END;
CREATE TRIGGER no_update_memory_v31_observation_retirements BEFORE UPDATE ON memory_v31_observation_retirements
BEGIN SELECT RAISE(ABORT, 'memory v3.1 observation retirements are immutable'); END;
CREATE TRIGGER no_delete_memory_v31_observation_retirements BEFORE DELETE ON memory_v31_observation_retirements
BEGIN SELECT RAISE(ABORT, 'memory v3.1 observation retirements are immutable'); END;
CREATE TRIGGER no_update_memory_v31_proposals BEFORE UPDATE ON memory_v31_proposals
BEGIN SELECT RAISE(ABORT, 'memory v3.1 proposals are immutable'); END;
CREATE TRIGGER no_delete_memory_v31_proposals BEFORE DELETE ON memory_v31_proposals
BEGIN SELECT RAISE(ABORT, 'memory v3.1 proposals are immutable'); END;
CREATE TRIGGER no_update_memory_v31_proposal_resolutions BEFORE UPDATE ON memory_v31_proposal_resolutions
BEGIN SELECT RAISE(ABORT, 'memory v3.1 proposal resolutions are immutable'); END;
CREATE TRIGGER no_delete_memory_v31_proposal_resolutions BEFORE DELETE ON memory_v31_proposal_resolutions
BEGIN SELECT RAISE(ABORT, 'memory v3.1 proposal resolutions are immutable'); END;
CREATE TRIGGER no_update_memory_v31_capture_receipts BEFORE UPDATE ON memory_v31_capture_receipts
BEGIN SELECT RAISE(ABORT, 'memory v3.1 capture receipts are immutable'); END;
CREATE TRIGGER no_delete_memory_v31_capture_receipts BEFORE DELETE ON memory_v31_capture_receipts
BEGIN SELECT RAISE(ABORT, 'memory v3.1 capture receipts are immutable'); END;

COMMIT;
