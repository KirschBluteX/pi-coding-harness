-- Plan/Change/Invalidation V2 is additive. V1 Route records are validated
-- execution projections; the Host-derived Plan closure below is authoritative.

CREATE TABLE plan_revisions_v2 (
  plan_revision_id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  authority_root_id TEXT NOT NULL,
  contract_freeze_receipt_id TEXT NOT NULL,
  contract_freeze_sha256 TEXT NOT NULL CHECK(length(contract_freeze_sha256)=64),
  requirement_revision_id TEXT NOT NULL,
  requirement_revision_sha256 TEXT NOT NULL CHECK(length(requirement_revision_sha256)=64),
  route_id TEXT NOT NULL,
  route_sha256 TEXT NOT NULL CHECK(length(route_sha256)=64),
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 1000000),
  parent_plan_revision_id TEXT REFERENCES plan_revisions_v2(plan_revision_id),
  parent_plan_revision_sha256 TEXT CHECK(parent_plan_revision_sha256 IS NULL OR length(parent_plan_revision_sha256)=64),
  subject_root_sha256 TEXT NOT NULL CHECK(length(subject_root_sha256)=64),
  dependency_root_sha256 TEXT NOT NULL CHECK(length(dependency_root_sha256)=64),
  must_requirement_root_sha256 TEXT NOT NULL CHECK(length(must_requirement_root_sha256)=64),
  work_cell_root_sha256 TEXT NOT NULL CHECK(length(work_cell_root_sha256)=64),
  input_closure_sha256 TEXT NOT NULL CHECK(length(input_closure_sha256)=64),
  subject_count INTEGER NOT NULL CHECK(subject_count BETWEEN 1 AND 8192),
  dependency_count INTEGER NOT NULL CHECK(dependency_count BETWEEN 0 AND 32768),
  requirement_count INTEGER NOT NULL CHECK(requirement_count BETWEEN 1 AND 512),
  work_cell_count INTEGER NOT NULL CHECK(work_cell_count BETWEEN 1 AND 8192),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  CHECK((revision=1 AND parent_plan_revision_id IS NULL AND parent_plan_revision_sha256 IS NULL)
    OR (revision>1 AND parent_plan_revision_id IS NOT NULL AND parent_plan_revision_sha256 IS NOT NULL)),
  FOREIGN KEY(contract_freeze_receipt_id,goal_id,contract_id,authority_root_id)
    REFERENCES contract_freeze_receipts_v2(contract_freeze_receipt_id,goal_id,contract_id,authority_root_id),
  FOREIGN KEY(requirement_revision_id,goal_id,contract_id,authority_root_id)
    REFERENCES requirement_revisions_v2(requirement_revision_id,goal_id,contract_id,authority_root_id),
  FOREIGN KEY(route_id) REFERENCES route_skeleton_versions_v1(route_id),
  UNIQUE(goal_id,revision),
  UNIQUE(plan_id,revision),
  UNIQUE(plan_revision_id,goal_id),
  UNIQUE(plan_revision_id,plan_id,goal_id),
  UNIQUE(plan_revision_id,plan_id,goal_id,contract_id,authority_root_id)
) STRICT;

CREATE TRIGGER validate_plan_revision_inputs_v2
BEFORE INSERT ON plan_revisions_v2
WHEN NOT EXISTS (
  SELECT 1 FROM contract_freeze_receipts_v2 f
  JOIN requirement_revisions_v2 r ON r.requirement_revision_id=f.requirement_revision_id
  JOIN route_skeleton_versions_v1 v ON v.route_id=NEW.route_id
  WHERE f.contract_freeze_receipt_id=NEW.contract_freeze_receipt_id
    AND f.goal_id=NEW.goal_id AND f.contract_id=NEW.contract_id AND f.authority_root_id=NEW.authority_root_id
    AND f.record_sha256=NEW.contract_freeze_sha256
    AND r.requirement_revision_id=NEW.requirement_revision_id
    AND r.record_sha256=NEW.requirement_revision_sha256
    AND v.goal_id=NEW.goal_id AND v.contract_id=NEW.contract_id AND v.record_sha256=NEW.route_sha256
)
BEGIN SELECT RAISE(ABORT,'Plan V2 input closure is not current'); END;

CREATE TRIGGER validate_plan_revision_parent_v2
BEFORE INSERT ON plan_revisions_v2
WHEN NEW.parent_plan_revision_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM plan_revisions_v2 p
  WHERE p.plan_revision_id=NEW.parent_plan_revision_id AND p.plan_id=NEW.plan_id
    AND p.goal_id=NEW.goal_id AND p.revision=NEW.revision-1
    AND p.record_sha256=NEW.parent_plan_revision_sha256
)
BEGIN SELECT RAISE(ABORT,'Plan V2 parent revision mismatch'); END;

