-- Goal Fit review identity belongs to an exact gate instance. Schema 021
-- incorrectly limited a Requirement/gate/Decision closure to one review,
-- which prevented a fresh assessment for a successor Plan revision.

ALTER TABLE goal_fit_reviews_v2 RENAME TO goal_fit_reviews_v2_schema21;

CREATE TABLE goal_fit_reviews_v2 (
  goal_fit_review_id TEXT PRIMARY KEY,
  requirement_revision_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  authority_root_id TEXT NOT NULL,
  decision_closure_id TEXT NOT NULL,
  gate TEXT NOT NULL CHECK(gate IN (
    'CONTRACT_REVIEW','CONTRACT_FREEZE','PLAN_ENTRY','IRREVERSIBLE_ARCHITECTURE','REPEATED_FAILURE','MATERIAL_CHANGE','FINAL_CLOSURE'
  )),
  verdict TEXT NOT NULL CHECK(verdict IN ('FIT','ASK_USER','REFRAME','REJECT')),
  review_owner TEXT NOT NULL CHECK(review_owner='HOST'),
  reason_codes_json TEXT NOT NULL CHECK(json_valid(reason_codes_json) AND json_type(reason_codes_json)='array'),
  reason_code_root_sha256 TEXT NOT NULL CHECK(length(reason_code_root_sha256)=64),
  source_root_sha256 TEXT NOT NULL CHECK(length(source_root_sha256)=64),
  requirement_root_sha256 TEXT NOT NULL CHECK(length(requirement_root_sha256)=64),
  decision_closure_sha256 TEXT NOT NULL CHECK(length(decision_closure_sha256)=64),
  input_closure_sha256 TEXT NOT NULL CHECK(length(input_closure_sha256)=64),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  FOREIGN KEY(requirement_revision_id,goal_id,contract_id,authority_root_id)
    REFERENCES requirement_revisions_v2(requirement_revision_id,goal_id,contract_id,authority_root_id),
  FOREIGN KEY(decision_closure_id,requirement_revision_id,goal_id,contract_id,authority_root_id)
    REFERENCES decision_closures_v2(decision_closure_id,requirement_revision_id,goal_id,contract_id,authority_root_id),
  UNIQUE(goal_fit_review_id,decision_closure_id,requirement_revision_id,goal_id,contract_id,authority_root_id)
) STRICT;

INSERT INTO goal_fit_reviews_v2(
  goal_fit_review_id,requirement_revision_id,goal_id,contract_id,authority_root_id,decision_closure_id,
  gate,verdict,review_owner,reason_codes_json,reason_code_root_sha256,source_root_sha256,
  requirement_root_sha256,decision_closure_sha256,input_closure_sha256,record_sha256,created_at_ms,
  created_event_sequence
)
SELECT
  goal_fit_review_id,requirement_revision_id,goal_id,contract_id,authority_root_id,decision_closure_id,
  gate,verdict,review_owner,reason_codes_json,reason_code_root_sha256,source_root_sha256,
  requirement_root_sha256,decision_closure_sha256,input_closure_sha256,record_sha256,created_at_ms,
  created_event_sequence
FROM goal_fit_reviews_v2_schema21;

DROP TABLE goal_fit_reviews_v2_schema21;

CREATE TRIGGER validate_goal_fit_review_closure_v2
BEFORE INSERT ON goal_fit_reviews_v2
WHEN NOT EXISTS (
  SELECT 1 FROM decision_closures_v2 d JOIN requirement_revisions_v2 r
    ON r.requirement_revision_id=d.requirement_revision_id
  WHERE d.decision_closure_id=NEW.decision_closure_id AND d.gate=NEW.gate
    AND d.record_sha256=NEW.decision_closure_sha256
    AND r.source_root_sha256=NEW.source_root_sha256
    AND r.requirements_root_sha256=NEW.requirement_root_sha256
    AND (NEW.verdict<>'FIT' OR d.qualified=1)
)
BEGIN SELECT RAISE(ABORT,'Goal Fit V2 closure mismatch'); END;

CREATE INDEX ix_goal_fit_review_goal_v2 ON goal_fit_reviews_v2(goal_id,gate,created_event_sequence);
CREATE TRIGGER no_update_goal_fit_reviews_v2 BEFORE UPDATE ON goal_fit_reviews_v2
BEGIN SELECT RAISE(ABORT,'Goal Fit V2 reviews are immutable'); END;
CREATE TRIGGER no_delete_goal_fit_reviews_v2 BEFORE DELETE ON goal_fit_reviews_v2
BEGIN SELECT RAISE(ABORT,'Goal Fit V2 reviews are immutable'); END;
