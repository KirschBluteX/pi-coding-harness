-- Active Goal input is captured before semantic classification. The immutable
-- raw turn is the source authority; later Agent output is only a typed proposal.

CREATE TABLE active_goal_user_turns_v2 (
  user_turn_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  goal_version INTEGER NOT NULL CHECK(goal_version>=1),
  contract_sha256 TEXT CHECK(contract_sha256 IS NULL OR length(contract_sha256)=64),
  route_sha256 TEXT CHECK(route_sha256 IS NULL OR length(route_sha256)=64),
  plan_revision_id TEXT,
  plan_revision_sha256 TEXT CHECK(plan_revision_sha256 IS NULL OR length(plan_revision_sha256)=64),
  stage_gate_sha256 TEXT CHECK(stage_gate_sha256 IS NULL OR length(stage_gate_sha256)=64),
  execution_authorization_sha256 TEXT CHECK(execution_authorization_sha256 IS NULL OR length(execution_authorization_sha256)=64),
  input_closure_sha256 TEXT NOT NULL CHECK(length(input_closure_sha256)=64),
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
  CHECK((plan_revision_id IS NULL AND plan_revision_sha256 IS NULL)
    OR (plan_revision_id IS NOT NULL AND plan_revision_sha256 IS NOT NULL)),
  FOREIGN KEY(goal_id,created_event_sequence) REFERENCES events(goal_id,sequence)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(plan_revision_id,goal_id) REFERENCES plan_revisions_v2(plan_revision_id,goal_id),
  UNIQUE(goal_id,session_id,turn_id),
  UNIQUE(user_turn_id,goal_id)
) STRICT;

CREATE INDEX ix_active_goal_user_turns_v2_pending
  ON active_goal_user_turns_v2(goal_id,created_event_sequence);

CREATE TRIGGER no_update_active_goal_user_turns_v2 BEFORE UPDATE ON active_goal_user_turns_v2
BEGIN SELECT RAISE(ABORT,'Active Goal user turns V2 are immutable'); END;
CREATE TRIGGER no_delete_active_goal_user_turns_v2 BEFORE DELETE ON active_goal_user_turns_v2
BEGIN SELECT RAISE(ABORT,'Active Goal user turns V2 are immutable'); END;