CREATE TABLE plan_subjects_v2 (
  plan_revision_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK(subject_kind IN ('REQUIREMENT','DECISION','WORK_CELL')),
  subject_id TEXT NOT NULL CHECK(length(subject_id) BETWEEN 1 AND 160),
  revision_sha256 TEXT NOT NULL CHECK(length(revision_sha256)=64),
  ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 8191),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  PRIMARY KEY(plan_revision_id,subject_kind,subject_id),
  UNIQUE(plan_revision_id,ordinal),
  UNIQUE(plan_revision_id,subject_kind,subject_id,goal_id),
  FOREIGN KEY(plan_revision_id,goal_id) REFERENCES plan_revisions_v2(plan_revision_id,goal_id)
) WITHOUT ROWID, STRICT;

CREATE TRIGGER validate_plan_requirement_subject_v2
BEFORE INSERT ON plan_subjects_v2
WHEN NEW.subject_kind='REQUIREMENT' AND NOT EXISTS (
  SELECT 1 FROM plan_revisions_v2 p JOIN requirement_items_v2 r
    ON r.requirement_revision_id=p.requirement_revision_id
  WHERE p.plan_revision_id=NEW.plan_revision_id AND r.requirement_id=NEW.subject_id
    AND r.goal_id=NEW.goal_id AND r.record_sha256=NEW.revision_sha256
)
BEGIN SELECT RAISE(ABORT,'Plan V2 Requirement subject mismatch'); END;

CREATE TRIGGER validate_plan_decision_subject_v2
BEFORE INSERT ON plan_subjects_v2
WHEN NEW.subject_kind='DECISION' AND NOT EXISTS (
  SELECT 1 FROM plan_revisions_v2 p JOIN decision_requirements_v2 d
    ON d.requirement_revision_id=p.requirement_revision_id
  WHERE p.plan_revision_id=NEW.plan_revision_id AND d.decision_requirement_id=NEW.subject_id
    AND d.goal_id=NEW.goal_id AND d.record_sha256=NEW.revision_sha256
)
BEGIN SELECT RAISE(ABORT,'Plan V2 Decision subject mismatch'); END;

CREATE TRIGGER validate_plan_work_cell_subject_v2
BEFORE INSERT ON plan_subjects_v2
WHEN NEW.subject_kind='WORK_CELL' AND NOT EXISTS (
  SELECT 1 FROM plan_revisions_v2 p JOIN work_cells_v1 w ON w.route_id=p.route_id
  WHERE p.plan_revision_id=NEW.plan_revision_id AND w.logical_key=NEW.subject_id
    AND w.goal_id=NEW.goal_id AND w.spec_sha256=NEW.revision_sha256
)
BEGIN SELECT RAISE(ABORT,'Plan V2 WorkCell subject mismatch'); END;

CREATE TABLE plan_dependency_edges_v2 (
  edge_id TEXT PRIMARY KEY,
  plan_revision_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('REQUIREMENT','DECISION','WORK_CELL')),
  source_id TEXT NOT NULL CHECK(length(source_id) BETWEEN 1 AND 160),
  target_kind TEXT NOT NULL CHECK(target_kind IN ('REQUIREMENT','DECISION','WORK_CELL')),
  target_id TEXT NOT NULL CHECK(length(target_id) BETWEEN 1 AND 160),
  dependency_kind TEXT NOT NULL CHECK(dependency_kind IN ('REQUIRES','SATISFIES','DERIVED_FROM','PRODUCES','AUTHORIZES')),
  ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 32767),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  CHECK(source_kind<>target_kind OR source_id<>target_id),
  FOREIGN KEY(plan_revision_id,source_kind,source_id,goal_id)
    REFERENCES plan_subjects_v2(plan_revision_id,subject_kind,subject_id,goal_id),
  FOREIGN KEY(plan_revision_id,target_kind,target_id,goal_id)
    REFERENCES plan_subjects_v2(plan_revision_id,subject_kind,subject_id,goal_id),
  UNIQUE(plan_revision_id,source_kind,source_id,target_kind,target_id,dependency_kind),
  UNIQUE(plan_revision_id,ordinal)
) STRICT;

CREATE TABLE plan_heads_v2 (
  goal_id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  plan_revision_id TEXT NOT NULL UNIQUE,
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 1000000),
  plan_revision_sha256 TEXT NOT NULL CHECK(length(plan_revision_sha256)=64),
  updated_event_sequence INTEGER NOT NULL CHECK(updated_event_sequence>=1),
  FOREIGN KEY(plan_revision_id,plan_id,goal_id)
    REFERENCES plan_revisions_v2(plan_revision_id,plan_id,goal_id)
) STRICT;

