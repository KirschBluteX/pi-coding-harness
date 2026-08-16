CREATE TABLE dynamic_multi_proposal_receipts_v2 (
  dynamic_multi_proposal_receipt_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  run_id TEXT NOT NULL REFERENCES managed_runs_v1(run_id),
  work_cell_id TEXT NOT NULL REFERENCES work_cells_v1(work_cell_id),
  plan_revision_id TEXT NOT NULL,
  plan_revision_sha256 TEXT NOT NULL CHECK(length(plan_revision_sha256)=64),
  authorization_id TEXT NOT NULL REFERENCES execution_authorizations_v1(authorization_id),
  authorization_sha256 TEXT NOT NULL CHECK(length(authorization_sha256)=64),
  input_closure_sha256 TEXT NOT NULL CHECK(length(input_closure_sha256)=64),
  baseline_sha256 TEXT NOT NULL CHECK(length(baseline_sha256)=64),
  baseline_content_root_sha256 TEXT NOT NULL CHECK(length(baseline_content_root_sha256)=64),
  environment_sha256 TEXT NOT NULL CHECK(length(environment_sha256)=64),
  runtime_fingerprint_sha256 TEXT NOT NULL CHECK(length(runtime_fingerprint_sha256)=64),
  config_sha256 TEXT NOT NULL CHECK(length(config_sha256)=64),
  graph_proposal_sha256 TEXT NOT NULL CHECK(length(graph_proposal_sha256)=64),
  source_json TEXT NOT NULL CHECK(
    json_valid(source_json) AND json_type(source_json)='array'
    AND json_array_length(source_json) BETWEEN 2 AND 32 AND length(source_json)<=1048576
  ),
  source_root_sha256 TEXT NOT NULL CHECK(length(source_root_sha256)=64),
  predecessor_authority_head_sha256 TEXT NOT NULL CHECK(length(predecessor_authority_head_sha256)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  FOREIGN KEY(plan_revision_id,goal_id) REFERENCES plan_revisions_v2(plan_revision_id,goal_id),
  UNIQUE(run_id,work_cell_id,authorization_sha256),
  UNIQUE(dynamic_multi_proposal_receipt_id,goal_id,run_id,work_cell_id,record_sha256)
) STRICT;

CREATE TRIGGER validate_dynamic_multi_proposal_receipt_v2
BEFORE INSERT ON dynamic_multi_proposal_receipts_v2
WHEN NOT EXISTS (
  SELECT 1
  FROM managed_run_heads_v1 head
  JOIN topology_revisions_v1 topology
    ON topology.run_id=head.run_id AND topology.revision=head.topology_revision
  JOIN managed_runs_v1 run ON run.run_id=head.run_id
  JOIN plan_revisions_v2 plan ON plan.plan_revision_id=NEW.plan_revision_id
  JOIN work_cells_v1 cell ON cell.work_cell_id=NEW.work_cell_id
  JOIN work_cell_heads_v1 cell_head ON cell_head.work_cell_id=cell.work_cell_id
  JOIN plan_subjects_v2 subject ON subject.plan_revision_id=plan.plan_revision_id
    AND subject.subject_kind='WORK_CELL' AND subject.subject_id=cell.logical_key
    AND subject.revision_sha256=cell.spec_sha256
  JOIN execution_authorizations_v1 authorization ON authorization.authorization_id=NEW.authorization_id
  JOIN workspace_baselines_v1 baseline ON baseline.baseline_id=authorization.baseline_id
  JOIN events event ON event.goal_id=NEW.goal_id
    AND event.event_sha256=NEW.predecessor_authority_head_sha256
  WHERE head.run_id=NEW.run_id AND head.status='ACTIVE' AND head.requested_topology='MULTI'
    AND run.goal_id=NEW.goal_id
    AND topology.config_sha256=NEW.config_sha256
    AND plan.goal_id=NEW.goal_id AND plan.record_sha256=NEW.plan_revision_sha256
    AND plan.input_closure_sha256=NEW.input_closure_sha256
    AND cell.goal_id=NEW.goal_id AND cell_head.status='RUNNING'
    AND authorization.goal_id=NEW.goal_id AND authorization.work_cell_id=NEW.work_cell_id
    AND authorization.record_sha256=NEW.authorization_sha256 AND authorization.revoked_at_ms IS NULL
    AND authorization.expires_at_ms>=NEW.created_at_ms
    AND baseline.record_sha256=NEW.baseline_sha256
    AND baseline.content_root_sha256=NEW.baseline_content_root_sha256
    AND baseline.environment_sha256=NEW.environment_sha256
    AND event.sequence=NEW.created_event_sequence-1
)
BEGIN SELECT RAISE(ABORT,'Dynamic Multi proposal authority closure mismatch'); END;

CREATE INDEX ix_dynamic_multi_proposal_current_v2
  ON dynamic_multi_proposal_receipts_v2(run_id,work_cell_id,created_event_sequence DESC);

CREATE TRIGGER no_update_dynamic_multi_proposal_receipts_v2
BEFORE UPDATE ON dynamic_multi_proposal_receipts_v2
BEGIN SELECT RAISE(ABORT,'Dynamic Multi proposal receipts V2 are immutable'); END;
CREATE TRIGGER no_delete_dynamic_multi_proposal_receipts_v2
BEFORE DELETE ON dynamic_multi_proposal_receipts_v2
BEGIN SELECT RAISE(ABORT,'Dynamic Multi proposal receipts V2 are immutable'); END;