CREATE TABLE active_goal_user_turn_classifications_v2 (
  classification_id TEXT PRIMARY KEY,
  user_turn_id TEXT NOT NULL UNIQUE,
  user_turn_sha256 TEXT NOT NULL CHECK(length(user_turn_sha256)=64),
  goal_id TEXT NOT NULL,
  base_plan_revision_id TEXT,
  base_plan_revision_sha256 TEXT CHECK(base_plan_revision_sha256 IS NULL OR length(base_plan_revision_sha256)=64),
  classification TEXT NOT NULL CHECK(classification IN (
    'CORRECT_CURRENT','QUEUE_NEXT','CHANGE_REQUEST','NEW_GOAL','INTERRUPT_NOW','DISCUSSION_ONLY'
  )),
  materiality TEXT NOT NULL CHECK(materiality IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  change_kind TEXT CHECK(change_kind IS NULL OR change_kind IN ('BEHAVIOR','SCOPE','ACCEPTANCE','USER_PREFERENCE')),
  changed_subject_root_sha256 TEXT NOT NULL CHECK(length(changed_subject_root_sha256)=64),
  changed_subject_count INTEGER NOT NULL CHECK(changed_subject_count BETWEEN 0 AND 512),
  proposal_origin TEXT NOT NULL CHECK(proposal_origin='CURRENT_AGENT_TURN'),
  event_head_sha256 TEXT NOT NULL CHECK(length(event_head_sha256)=64),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  CHECK((base_plan_revision_id IS NULL AND base_plan_revision_sha256 IS NULL)
    OR (base_plan_revision_id IS NOT NULL AND base_plan_revision_sha256 IS NOT NULL)),
  CHECK((classification IN ('CORRECT_CURRENT','CHANGE_REQUEST','INTERRUPT_NOW')
      AND change_kind IS NOT NULL AND changed_subject_count>0)
    OR (classification IN ('QUEUE_NEXT','NEW_GOAL','DISCUSSION_ONLY')
      AND change_kind IS NULL AND changed_subject_count=0)),
  FOREIGN KEY(user_turn_id,goal_id) REFERENCES active_goal_user_turns_v2(user_turn_id,goal_id),
  FOREIGN KEY(base_plan_revision_id,goal_id) REFERENCES plan_revisions_v2(plan_revision_id,goal_id),
  FOREIGN KEY(goal_id,created_event_sequence) REFERENCES events(goal_id,sequence)
    DEFERRABLE INITIALLY DEFERRED,
  UNIQUE(classification_id,goal_id,base_plan_revision_id)
) STRICT;

CREATE TABLE active_goal_classification_subjects_v2 (
  classification_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  base_plan_revision_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK(subject_kind IN ('REQUIREMENT','DECISION','WORK_CELL')),
  subject_id TEXT NOT NULL CHECK(length(subject_id) BETWEEN 1 AND 160),
  revision_sha256 TEXT NOT NULL CHECK(length(revision_sha256)=64),
  ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 511),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  PRIMARY KEY(classification_id,subject_kind,subject_id),
  UNIQUE(classification_id,ordinal),
  FOREIGN KEY(classification_id,goal_id,base_plan_revision_id)
    REFERENCES active_goal_user_turn_classifications_v2(classification_id,goal_id,base_plan_revision_id),
  FOREIGN KEY(base_plan_revision_id,subject_kind,subject_id,goal_id)
    REFERENCES plan_subjects_v2(plan_revision_id,subject_kind,subject_id,goal_id)
) WITHOUT ROWID, STRICT;

CREATE INDEX ix_active_goal_input_classifications_v2_goal
  ON active_goal_user_turn_classifications_v2(goal_id,created_event_sequence);

CREATE TRIGGER no_update_active_goal_user_turn_classifications_v2
BEFORE UPDATE ON active_goal_user_turn_classifications_v2
BEGIN SELECT RAISE(ABORT,'Active Goal input classifications V2 are immutable'); END;
CREATE TRIGGER no_delete_active_goal_user_turn_classifications_v2
BEFORE DELETE ON active_goal_user_turn_classifications_v2
BEGIN SELECT RAISE(ABORT,'Active Goal input classifications V2 are immutable'); END;
CREATE TRIGGER no_update_active_goal_classification_subjects_v2
BEFORE UPDATE ON active_goal_classification_subjects_v2
BEGIN SELECT RAISE(ABORT,'Active Goal input classification subjects V2 are immutable'); END;
CREATE TRIGGER no_delete_active_goal_classification_subjects_v2
BEFORE DELETE ON active_goal_classification_subjects_v2
BEGIN SELECT RAISE(ABORT,'Active Goal input classification subjects V2 are immutable'); END;