CREATE INDEX ix_plan_subjects_v2_kind ON plan_subjects_v2(plan_revision_id,subject_kind,ordinal);
CREATE INDEX ix_plan_edges_v2_source ON plan_dependency_edges_v2(plan_revision_id,source_kind,source_id);
CREATE INDEX ix_plan_edges_v2_target ON plan_dependency_edges_v2(plan_revision_id,target_kind,target_id);

CREATE TRIGGER no_update_plan_revisions_v2 BEFORE UPDATE ON plan_revisions_v2
BEGIN SELECT RAISE(ABORT,'Plan V2 revisions are immutable'); END;
CREATE TRIGGER no_delete_plan_revisions_v2 BEFORE DELETE ON plan_revisions_v2
BEGIN SELECT RAISE(ABORT,'Plan V2 revisions are immutable'); END;
CREATE TRIGGER no_update_plan_subjects_v2 BEFORE UPDATE ON plan_subjects_v2
BEGIN SELECT RAISE(ABORT,'Plan V2 subjects are immutable'); END;
CREATE TRIGGER no_delete_plan_subjects_v2 BEFORE DELETE ON plan_subjects_v2
BEGIN SELECT RAISE(ABORT,'Plan V2 subjects are immutable'); END;
CREATE TRIGGER no_update_plan_dependency_edges_v2 BEFORE UPDATE ON plan_dependency_edges_v2
BEGIN SELECT RAISE(ABORT,'Plan V2 dependency edges are immutable'); END;
CREATE TRIGGER no_delete_plan_dependency_edges_v2 BEFORE DELETE ON plan_dependency_edges_v2
BEGIN SELECT RAISE(ABORT,'Plan V2 dependency edges are immutable'); END;

CREATE TABLE stage_gate_receipts_v2 (
  stage_gate_receipt_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  plan_revision_id TEXT NOT NULL,
  plan_revision_sha256 TEXT NOT NULL CHECK(length(plan_revision_sha256)=64),
  contract_id TEXT NOT NULL,
  authority_root_id TEXT NOT NULL,
  contract_freeze_receipt_id TEXT NOT NULL,
  contract_freeze_sha256 TEXT NOT NULL CHECK(length(contract_freeze_sha256)=64),
  requirement_revision_id TEXT NOT NULL,
  requirement_revision_sha256 TEXT NOT NULL CHECK(length(requirement_revision_sha256)=64),
  decision_closure_id TEXT NOT NULL,
  decision_closure_sha256 TEXT NOT NULL CHECK(length(decision_closure_sha256)=64),
  goal_fit_review_id TEXT NOT NULL,
  goal_fit_review_sha256 TEXT NOT NULL CHECK(length(goal_fit_review_sha256)=64),
  gate TEXT NOT NULL CHECK(gate IN (
    'PLAN_ENTRY','IRREVERSIBLE_ARCHITECTURE','REPEATED_FAILURE','MATERIAL_CHANGE','FINAL_CLOSURE'
  )),
  event_head_sha256 TEXT NOT NULL CHECK(length(event_head_sha256)=64),
  review_owner TEXT NOT NULL CHECK(review_owner='HOST'),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  FOREIGN KEY(plan_revision_id,plan_id,goal_id,contract_id,authority_root_id)
    REFERENCES plan_revisions_v2(plan_revision_id,plan_id,goal_id,contract_id,authority_root_id),
  FOREIGN KEY(contract_freeze_receipt_id,goal_id,contract_id,authority_root_id)
    REFERENCES contract_freeze_receipts_v2(contract_freeze_receipt_id,goal_id,contract_id,authority_root_id),
  FOREIGN KEY(goal_fit_review_id,decision_closure_id,requirement_revision_id,goal_id,contract_id,authority_root_id)
    REFERENCES goal_fit_reviews_v2(goal_fit_review_id,decision_closure_id,requirement_revision_id,goal_id,contract_id,authority_root_id),
  UNIQUE(plan_revision_id,gate)
) STRICT;

