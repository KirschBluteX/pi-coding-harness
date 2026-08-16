-- Strong Single execution provenance remains in schema 033. These records
-- separately prove that a prior execution and the current admission workload
-- are semantically and operationally comparable across entity identities.

CREATE TABLE strong_single_workload_bindings_v1 (
  strong_single_workload_binding_id TEXT PRIMARY KEY,
  source_goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  source_run_id TEXT NOT NULL REFERENCES managed_runs_v1(run_id),
  source_work_cell_id TEXT NOT NULL REFERENCES work_cells_v1(work_cell_id),
  source_rollout_receipt_id TEXT NOT NULL,
  source_rollout_receipt_sha256 TEXT NOT NULL CHECK(length(source_rollout_receipt_sha256)=64),
  source_topology_revision INTEGER NOT NULL CHECK(source_topology_revision>=1),
  source_topology_revision_sha256 TEXT NOT NULL CHECK(length(source_topology_revision_sha256)=64),
  work_cell_semantics_sha256 TEXT NOT NULL CHECK(length(work_cell_semantics_sha256)=64),
  requirement_content_root_sha256 TEXT NOT NULL CHECK(length(requirement_content_root_sha256)=64),
  obligation_content_root_sha256 TEXT NOT NULL CHECK(length(obligation_content_root_sha256)=64),
  decision_content_root_sha256 TEXT NOT NULL CHECK(length(decision_content_root_sha256)=64),
  oracle_set_sha256 TEXT NOT NULL CHECK(length(oracle_set_sha256)=64),
  scope_sha256 TEXT NOT NULL CHECK(length(scope_sha256)=64),
  effect_policy_sha256 TEXT NOT NULL CHECK(length(effect_policy_sha256)=64),
  input_content_root_sha256 TEXT NOT NULL CHECK(length(input_content_root_sha256)=64),
  environment_sha256 TEXT NOT NULL CHECK(length(environment_sha256)=64),
  runtime_fingerprint_sha256 TEXT NOT NULL CHECK(length(runtime_fingerprint_sha256)=64),
  comparison_config_sha256 TEXT NOT NULL CHECK(length(comparison_config_sha256)=64),
  provider_profile_sha256 TEXT NOT NULL CHECK(length(provider_profile_sha256)=64),
  cache_epoch_sha256 TEXT NOT NULL CHECK(length(cache_epoch_sha256)=64),
  workload_key_sha256 TEXT NOT NULL CHECK(length(workload_key_sha256)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  FOREIGN KEY(source_rollout_receipt_id,source_goal_id,source_run_id,source_work_cell_id,source_rollout_receipt_sha256)
    REFERENCES strong_single_rollout_receipts_v1(rollout_receipt_id,goal_id,run_id,work_cell_id,record_sha256),
  FOREIGN KEY(source_run_id,source_topology_revision)
    REFERENCES topology_revisions_v1(run_id,revision),
  UNIQUE(source_rollout_receipt_id),
  UNIQUE(strong_single_workload_binding_id,record_sha256)
) STRICT;

CREATE TRIGGER validate_strong_single_workload_binding_v1
BEFORE INSERT ON strong_single_workload_bindings_v1
WHEN NOT EXISTS (
  SELECT 1
  FROM strong_single_rollout_receipts_v1 rollout
  JOIN topology_revisions_v1 topology
    ON topology.run_id=rollout.run_id AND topology.revision=rollout.topology_revision
  WHERE rollout.rollout_receipt_id=NEW.source_rollout_receipt_id
    AND rollout.goal_id=NEW.source_goal_id AND rollout.run_id=NEW.source_run_id
    AND rollout.work_cell_id=NEW.source_work_cell_id
    AND rollout.record_sha256=NEW.source_rollout_receipt_sha256
    AND rollout.topology_revision=NEW.source_topology_revision
    AND rollout.topology_revision_sha256=NEW.source_topology_revision_sha256
    AND rollout.correctness='PASS' AND rollout.quality_basis_points=10000
    AND rollout.provider_accounting_completeness='COMPLETE'
    AND topology.effective_topology='SINGLE'
    AND topology.record_sha256=NEW.source_topology_revision_sha256
    AND topology.config_sha256=rollout.config_sha256
    AND rollout.completed_at_ms=NEW.created_at_ms
    AND rollout.created_event_sequence<=NEW.created_event_sequence
)
BEGIN SELECT RAISE(ABORT,'Strong Single workload binding provenance mismatch'); END;

CREATE TABLE workload_comparability_receipts_v1 (
  workload_comparability_receipt_id TEXT PRIMARY KEY,
  target_goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  target_run_id TEXT NOT NULL REFERENCES managed_runs_v1(run_id),
  target_work_cell_id TEXT NOT NULL REFERENCES work_cells_v1(work_cell_id),
  target_plan_revision_id TEXT NOT NULL,
  target_plan_revision_sha256 TEXT NOT NULL CHECK(length(target_plan_revision_sha256)=64),
  target_topology_revision INTEGER NOT NULL CHECK(target_topology_revision>=1),
  target_topology_revision_sha256 TEXT NOT NULL CHECK(length(target_topology_revision_sha256)=64),
  target_authorization_id TEXT NOT NULL REFERENCES execution_authorizations_v1(authorization_id),
  target_authorization_sha256 TEXT NOT NULL CHECK(length(target_authorization_sha256)=64),
  target_baseline_sha256 TEXT NOT NULL CHECK(length(target_baseline_sha256)=64),
  target_input_closure_sha256 TEXT NOT NULL CHECK(length(target_input_closure_sha256)=64),
  source_binding_id TEXT NOT NULL,
  source_binding_sha256 TEXT NOT NULL CHECK(length(source_binding_sha256)=64),
  source_rollout_receipt_id TEXT NOT NULL,
  source_rollout_receipt_sha256 TEXT NOT NULL CHECK(length(source_rollout_receipt_sha256)=64),
  work_cell_semantics_sha256 TEXT NOT NULL CHECK(length(work_cell_semantics_sha256)=64),
  requirement_content_root_sha256 TEXT NOT NULL CHECK(length(requirement_content_root_sha256)=64),
  obligation_content_root_sha256 TEXT NOT NULL CHECK(length(obligation_content_root_sha256)=64),
  decision_content_root_sha256 TEXT NOT NULL CHECK(length(decision_content_root_sha256)=64),
  oracle_set_sha256 TEXT NOT NULL CHECK(length(oracle_set_sha256)=64),
  scope_sha256 TEXT NOT NULL CHECK(length(scope_sha256)=64),
  effect_policy_sha256 TEXT NOT NULL CHECK(length(effect_policy_sha256)=64),
  input_content_root_sha256 TEXT NOT NULL CHECK(length(input_content_root_sha256)=64),
  environment_sha256 TEXT NOT NULL CHECK(length(environment_sha256)=64),
  runtime_fingerprint_sha256 TEXT NOT NULL CHECK(length(runtime_fingerprint_sha256)=64),
  comparison_config_sha256 TEXT NOT NULL CHECK(length(comparison_config_sha256)=64),
  provider_profile_sha256 TEXT NOT NULL CHECK(length(provider_profile_sha256)=64),
  cache_epoch_sha256 TEXT NOT NULL CHECK(length(cache_epoch_sha256)=64),
  workload_key_sha256 TEXT NOT NULL CHECK(length(workload_key_sha256)=64),
  source_workload_key_sha256 TEXT NOT NULL CHECK(length(source_workload_key_sha256)=64),
  current_workload_key_sha256 TEXT NOT NULL CHECK(length(current_workload_key_sha256)=64),
  verdict TEXT NOT NULL CHECK(verdict='EXACT_MATCH'),
  selection_policy TEXT NOT NULL CHECK(selection_policy='LATEST_PRIOR_COMPLETE_V1'),
  predecessor_authority_head_sha256 TEXT NOT NULL CHECK(length(predecessor_authority_head_sha256)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  FOREIGN KEY(target_plan_revision_id,target_goal_id)
    REFERENCES plan_revisions_v2(plan_revision_id,goal_id),
  FOREIGN KEY(target_run_id,target_topology_revision)
    REFERENCES topology_revisions_v1(run_id,revision),
  FOREIGN KEY(source_binding_id,source_binding_sha256)
    REFERENCES strong_single_workload_bindings_v1(strong_single_workload_binding_id,record_sha256),
  UNIQUE(target_run_id,target_work_cell_id,target_authorization_sha256,workload_key_sha256),
  UNIQUE(workload_comparability_receipt_id,target_goal_id,target_run_id,target_work_cell_id,record_sha256)
) STRICT;

CREATE TRIGGER validate_workload_comparability_receipt_v1
BEFORE INSERT ON workload_comparability_receipts_v1
WHEN NOT EXISTS (
  SELECT 1
  FROM strong_single_workload_bindings_v1 source
  JOIN managed_run_heads_v1 head ON head.run_id=NEW.target_run_id
  JOIN topology_revisions_v1 topology
    ON topology.run_id=head.run_id AND topology.revision=head.topology_revision
  JOIN plan_revisions_v2 plan ON plan.plan_revision_id=NEW.target_plan_revision_id
  JOIN work_cells_v1 cell ON cell.work_cell_id=NEW.target_work_cell_id
  JOIN work_cell_heads_v1 cell_head ON cell_head.work_cell_id=cell.work_cell_id
  JOIN plan_subjects_v2 subject ON subject.plan_revision_id=plan.plan_revision_id
    AND subject.subject_kind='WORK_CELL' AND subject.subject_id=cell.logical_key
    AND subject.revision_sha256=cell.spec_sha256
  JOIN execution_authorizations_v1 authorization
    ON authorization.authorization_id=NEW.target_authorization_id
  JOIN workspace_baselines_v1 baseline ON baseline.baseline_id=authorization.baseline_id
  JOIN events event ON event.goal_id=NEW.target_goal_id
    AND event.event_sha256=NEW.predecessor_authority_head_sha256
  WHERE source.strong_single_workload_binding_id=NEW.source_binding_id
    AND source.record_sha256=NEW.source_binding_sha256
    AND source.source_rollout_receipt_id=NEW.source_rollout_receipt_id
    AND source.source_rollout_receipt_sha256=NEW.source_rollout_receipt_sha256
    AND source.created_at_ms<=NEW.created_at_ms
    AND head.status='ACTIVE' AND head.topology_revision=NEW.target_topology_revision
    AND head.requested_topology='MULTI'
    AND topology.requested_topology='MULTI'
    AND topology.record_sha256=NEW.target_topology_revision_sha256
    AND topology.config_sha256=NEW.comparison_config_sha256
    AND plan.goal_id=NEW.target_goal_id AND plan.record_sha256=NEW.target_plan_revision_sha256
    AND plan.input_closure_sha256=NEW.target_input_closure_sha256
    AND cell.goal_id=NEW.target_goal_id AND cell_head.status='RUNNING'
    AND authorization.goal_id=NEW.target_goal_id
    AND authorization.work_cell_id=NEW.target_work_cell_id
    AND authorization.record_sha256=NEW.target_authorization_sha256
    AND authorization.revoked_at_ms IS NULL
    AND baseline.record_sha256=NEW.target_baseline_sha256
    AND baseline.content_root_sha256=NEW.input_content_root_sha256
    AND baseline.environment_sha256=NEW.environment_sha256
    AND event.sequence=NEW.created_event_sequence-1
    AND NEW.work_cell_semantics_sha256=source.work_cell_semantics_sha256
    AND NEW.requirement_content_root_sha256=source.requirement_content_root_sha256
    AND NEW.obligation_content_root_sha256=source.obligation_content_root_sha256
    AND NEW.decision_content_root_sha256=source.decision_content_root_sha256
    AND NEW.oracle_set_sha256=source.oracle_set_sha256
    AND NEW.scope_sha256=source.scope_sha256
    AND NEW.effect_policy_sha256=source.effect_policy_sha256
    AND NEW.input_content_root_sha256=source.input_content_root_sha256
    AND NEW.environment_sha256=source.environment_sha256
    AND NEW.runtime_fingerprint_sha256=source.runtime_fingerprint_sha256
    AND NEW.comparison_config_sha256=source.comparison_config_sha256
    AND NEW.provider_profile_sha256=source.provider_profile_sha256
    AND NEW.cache_epoch_sha256=source.cache_epoch_sha256
    AND NEW.workload_key_sha256=source.workload_key_sha256
    AND NEW.source_workload_key_sha256=source.workload_key_sha256
    AND NEW.current_workload_key_sha256=source.workload_key_sha256
)
BEGIN SELECT RAISE(ABORT,'Workload comparability authority or dimension mismatch'); END;

CREATE INDEX ix_strong_single_workload_lookup_v1
  ON strong_single_workload_bindings_v1(workload_key_sha256,created_at_ms DESC,source_rollout_receipt_id);
CREATE INDEX ix_workload_comparability_target_v1
  ON workload_comparability_receipts_v1(target_run_id,target_work_cell_id,created_event_sequence);

CREATE TRIGGER no_update_strong_single_workload_bindings_v1
BEFORE UPDATE ON strong_single_workload_bindings_v1
BEGIN SELECT RAISE(ABORT,'Strong Single workload bindings V1 are immutable'); END;
CREATE TRIGGER no_delete_strong_single_workload_bindings_v1
BEFORE DELETE ON strong_single_workload_bindings_v1
BEGIN SELECT RAISE(ABORT,'Strong Single workload bindings V1 are immutable'); END;
CREATE TRIGGER no_update_workload_comparability_receipts_v1
BEFORE UPDATE ON workload_comparability_receipts_v1
BEGIN SELECT RAISE(ABORT,'Workload comparability receipts V1 are immutable'); END;
CREATE TRIGGER no_delete_workload_comparability_receipts_v1
BEFORE DELETE ON workload_comparability_receipts_v1
BEGIN SELECT RAISE(ABORT,'Workload comparability receipts V1 are immutable'); END;
