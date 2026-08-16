-- Durable Pi session-to-Goal control binding and per-runtime lease ownership.

ALTER TABLE execution_leases
  ADD COLUMN owner_instance_id TEXT
  CHECK(owner_instance_id IS NULL OR length(owner_instance_id) BETWEEN 1 AND 256);
ALTER TABLE execution_leases
  ADD COLUMN released_at_ms INTEGER
  CHECK(released_at_ms IS NULL OR released_at_ms>=0);

CREATE TABLE goal_session_binding_revisions_v1 (
  binding_id TEXT NOT NULL UNIQUE CHECK(length(binding_id) BETWEEN 1 AND 256),
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  revision INTEGER NOT NULL CHECK(revision>=1),
  session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 1 AND 256),
  state TEXT NOT NULL CHECK(state IN ('BOUND','UNBOUND','TERMINAL')),
  auto_resume INTEGER NOT NULL CHECK(auto_resume IN (0,1)),
  goal_title TEXT NOT NULL CHECK(length(goal_title) BETWEEN 1 AND 128),
  reason_code TEXT NOT NULL CHECK(reason_code IN (
    'EXPLICIT_ENTRY','AUTO_RESUME','TRANSFER','TITLE_EDIT','EXIT','GOAL_TERMINAL'
  )),
  predecessor_receipt_sha256 TEXT
    CHECK(predecessor_receipt_sha256 IS NULL OR length(predecessor_receipt_sha256)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  receipt_sha256 TEXT NOT NULL UNIQUE CHECK(length(receipt_sha256)=64),
  PRIMARY KEY(goal_id,revision),
  UNIQUE(goal_id,receipt_sha256),
  UNIQUE(goal_id,revision,binding_id,receipt_sha256),
  FOREIGN KEY(goal_id,predecessor_receipt_sha256)
    REFERENCES goal_session_binding_revisions_v1(goal_id,receipt_sha256),
  CHECK((state='BOUND' AND auto_resume=1) OR (state<>'BOUND' AND auto_resume=0))
) STRICT;

CREATE TABLE goal_session_binding_heads_v1 (
  goal_id TEXT PRIMARY KEY REFERENCES goals(goal_id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  revision INTEGER NOT NULL CHECK(revision>=1),
  binding_id TEXT NOT NULL UNIQUE CHECK(length(binding_id) BETWEEN 1 AND 256),
  session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 1 AND 256),
  state TEXT NOT NULL CHECK(state IN ('BOUND','UNBOUND','TERMINAL')),
  auto_resume INTEGER NOT NULL CHECK(auto_resume IN (0,1)),
  goal_title TEXT NOT NULL CHECK(length(goal_title) BETWEEN 1 AND 128),
  binding_receipt_sha256 TEXT NOT NULL UNIQUE CHECK(length(binding_receipt_sha256)=64),
  row_version INTEGER NOT NULL CHECK(row_version>=1),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms>=0),
  FOREIGN KEY(goal_id,revision,binding_id,binding_receipt_sha256)
    REFERENCES goal_session_binding_revisions_v1(goal_id,revision,binding_id,receipt_sha256),
  CHECK((state='BOUND' AND auto_resume=1) OR (state<>'BOUND' AND auto_resume=0))
) STRICT;

CREATE UNIQUE INDEX ux_goal_session_binding_active_session_v1
  ON goal_session_binding_heads_v1(workspace_id,session_id)
  WHERE state='BOUND';
CREATE INDEX ix_goal_session_binding_workspace_v1
  ON goal_session_binding_heads_v1(workspace_id,state,updated_at_ms DESC,goal_id);

CREATE TRIGGER validate_goal_session_binding_revision_v1
BEFORE INSERT ON goal_session_binding_revisions_v1
WHEN NOT EXISTS (
  SELECT 1 FROM goals g
  WHERE g.goal_id=NEW.goal_id AND g.workspace_id=NEW.workspace_id
) OR (
  NEW.revision=1 AND NEW.predecessor_receipt_sha256 IS NOT NULL
) OR (
  NEW.revision>1 AND NOT EXISTS (
    SELECT 1 FROM goal_session_binding_revisions_v1 prior
    WHERE prior.goal_id=NEW.goal_id AND prior.revision=NEW.revision-1
      AND prior.receipt_sha256=NEW.predecessor_receipt_sha256
  )
)
BEGIN SELECT RAISE(ABORT,'Goal session binding revision is not sequential or workspace-bound'); END;

CREATE TRIGGER validate_goal_session_binding_head_insert_v1
BEFORE INSERT ON goal_session_binding_heads_v1
WHEN NEW.revision<>1 OR NEW.row_version<>1 OR NOT EXISTS (
  SELECT 1 FROM goal_session_binding_revisions_v1 revision
  WHERE revision.goal_id=NEW.goal_id AND revision.workspace_id=NEW.workspace_id
    AND revision.revision=NEW.revision AND revision.binding_id=NEW.binding_id
    AND revision.session_id=NEW.session_id AND revision.state=NEW.state
    AND revision.auto_resume=NEW.auto_resume AND revision.goal_title=NEW.goal_title
    AND revision.receipt_sha256=NEW.binding_receipt_sha256
)
BEGIN SELECT RAISE(ABORT,'Initial Goal session binding head is invalid'); END;

CREATE TRIGGER validate_goal_session_binding_head_update_v1
BEFORE UPDATE ON goal_session_binding_heads_v1
WHEN NEW.goal_id<>OLD.goal_id OR NEW.workspace_id<>OLD.workspace_id
  OR NEW.revision<>OLD.revision+1 OR NEW.row_version<>OLD.row_version+1
  OR NOT EXISTS (
    SELECT 1 FROM goal_session_binding_revisions_v1 revision
    WHERE revision.goal_id=NEW.goal_id AND revision.workspace_id=NEW.workspace_id
      AND revision.revision=NEW.revision AND revision.binding_id=NEW.binding_id
      AND revision.session_id=NEW.session_id AND revision.state=NEW.state
      AND revision.auto_resume=NEW.auto_resume AND revision.goal_title=NEW.goal_title
      AND revision.predecessor_receipt_sha256=OLD.binding_receipt_sha256
      AND revision.receipt_sha256=NEW.binding_receipt_sha256
  )
BEGIN SELECT RAISE(ABORT,'Goal session binding head CAS is invalid'); END;

CREATE TRIGGER no_update_goal_session_binding_revisions_v1
BEFORE UPDATE ON goal_session_binding_revisions_v1
BEGIN SELECT RAISE(ABORT,'Goal session binding revisions are immutable'); END;
CREATE TRIGGER no_delete_goal_session_binding_revisions_v1
BEFORE DELETE ON goal_session_binding_revisions_v1
BEGIN SELECT RAISE(ABORT,'Goal session binding revisions cannot be deleted'); END;
CREATE TRIGGER no_delete_goal_session_binding_heads_v1
BEFORE DELETE ON goal_session_binding_heads_v1
BEGIN SELECT RAISE(ABORT,'Goal session binding heads cannot be deleted'); END;