CREATE TRIGGER validate_stage_gate_closure_v2
BEFORE INSERT ON stage_gate_receipts_v2
WHEN NOT EXISTS (
  SELECT 1 FROM plan_revisions_v2 p
  JOIN contract_freeze_receipts_v2 f ON f.contract_freeze_receipt_id=p.contract_freeze_receipt_id
  JOIN goal_fit_reviews_v2 g ON g.goal_fit_review_id=NEW.goal_fit_review_id
  JOIN decision_closures_v2 d ON d.decision_closure_id=g.decision_closure_id
  WHERE p.plan_revision_id=NEW.plan_revision_id AND p.record_sha256=NEW.plan_revision_sha256
    AND p.contract_freeze_receipt_id=NEW.contract_freeze_receipt_id
    AND f.record_sha256=NEW.contract_freeze_sha256
    AND p.requirement_revision_id=NEW.requirement_revision_id
    AND p.requirement_revision_sha256=NEW.requirement_revision_sha256
    AND g.requirement_revision_id=p.requirement_revision_id AND g.gate=NEW.gate
    AND g.verdict='FIT' AND g.review_owner='HOST' AND g.record_sha256=NEW.goal_fit_review_sha256
    AND d.gate=NEW.gate AND d.qualified=1 AND d.record_sha256=NEW.decision_closure_sha256
    AND NEW.created_event_sequence>p.created_event_sequence
    AND NEW.created_event_sequence>g.created_event_sequence
)
BEGIN SELECT RAISE(ABORT,'Stage gate V2 closure mismatch'); END;

CREATE INDEX ix_stage_gate_receipts_v2_goal ON stage_gate_receipts_v2(goal_id,gate,created_event_sequence);
CREATE TRIGGER no_update_stage_gate_receipts_v2 BEFORE UPDATE ON stage_gate_receipts_v2
BEGIN SELECT RAISE(ABORT,'Stage gate V2 receipts are immutable'); END;
CREATE TRIGGER no_delete_stage_gate_receipts_v2 BEFORE DELETE ON stage_gate_receipts_v2
BEGIN SELECT RAISE(ABORT,'Stage gate V2 receipts are immutable'); END;

CREATE TABLE change_requests_v2 (
  change_request_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  base_plan_revision_id TEXT NOT NULL,
  base_plan_revision_sha256 TEXT NOT NULL CHECK(length(base_plan_revision_sha256)=64),
  classification TEXT NOT NULL CHECK(classification IN (
    'CORRECT_CURRENT','QUEUE_NEXT','CHANGE_REQUEST','NEW_GOAL','INTERRUPT_NOW','DISCUSSION_ONLY'
  )),
  materiality TEXT NOT NULL CHECK(materiality IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  request_payload_json TEXT NOT NULL CHECK(json_valid(request_payload_json) AND length(request_payload_json)<=131072),
  request_payload_sha256 TEXT NOT NULL CHECK(length(request_payload_sha256)=64),
  changed_subject_root_sha256 TEXT NOT NULL CHECK(length(changed_subject_root_sha256)=64),
  changed_subject_count INTEGER NOT NULL CHECK(changed_subject_count BETWEEN 0 AND 512),
  source_kind TEXT NOT NULL CHECK(source_kind='USER_TURN'),
  session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 1 AND 160),
  turn_id TEXT NOT NULL CHECK(length(turn_id) BETWEEN 1 AND 160),
  event_head_sha256 TEXT NOT NULL CHECK(length(event_head_sha256)=64),
  source_bytes BLOB NOT NULL CHECK(typeof(source_bytes)='blob' AND length(source_bytes) BETWEEN 1 AND 131072),
  content_sha256 TEXT NOT NULL CHECK(length(content_sha256)=64),
  byte_length INTEGER NOT NULL CHECK(byte_length BETWEEN 1 AND 131072 AND byte_length=length(source_bytes)),
  encoding TEXT NOT NULL CHECK(encoding='UTF-8'),
  fidelity TEXT NOT NULL CHECK(fidelity='EXACT'),
  captured_by TEXT NOT NULL CHECK(captured_by='HOST'),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  FOREIGN KEY(base_plan_revision_id,goal_id)
    REFERENCES plan_revisions_v2(plan_revision_id,goal_id),
  UNIQUE(base_plan_revision_id,session_id,turn_id,event_head_sha256),
  UNIQUE(change_request_id,goal_id,base_plan_revision_id)
) STRICT;

CREATE TABLE change_request_subjects_v2 (
  change_request_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  base_plan_revision_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK(subject_kind IN ('REQUIREMENT','DECISION','WORK_CELL')),
  subject_id TEXT NOT NULL CHECK(length(subject_id) BETWEEN 1 AND 160),
  revision_sha256 TEXT NOT NULL CHECK(length(revision_sha256)=64),
  ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 511),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  PRIMARY KEY(change_request_id,subject_kind,subject_id),
  UNIQUE(change_request_id,ordinal),
  FOREIGN KEY(change_request_id,goal_id,base_plan_revision_id)
    REFERENCES change_requests_v2(change_request_id,goal_id,base_plan_revision_id),
  FOREIGN KEY(base_plan_revision_id,subject_kind,subject_id,goal_id)
    REFERENCES plan_subjects_v2(plan_revision_id,subject_kind,subject_id,goal_id)
) WITHOUT ROWID, STRICT;