CREATE TABLE active_goal_change_request_bindings_v2 (
  binding_id TEXT PRIMARY KEY,
  classification_id TEXT NOT NULL UNIQUE,
  classification_sha256 TEXT NOT NULL CHECK(length(classification_sha256)=64),
  user_turn_id TEXT NOT NULL UNIQUE,
  user_turn_sha256 TEXT NOT NULL CHECK(length(user_turn_sha256)=64),
  raw_content_sha256 TEXT NOT NULL CHECK(length(raw_content_sha256)=64),
  change_request_id TEXT NOT NULL UNIQUE,
  change_request_sha256 TEXT NOT NULL CHECK(length(change_request_sha256)=64),
  plan_change_impact_id TEXT NOT NULL UNIQUE,
  plan_change_impact_sha256 TEXT NOT NULL CHECK(length(plan_change_impact_sha256)=64),
  goal_id TEXT NOT NULL,
  base_plan_revision_id TEXT NOT NULL,
  base_plan_revision_sha256 TEXT NOT NULL CHECK(length(base_plan_revision_sha256)=64),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  FOREIGN KEY(classification_id,goal_id,base_plan_revision_id)
    REFERENCES active_goal_user_turn_classifications_v2(classification_id,goal_id,base_plan_revision_id),
  FOREIGN KEY(user_turn_id,goal_id) REFERENCES active_goal_user_turns_v2(user_turn_id,goal_id),
  FOREIGN KEY(change_request_id,goal_id,base_plan_revision_id)
    REFERENCES change_requests_v2(change_request_id,goal_id,base_plan_revision_id),
  FOREIGN KEY(plan_change_impact_id,change_request_id,goal_id,base_plan_revision_id)
    REFERENCES plan_change_impacts_v2(plan_change_impact_id,change_request_id,goal_id,base_plan_revision_id),
  FOREIGN KEY(goal_id,created_event_sequence) REFERENCES events(goal_id,sequence)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE INDEX ix_active_goal_change_request_bindings_v2_goal
  ON active_goal_change_request_bindings_v2(goal_id,created_event_sequence);
CREATE TRIGGER no_update_active_goal_change_request_bindings_v2
BEFORE UPDATE ON active_goal_change_request_bindings_v2
BEGIN SELECT RAISE(ABORT,'Active Goal ChangeRequest bindings V2 are immutable'); END;
CREATE TRIGGER no_delete_active_goal_change_request_bindings_v2
BEFORE DELETE ON active_goal_change_request_bindings_v2
BEGIN SELECT RAISE(ABORT,'Active Goal ChangeRequest bindings V2 are immutable'); END;

CREATE TABLE active_goal_change_transitions_v2 (
  transition_id TEXT PRIMARY KEY,
  binding_id TEXT NOT NULL UNIQUE,
  binding_sha256 TEXT NOT NULL CHECK(length(binding_sha256)=64),
  classification_id TEXT NOT NULL UNIQUE,
  change_request_id TEXT NOT NULL UNIQUE,
  plan_change_impact_id TEXT NOT NULL UNIQUE,
  goal_id TEXT NOT NULL,
  base_plan_revision_id TEXT NOT NULL,
  base_plan_revision_sha256 TEXT NOT NULL CHECK(length(base_plan_revision_sha256)=64),
  successor_plan_revision_id TEXT NOT NULL,
  successor_plan_revision_sha256 TEXT NOT NULL CHECK(length(successor_plan_revision_sha256)=64),
  successor_stage_gate_receipt_id TEXT NOT NULL,
  successor_stage_gate_sha256 TEXT NOT NULL CHECK(length(successor_stage_gate_sha256)=64),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  CHECK(base_plan_revision_id<>successor_plan_revision_id),
  FOREIGN KEY(binding_id) REFERENCES active_goal_change_request_bindings_v2(binding_id),
  FOREIGN KEY(successor_plan_revision_id,goal_id)
    REFERENCES plan_revisions_v2(plan_revision_id,goal_id),
  FOREIGN KEY(successor_stage_gate_receipt_id)
    REFERENCES stage_gate_receipts_v2(stage_gate_receipt_id),
  FOREIGN KEY(goal_id,created_event_sequence) REFERENCES events(goal_id,sequence)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE INDEX ix_active_goal_change_transitions_v2_goal
  ON active_goal_change_transitions_v2(goal_id,created_event_sequence);
CREATE TRIGGER no_update_active_goal_change_transitions_v2
BEFORE UPDATE ON active_goal_change_transitions_v2
BEGIN SELECT RAISE(ABORT,'Active Goal change transitions V2 are immutable'); END;
CREATE TRIGGER no_delete_active_goal_change_transitions_v2
BEFORE DELETE ON active_goal_change_transitions_v2
BEGIN SELECT RAISE(ABORT,'Active Goal change transitions V2 are immutable'); END;