CREATE TABLE plan_change_impacts_v2 (
  plan_change_impact_id TEXT PRIMARY KEY,
  change_request_id TEXT NOT NULL UNIQUE,
  goal_id TEXT NOT NULL,
  base_plan_revision_id TEXT NOT NULL,
  base_plan_revision_sha256 TEXT NOT NULL CHECK(length(base_plan_revision_sha256)=64),
  changed_root_sha256 TEXT NOT NULL CHECK(length(changed_root_sha256)=64),
  invalidation_root_sha256 TEXT NOT NULL CHECK(length(invalidation_root_sha256)=64),
  reuse_root_sha256 TEXT NOT NULL CHECK(length(reuse_root_sha256)=64),
  propagation_root_sha256 TEXT NOT NULL CHECK(length(propagation_root_sha256)=64),
  changed_count INTEGER NOT NULL CHECK(changed_count BETWEEN 0 AND 512),
  invalidated_count INTEGER NOT NULL CHECK(invalidated_count BETWEEN 0 AND 8192),
  reusable_count INTEGER NOT NULL CHECK(reusable_count BETWEEN 0 AND 8192),
  propagation_count INTEGER NOT NULL CHECK(propagation_count BETWEEN 0 AND 32768),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  FOREIGN KEY(change_request_id,goal_id,base_plan_revision_id)
    REFERENCES change_requests_v2(change_request_id,goal_id,base_plan_revision_id),
  UNIQUE(plan_change_impact_id,change_request_id,goal_id,base_plan_revision_id)
) STRICT;

CREATE TABLE plan_change_impact_members_v2 (
  plan_change_impact_id TEXT NOT NULL,
  change_request_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  base_plan_revision_id TEXT NOT NULL,
  disposition TEXT NOT NULL CHECK(disposition IN ('CHANGED','INVALIDATED','REUSABLE')),
  subject_kind TEXT NOT NULL CHECK(subject_kind IN ('REQUIREMENT','DECISION','WORK_CELL')),
  subject_id TEXT NOT NULL CHECK(length(subject_id) BETWEEN 1 AND 160),
  revision_sha256 TEXT NOT NULL CHECK(length(revision_sha256)=64),
  ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 8191),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  PRIMARY KEY(plan_change_impact_id,disposition,subject_kind,subject_id),
  UNIQUE(plan_change_impact_id,disposition,ordinal),
  FOREIGN KEY(plan_change_impact_id,change_request_id,goal_id,base_plan_revision_id)
    REFERENCES plan_change_impacts_v2(plan_change_impact_id,change_request_id,goal_id,base_plan_revision_id),
  FOREIGN KEY(base_plan_revision_id,subject_kind,subject_id,goal_id)
    REFERENCES plan_subjects_v2(plan_revision_id,subject_kind,subject_id,goal_id)
) WITHOUT ROWID, STRICT;

CREATE TABLE plan_invalidation_edges_v2 (
  invalidation_edge_id TEXT PRIMARY KEY,
  plan_change_impact_id TEXT NOT NULL,
  change_request_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  base_plan_revision_id TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('REQUIREMENT','DECISION','WORK_CELL')),
  source_id TEXT NOT NULL CHECK(length(source_id) BETWEEN 1 AND 160),
  target_kind TEXT NOT NULL CHECK(target_kind IN ('REQUIREMENT','DECISION','WORK_CELL')),
  target_id TEXT NOT NULL CHECK(length(target_id) BETWEEN 1 AND 160),
  dependency_kind TEXT NOT NULL CHECK(dependency_kind IN ('REQUIRES','SATISFIES','DERIVED_FROM','PRODUCES')),
  invalidation_kind TEXT NOT NULL CHECK(invalidation_kind='TRANSITIVE_DEPENDENT'),
  ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 32767),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  FOREIGN KEY(plan_change_impact_id,change_request_id,goal_id,base_plan_revision_id)
    REFERENCES plan_change_impacts_v2(plan_change_impact_id,change_request_id,goal_id,base_plan_revision_id),
  FOREIGN KEY(base_plan_revision_id,source_kind,source_id,goal_id)
    REFERENCES plan_subjects_v2(plan_revision_id,subject_kind,subject_id,goal_id),
  FOREIGN KEY(base_plan_revision_id,target_kind,target_id,goal_id)
    REFERENCES plan_subjects_v2(plan_revision_id,subject_kind,subject_id,goal_id),
  UNIQUE(plan_change_impact_id,source_kind,source_id,target_kind,target_id,dependency_kind),
  UNIQUE(plan_change_impact_id,ordinal)
) STRICT;

CREATE TRIGGER validate_plan_invalidation_edge_v2
BEFORE INSERT ON plan_invalidation_edges_v2
WHEN NOT EXISTS (
  SELECT 1 FROM plan_dependency_edges_v2 e
  JOIN plan_change_impact_members_v2 s ON s.plan_change_impact_id=NEW.plan_change_impact_id
    AND s.disposition='INVALIDATED' AND s.subject_kind=NEW.source_kind AND s.subject_id=NEW.source_id
  JOIN plan_change_impact_members_v2 t ON t.plan_change_impact_id=NEW.plan_change_impact_id
    AND t.disposition='INVALIDATED' AND t.subject_kind=NEW.target_kind AND t.subject_id=NEW.target_id
  WHERE e.plan_revision_id=NEW.base_plan_revision_id
    AND e.source_kind=NEW.source_kind AND e.source_id=NEW.source_id
    AND e.target_kind=NEW.target_kind AND e.target_id=NEW.target_id
    AND e.dependency_kind=NEW.dependency_kind AND e.dependency_kind<>'AUTHORIZES'
)
BEGIN SELECT RAISE(ABORT,'Plan invalidation edge V2 is outside the derived closure'); END;

CREATE TABLE plan_reuse_receipts_v2 (
  reuse_receipt_id TEXT PRIMARY KEY,
  change_request_id TEXT NOT NULL,
  plan_change_impact_id TEXT NOT NULL,
  plan_change_impact_sha256 TEXT NOT NULL CHECK(length(plan_change_impact_sha256)=64),
  goal_id TEXT NOT NULL,
  base_plan_revision_id TEXT NOT NULL,
  base_plan_revision_sha256 TEXT NOT NULL CHECK(length(base_plan_revision_sha256)=64),
  subject_kind TEXT NOT NULL CHECK(subject_kind IN ('REQUIREMENT','DECISION','WORK_CELL')),
  subject_id TEXT NOT NULL CHECK(length(subject_id) BETWEEN 1 AND 160),
  revision_sha256 TEXT NOT NULL CHECK(length(revision_sha256)=64),
  reuse_scope TEXT NOT NULL CHECK(reuse_scope='PLAN_SUBJECT_ONLY'),
  requires_fresh_effect_oracle INTEGER NOT NULL CHECK(requires_fresh_effect_oracle=1),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  FOREIGN KEY(plan_change_impact_id,change_request_id,goal_id,base_plan_revision_id)
    REFERENCES plan_change_impacts_v2(plan_change_impact_id,change_request_id,goal_id,base_plan_revision_id),
  FOREIGN KEY(base_plan_revision_id,subject_kind,subject_id,goal_id)
    REFERENCES plan_subjects_v2(plan_revision_id,subject_kind,subject_id,goal_id),
  UNIQUE(plan_change_impact_id,subject_kind,subject_id)
) STRICT;

CREATE TRIGGER validate_plan_reuse_receipt_v2
BEFORE INSERT ON plan_reuse_receipts_v2
WHEN NOT EXISTS (
  SELECT 1 FROM plan_change_impacts_v2 i
  JOIN plan_change_impact_members_v2 m ON m.plan_change_impact_id=i.plan_change_impact_id
  WHERE i.plan_change_impact_id=NEW.plan_change_impact_id AND i.record_sha256=NEW.plan_change_impact_sha256
    AND m.disposition='REUSABLE' AND m.subject_kind=NEW.subject_kind AND m.subject_id=NEW.subject_id
    AND m.revision_sha256=NEW.revision_sha256
)
BEGIN SELECT RAISE(ABORT,'Plan reuse receipt V2 is outside the exact reusable closure'); END;

CREATE INDEX ix_change_requests_v2_goal ON change_requests_v2(goal_id,created_event_sequence);
CREATE INDEX ix_plan_change_impact_members_v2_disposition
  ON plan_change_impact_members_v2(plan_change_impact_id,disposition,ordinal);
CREATE INDEX ix_plan_reuse_receipts_v2_subject
  ON plan_reuse_receipts_v2(base_plan_revision_id,subject_kind,subject_id);

CREATE TRIGGER no_update_change_requests_v2 BEFORE UPDATE ON change_requests_v2
BEGIN SELECT RAISE(ABORT,'Change Request V2 records are immutable'); END;
CREATE TRIGGER no_delete_change_requests_v2 BEFORE DELETE ON change_requests_v2
BEGIN SELECT RAISE(ABORT,'Change Request V2 records are immutable'); END;
CREATE TRIGGER no_update_change_request_subjects_v2 BEFORE UPDATE ON change_request_subjects_v2
BEGIN SELECT RAISE(ABORT,'Change Request V2 subjects are immutable'); END;
CREATE TRIGGER no_delete_change_request_subjects_v2 BEFORE DELETE ON change_request_subjects_v2
BEGIN SELECT RAISE(ABORT,'Change Request V2 subjects are immutable'); END;
CREATE TRIGGER no_update_plan_change_impacts_v2 BEFORE UPDATE ON plan_change_impacts_v2
BEGIN SELECT RAISE(ABORT,'Plan change impact V2 records are immutable'); END;
CREATE TRIGGER no_delete_plan_change_impacts_v2 BEFORE DELETE ON plan_change_impacts_v2
BEGIN SELECT RAISE(ABORT,'Plan change impact V2 records are immutable'); END;
CREATE TRIGGER no_update_plan_change_impact_members_v2 BEFORE UPDATE ON plan_change_impact_members_v2
BEGIN SELECT RAISE(ABORT,'Plan change impact V2 members are immutable'); END;
CREATE TRIGGER no_delete_plan_change_impact_members_v2 BEFORE DELETE ON plan_change_impact_members_v2
BEGIN SELECT RAISE(ABORT,'Plan change impact V2 members are immutable'); END;
CREATE TRIGGER no_update_plan_invalidation_edges_v2 BEFORE UPDATE ON plan_invalidation_edges_v2
BEGIN SELECT RAISE(ABORT,'Plan invalidation edges V2 are immutable'); END;
CREATE TRIGGER no_delete_plan_invalidation_edges_v2 BEFORE DELETE ON plan_invalidation_edges_v2
BEGIN SELECT RAISE(ABORT,'Plan invalidation edges V2 are immutable'); END;
CREATE TRIGGER no_update_plan_reuse_receipts_v2 BEFORE UPDATE ON plan_reuse_receipts_v2
BEGIN SELECT RAISE(ABORT,'Plan reuse receipts V2 are immutable'); END;
CREATE TRIGGER no_delete_plan_reuse_receipts_v2 BEFORE DELETE ON plan_reuse_receipts_v2
BEGIN SELECT RAISE(ABORT,'Plan reuse receipts V2 are immutable'); END;

CREATE TABLE correction_budgets_v2 (
  correction_budget_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  origin_plan_revision_id TEXT NOT NULL,
  origin_plan_revision_sha256 TEXT NOT NULL CHECK(length(origin_plan_revision_sha256)=64),
  family TEXT NOT NULL CHECK(family IN (
    'LOCAL_REPAIR','REPLAN','ASK_USER','RECONCILE','WORKER_RETRY','HANDOFF','PROVIDER_FANOUT'
  )),
  maximum_attempts INTEGER NOT NULL CHECK(maximum_attempts BETWEEN 1 AND 8),
  maximum_no_progress INTEGER NOT NULL CHECK(maximum_no_progress BETWEEN 1 AND 3 AND maximum_no_progress<=maximum_attempts),
  policy_source_sha256 TEXT NOT NULL CHECK(length(policy_source_sha256)=64),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  FOREIGN KEY(origin_plan_revision_id,goal_id)
    REFERENCES plan_revisions_v2(plan_revision_id,goal_id),
  UNIQUE(goal_id,family),
  UNIQUE(correction_budget_id,goal_id,family)
) STRICT;

CREATE TABLE correction_attempts_v2 (
  correction_attempt_id TEXT PRIMARY KEY,
  correction_budget_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  current_plan_revision_id TEXT NOT NULL,
  current_plan_revision_sha256 TEXT NOT NULL CHECK(length(current_plan_revision_sha256)=64),
  family TEXT NOT NULL CHECK(family IN (
    'LOCAL_REPAIR','REPLAN','ASK_USER','RECONCILE','WORKER_RETRY','HANDOFF','PROVIDER_FANOUT'
  )),
  attempt_number INTEGER NOT NULL CHECK(attempt_number BETWEEN 1 AND 8),
  parent_attempt_id TEXT REFERENCES correction_attempts_v2(correction_attempt_id),
  parent_attempt_sha256 TEXT CHECK(parent_attempt_sha256 IS NULL OR length(parent_attempt_sha256)=64),
  observation_event_sequence INTEGER NOT NULL CHECK(observation_event_sequence>=1),
  observation_event_sha256 TEXT NOT NULL CHECK(length(observation_event_sha256)=64),
  observation_signature_sha256 TEXT NOT NULL CHECK(length(observation_signature_sha256)=64),
  progress_changed INTEGER NOT NULL CHECK(progress_changed IN (0,1)),
  no_progress_streak INTEGER NOT NULL CHECK(no_progress_streak BETWEEN 0 AND 8),
  result TEXT NOT NULL CHECK(result IN ('CONTINUE','SUCCEEDED','FAILED')),
  stop_action TEXT NOT NULL CHECK(stop_action IN ('CONTINUE','SUCCEEDED','REPLAN','ASK_USER','RECONCILE','STOP')),
  stop_reason TEXT NOT NULL CHECK(stop_reason IN (
    'NONE','SUCCEEDED','ATTEMPT_BUDGET_EXHAUSTED','NO_PROGRESS_BUDGET_EXHAUSTED'
  )),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  CHECK((attempt_number=1 AND parent_attempt_id IS NULL AND parent_attempt_sha256 IS NULL)
    OR (attempt_number>1 AND parent_attempt_id IS NOT NULL AND parent_attempt_sha256 IS NOT NULL)),
  FOREIGN KEY(correction_budget_id,goal_id,family)
    REFERENCES correction_budgets_v2(correction_budget_id,goal_id,family),
  FOREIGN KEY(current_plan_revision_id,goal_id)
    REFERENCES plan_revisions_v2(plan_revision_id,goal_id),
  FOREIGN KEY(goal_id,observation_event_sequence)
    REFERENCES events(goal_id,sequence),
  UNIQUE(correction_budget_id,attempt_number),
  UNIQUE(correction_attempt_id,correction_budget_id,goal_id,family)
) STRICT;

CREATE TRIGGER validate_correction_attempt_parent_v2
BEFORE INSERT ON correction_attempts_v2
WHEN NEW.parent_attempt_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM correction_attempts_v2 p
  WHERE p.correction_attempt_id=NEW.parent_attempt_id
    AND p.correction_budget_id=NEW.correction_budget_id
    AND p.attempt_number=NEW.attempt_number-1
    AND p.record_sha256=NEW.parent_attempt_sha256
    AND p.stop_action='CONTINUE'
)
BEGIN SELECT RAISE(ABORT,'Correction attempt V2 predecessor mismatch or budget already stopped'); END;

CREATE TABLE correction_budget_heads_v2 (
  correction_budget_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  family TEXT NOT NULL,
  latest_attempt_id TEXT,
  latest_attempt_sha256 TEXT CHECK(latest_attempt_sha256 IS NULL OR length(latest_attempt_sha256)=64),
  attempt_count INTEGER NOT NULL CHECK(attempt_count BETWEEN 0 AND 8),
  no_progress_streak INTEGER NOT NULL CHECK(no_progress_streak BETWEEN 0 AND 8),
  stop_action TEXT NOT NULL CHECK(stop_action IN ('CONTINUE','SUCCEEDED','REPLAN','ASK_USER','RECONCILE','STOP')),
  updated_event_sequence INTEGER NOT NULL CHECK(updated_event_sequence>=1),
  CHECK((attempt_count=0 AND latest_attempt_id IS NULL AND latest_attempt_sha256 IS NULL)
    OR (attempt_count>0 AND latest_attempt_id IS NOT NULL AND latest_attempt_sha256 IS NOT NULL)),
  FOREIGN KEY(correction_budget_id,goal_id,family)
    REFERENCES correction_budgets_v2(correction_budget_id,goal_id,family),
  FOREIGN KEY(latest_attempt_id,correction_budget_id,goal_id,family)
    REFERENCES correction_attempts_v2(correction_attempt_id,correction_budget_id,goal_id,family),
  UNIQUE(goal_id,family)
) STRICT;

CREATE INDEX ix_correction_attempts_v2_goal ON correction_attempts_v2(goal_id,family,attempt_number);
CREATE TRIGGER no_update_correction_budgets_v2 BEFORE UPDATE ON correction_budgets_v2
BEGIN SELECT RAISE(ABORT,'Correction budgets V2 are immutable'); END;
CREATE TRIGGER no_delete_correction_budgets_v2 BEFORE DELETE ON correction_budgets_v2
BEGIN SELECT RAISE(ABORT,'Correction budgets V2 are immutable'); END;
CREATE TRIGGER no_update_correction_attempts_v2 BEFORE UPDATE ON correction_attempts_v2
BEGIN SELECT RAISE(ABORT,'Correction attempts V2 are immutable'); END;
CREATE TRIGGER no_delete_correction_attempts_v2 BEFORE DELETE ON correction_attempts_v2
BEGIN SELECT RAISE(ABORT,'Correction attempts V2 are immutable'); END;
