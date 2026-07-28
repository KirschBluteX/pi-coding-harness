-- Transaction ownership belongs to migrateTaskFlowStore so schema bytes and the
-- schema_migrations hash commit atomically.

CREATE TABLE task_flow_modes_v1 (
  goal_id TEXT PRIMARY KEY REFERENCES goals(goal_id),
  intent TEXT NOT NULL CHECK(intent IN ('PLAN','BUILD')),
  lane TEXT NOT NULL CHECK(lane IN ('DIRECT_CELL','ADAPTIVE_ROUTE')),
  source_intake_sha256 TEXT NOT NULL CHECK(length(source_intake_sha256)=64),
  activation_sha256 TEXT NOT NULL UNIQUE CHECK(length(activation_sha256)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0)
) STRICT;

CREATE TABLE task_flow_goal_heads_v1 (
  goal_id TEXT PRIMARY KEY REFERENCES goals(goal_id),
  status TEXT NOT NULL CHECK(status IN ('CONTRACTING','PLANNING','WAITING_USER','BUILDING','RECONCILING','SUCCEEDED','FAILED','CANCELED')),
  next_action_code TEXT NOT NULL CHECK(length(next_action_code) BETWEEN 1 AND 96),
  current_contract_id TEXT,
  current_route_id TEXT,
  current_work_cell_id TEXT,
  updated_event_sequence INTEGER NOT NULL CHECK(updated_event_sequence>=1)
) STRICT;

CREATE TABLE goal_contract_versions_v1 (
  contract_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  version INTEGER NOT NULL CHECK(version>=1),
  parent_contract_id TEXT REFERENCES goal_contract_versions_v1(contract_id),
  intent TEXT NOT NULL CHECK(intent IN ('PLAN','BUILD')),
  lane TEXT NOT NULL CHECK(lane IN ('DIRECT_CELL','ADAPTIVE_ROUTE')),
  objective TEXT NOT NULL CHECK(length(objective) BETWEEN 1 AND 32768),
  contract_json TEXT NOT NULL CHECK(json_valid(contract_json) AND json_type(contract_json)='object' AND length(contract_json)<=524288),
  obligation_set_sha256 TEXT NOT NULL CHECK(length(obligation_set_sha256)=64),
  source_intake_sha256 TEXT NOT NULL CHECK(length(source_intake_sha256)=64),
  authorization_ceiling TEXT NOT NULL CHECK(authorization_ceiling IN ('READ_ONLY','LOCAL_REVERSIBLE','EXTERNAL_IDEMPOTENT','IRREVERSIBLE_REQUIRES_USER')),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  UNIQUE(goal_id,version),
  CHECK((version=1 AND parent_contract_id IS NULL) OR (version>1 AND parent_contract_id IS NOT NULL))
) STRICT;

CREATE TABLE goal_contract_heads_v1 (
  goal_id TEXT PRIMARY KEY REFERENCES goals(goal_id),
  contract_id TEXT NOT NULL UNIQUE REFERENCES goal_contract_versions_v1(contract_id),
  version INTEGER NOT NULL CHECK(version>=1),
  contract_sha256 TEXT NOT NULL CHECK(length(contract_sha256)=64),
  updated_event_sequence INTEGER NOT NULL CHECK(updated_event_sequence>=1)
) STRICT;

CREATE TABLE task_obligations_v1 (
  obligation_id TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL REFERENCES goal_contract_versions_v1(contract_id),
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  semantic_key TEXT NOT NULL CHECK(length(semantic_key) BETWEEN 1 AND 160),
  priority TEXT NOT NULL CHECK(priority IN ('MUST','SHOULD','MAY')),
  statement TEXT NOT NULL CHECK(length(statement) BETWEEN 1 AND 32768),
  oracle_json TEXT NOT NULL CHECK(json_valid(oracle_json) AND json_type(oracle_json)='object' AND length(oracle_json)<=65536),
  dependencies_json TEXT NOT NULL CHECK(json_valid(dependencies_json) AND json_type(dependencies_json)='array' AND length(dependencies_json)<=65536),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 4095),
  UNIQUE(contract_id,semantic_key),
  UNIQUE(contract_id,ordinal)
) STRICT;

CREATE TABLE task_decision_entries_v1 (
  decision_entry_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  contract_id TEXT REFERENCES goal_contract_versions_v1(contract_id),
  route_id TEXT,
  decision_key TEXT NOT NULL CHECK(length(decision_key) BETWEEN 1 AND 160),
  authority_actor TEXT NOT NULL CHECK(authority_actor IN ('USER','RUNTIME')),
  materiality TEXT NOT NULL CHECK(materiality IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  reversible INTEGER NOT NULL CHECK(reversible IN (0,1)),
  privacy_related INTEGER NOT NULL CHECK(privacy_related IN (0,1)),
  question_hmac TEXT NOT NULL CHECK(length(question_hmac)=64),
  recommendation_json TEXT NOT NULL CHECK(json_valid(recommendation_json) AND json_type(recommendation_json)='object' AND length(recommendation_json)<=32768),
  selection_json TEXT CHECK(selection_json IS NULL OR (json_valid(selection_json) AND json_type(selection_json)='object' AND length(selection_json)<=32768)),
  state TEXT NOT NULL CHECK(state IN ('OPEN','RESOLVED','EXPIRED','CANCELED','SUPERSEDED')),
  binding_sha256 TEXT NOT NULL CHECK(length(binding_sha256)=64),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  expires_at_ms INTEGER CHECK(expires_at_ms IS NULL OR expires_at_ms>created_at_ms),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  UNIQUE(goal_id,decision_key,binding_sha256,state)
) STRICT;

CREATE TABLE workspace_baselines_v1 (
  baseline_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  filesystem_identity_hmac TEXT NOT NULL CHECK(length(filesystem_identity_hmac)=64),
  content_root_sha256 TEXT NOT NULL CHECK(length(content_root_sha256)=64),
  environment_sha256 TEXT NOT NULL CHECK(length(environment_sha256)=64),
  oracle_set_sha256 TEXT NOT NULL CHECK(length(oracle_set_sha256)=64),
  scope_manifest_json TEXT NOT NULL CHECK(json_valid(scope_manifest_json) AND json_type(scope_manifest_json)='array' AND length(scope_manifest_json)<=262144),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1)
) STRICT;

CREATE TABLE route_skeleton_versions_v1 (
  route_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  contract_id TEXT NOT NULL REFERENCES goal_contract_versions_v1(contract_id),
  revision INTEGER NOT NULL CHECK(revision>=1),
  parent_route_id TEXT REFERENCES route_skeleton_versions_v1(route_id),
  lane TEXT NOT NULL CHECK(lane IN ('DIRECT_CELL','ADAPTIVE_ROUTE')),
  route_json TEXT NOT NULL CHECK(json_valid(route_json) AND json_type(route_json)='object' AND length(route_json)<=524288),
  acceptance_coverage_sha256 TEXT NOT NULL CHECK(length(acceptance_coverage_sha256)=64),
  assumptions_sha256 TEXT NOT NULL CHECK(length(assumptions_sha256)=64),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  UNIQUE(goal_id,revision),
  CHECK((revision=1 AND parent_route_id IS NULL) OR (revision>1 AND parent_route_id IS NOT NULL))
) STRICT;

CREATE TABLE route_skeleton_heads_v1 (
  goal_id TEXT PRIMARY KEY REFERENCES goals(goal_id),
  route_id TEXT NOT NULL UNIQUE REFERENCES route_skeleton_versions_v1(route_id),
  revision INTEGER NOT NULL CHECK(revision>=1),
  route_sha256 TEXT NOT NULL CHECK(length(route_sha256)=64),
  health TEXT NOT NULL CHECK(health IN ('HEALTHY','DEGRADED','INVALID','RECONCILING','WAITING_USER')),
  updated_event_sequence INTEGER NOT NULL CHECK(updated_event_sequence>=1)
) STRICT;

CREATE TABLE commitment_points_v1 (
  commitment_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  route_id TEXT NOT NULL REFERENCES route_skeleton_versions_v1(route_id),
  commitment_key TEXT NOT NULL CHECK(length(commitment_key) BETWEEN 1 AND 160),
  decision_sha256 TEXT NOT NULL CHECK(length(decision_sha256)=64),
  reversible INTEGER NOT NULL CHECK(reversible IN (0,1)),
  user_decision_entry_id TEXT REFERENCES task_decision_entries_v1(decision_entry_id),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  UNIQUE(route_id,commitment_key)
) STRICT;

CREATE TABLE work_cells_v1 (
  work_cell_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  contract_id TEXT NOT NULL REFERENCES goal_contract_versions_v1(contract_id),
  route_id TEXT NOT NULL REFERENCES route_skeleton_versions_v1(route_id),
  logical_key TEXT NOT NULL CHECK(length(logical_key) BETWEEN 1 AND 160),
  ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 4095),
  horizon TEXT NOT NULL CHECK(horizon IN ('CURRENT','NEAR','LATER')),
  outcome TEXT NOT NULL CHECK(length(outcome) BETWEEN 1 AND 32768),
  obligation_ids_json TEXT NOT NULL CHECK(json_valid(obligation_ids_json) AND json_type(obligation_ids_json)='array' AND length(obligation_ids_json)<=65536),
  read_roots_json TEXT NOT NULL CHECK(json_valid(read_roots_json) AND json_type(read_roots_json)='array' AND length(read_roots_json)<=131072),
  write_roots_json TEXT NOT NULL CHECK(json_valid(write_roots_json) AND json_type(write_roots_json)='array' AND length(write_roots_json)<=131072),
  effect_classes_json TEXT NOT NULL CHECK(json_valid(effect_classes_json) AND json_type(effect_classes_json)='array' AND length(effect_classes_json)<=8192),
  oracle_json TEXT NOT NULL CHECK(json_valid(oracle_json) AND json_type(oracle_json)='object' AND length(oracle_json)<=65536),
  risk TEXT NOT NULL CHECK(risk IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  reversible INTEGER NOT NULL CHECK(reversible IN (0,1)),
  budget_json TEXT NOT NULL CHECK(json_valid(budget_json) AND json_type(budget_json)='object' AND length(budget_json)<=32768),
  spec_sha256 TEXT NOT NULL UNIQUE CHECK(length(spec_sha256)=64),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  UNIQUE(route_id,logical_key),
  UNIQUE(route_id,ordinal)
) STRICT;

CREATE TABLE work_cell_dependencies_v1 (
  route_id TEXT NOT NULL REFERENCES route_skeleton_versions_v1(route_id),
  work_cell_id TEXT NOT NULL REFERENCES work_cells_v1(work_cell_id),
  depends_on_work_cell_id TEXT NOT NULL REFERENCES work_cells_v1(work_cell_id),
  PRIMARY KEY(route_id,work_cell_id,depends_on_work_cell_id),
  CHECK(work_cell_id<>depends_on_work_cell_id)
) WITHOUT ROWID, STRICT;

CREATE TABLE work_cell_heads_v1 (
  work_cell_id TEXT PRIMARY KEY REFERENCES work_cells_v1(work_cell_id),
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  route_id TEXT NOT NULL REFERENCES route_skeleton_versions_v1(route_id),
  status TEXT NOT NULL CHECK(status IN ('PROPOSED','READY','RUNNING','WAITING_USER','REPAIRING','SUCCEEDED','INVALIDATED','FAILED')),
  attempt_count INTEGER NOT NULL CHECK(attempt_count>=0),
  last_progress_sha256 TEXT CHECK(last_progress_sha256 IS NULL OR length(last_progress_sha256)=64),
  updated_event_sequence INTEGER NOT NULL CHECK(updated_event_sequence>=1)
) STRICT;

CREATE UNIQUE INDEX one_running_work_cell_per_goal_v1
  ON work_cell_heads_v1(goal_id) WHERE status='RUNNING';

CREATE TABLE execution_authorizations_v1 (
  authorization_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  contract_id TEXT NOT NULL REFERENCES goal_contract_versions_v1(contract_id),
  route_id TEXT NOT NULL REFERENCES route_skeleton_versions_v1(route_id),
  work_cell_id TEXT NOT NULL REFERENCES work_cells_v1(work_cell_id),
  baseline_id TEXT NOT NULL REFERENCES workspace_baselines_v1(baseline_id),
  lease_generation INTEGER NOT NULL CHECK(lease_generation>=1),
  fencing_token INTEGER NOT NULL CHECK(fencing_token>=1),
  effect_ceiling TEXT NOT NULL CHECK(effect_ceiling IN ('READ_ONLY','LOCAL_REVERSIBLE','EXTERNAL_IDEMPOTENT','IRREVERSIBLE_REQUIRES_USER')),
  decision_closure_sha256 TEXT NOT NULL CHECK(length(decision_closure_sha256)=64),
  allowed_scope_sha256 TEXT NOT NULL CHECK(length(allowed_scope_sha256)=64),
  expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms>=0),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  revoked_at_ms INTEGER CHECK(revoked_at_ms IS NULL OR revoked_at_ms>=created_at_ms),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1)
) STRICT;

CREATE UNIQUE INDEX one_live_execution_authorization_v1
  ON execution_authorizations_v1(goal_id) WHERE revoked_at_ms IS NULL;

CREATE TABLE operation_attempts_v1 (
  attempt_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  work_cell_id TEXT NOT NULL REFERENCES work_cells_v1(work_cell_id),
  authorization_id TEXT NOT NULL REFERENCES execution_authorizations_v1(authorization_id),
  attempt_number INTEGER NOT NULL CHECK(attempt_number>=1),
  operation_kind TEXT NOT NULL CHECK(operation_kind IN ('READ','WRITE','EDIT','DELETE','MOVE','COMMAND','VALIDATION','EXTERNAL')),
  normalized_target_hmac TEXT NOT NULL CHECK(length(normalized_target_hmac)=64),
  normalized_payload_sha256 TEXT NOT NULL CHECK(length(normalized_payload_sha256)=64),
  execution_fingerprint_sha256 TEXT NOT NULL CHECK(length(execution_fingerprint_sha256)=64),
  baseline_sha256 TEXT NOT NULL CHECK(length(baseline_sha256)=64),
  environment_sha256 TEXT NOT NULL CHECK(length(environment_sha256)=64),
  oracle_sha256 TEXT NOT NULL CHECK(length(oracle_sha256)=64),
  idempotency_key_hmac TEXT NOT NULL CHECK(length(idempotency_key_hmac)=64),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  UNIQUE(operation_id,attempt_number),
  UNIQUE(work_cell_id,execution_fingerprint_sha256,attempt_number)
) STRICT;

CREATE TABLE operation_reconcile_locators_v1 (
  locator_id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL UNIQUE REFERENCES operation_attempts_v1(attempt_id),
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  target_relative TEXT NOT NULL CHECK(length(target_relative) BETWEEN 1 AND 4096),
  preimage_sha256 TEXT NOT NULL CHECK(length(preimage_sha256)=64),
  expected_postimage_sha256 TEXT CHECK(expected_postimage_sha256 IS NULL OR length(expected_postimage_sha256)=64),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1)
) STRICT;

CREATE TABLE operation_transitions_v1 (
  transition_id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES operation_attempts_v1(attempt_id),
  ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 32),
  state TEXT NOT NULL CHECK(state IN ('PREPARED','DISPATCHED','OBSERVED','COMMITTED','FAILED','OUTCOME_UNKNOWN','RECONCILED')),
  output_sha256 TEXT CHECK(output_sha256 IS NULL OR length(output_sha256)=64),
  readback_sha256 TEXT CHECK(readback_sha256 IS NULL OR length(readback_sha256)=64),
  failure_signature_sha256 TEXT CHECK(failure_signature_sha256 IS NULL OR length(failure_signature_sha256)=64),
  postcondition TEXT NOT NULL CHECK(postcondition IN ('PASS','FAIL','UNKNOWN','NOT_APPLICABLE')),
  predecessor_sha256 TEXT CHECK(predecessor_sha256 IS NULL OR length(predecessor_sha256)=64),
  transition_sha256 TEXT NOT NULL UNIQUE CHECK(length(transition_sha256)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1),
  UNIQUE(attempt_id,ordinal),
  CHECK((ordinal=0 AND state='PREPARED' AND predecessor_sha256 IS NULL) OR (ordinal>0 AND predecessor_sha256 IS NOT NULL))
) STRICT;

CREATE TABLE operation_heads_v1 (
  attempt_id TEXT PRIMARY KEY REFERENCES operation_attempts_v1(attempt_id),
  operation_id TEXT NOT NULL,
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  work_cell_id TEXT NOT NULL REFERENCES work_cells_v1(work_cell_id),
  ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 32),
  state TEXT NOT NULL CHECK(state IN ('PREPARED','DISPATCHED','OBSERVED','COMMITTED','FAILED','OUTCOME_UNKNOWN','RECONCILED')),
  transition_sha256 TEXT NOT NULL CHECK(length(transition_sha256)=64),
  updated_event_sequence INTEGER NOT NULL CHECK(updated_event_sequence>=1)
) STRICT;

CREATE UNIQUE INDEX one_unresolved_operation_per_identity_v1
  ON operation_heads_v1(goal_id,operation_id)
  WHERE state IN ('PREPARED','DISPATCHED','OBSERVED','OUTCOME_UNKNOWN');

CREATE TABLE evidence_attestations_v1 (
  attestation_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  work_cell_id TEXT REFERENCES work_cells_v1(work_cell_id),
  operation_id TEXT,
  obligation_id TEXT REFERENCES task_obligations_v1(obligation_id),
  oracle_sha256 TEXT NOT NULL CHECK(length(oracle_sha256)=64),
  input_closure_sha256 TEXT NOT NULL CHECK(length(input_closure_sha256)=64),
  output_sha256 TEXT NOT NULL CHECK(length(output_sha256)=64),
  baseline_sha256 TEXT NOT NULL CHECK(length(baseline_sha256)=64),
  environment_sha256 TEXT NOT NULL CHECK(length(environment_sha256)=64),
  result TEXT NOT NULL CHECK(result IN ('PASS','FAIL','UNKNOWN')),
  freshness TEXT NOT NULL CHECK(freshness IN ('CURRENT','STALE','UNKNOWN')),
  postcondition TEXT NOT NULL CHECK(postcondition IN ('PASS','FAIL','UNKNOWN','NOT_APPLICABLE')),
  artifact_id TEXT REFERENCES artifacts(artifact_id),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1)
) STRICT;

CREATE TABLE route_health_records_v1 (
  health_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  route_id TEXT NOT NULL REFERENCES route_skeleton_versions_v1(route_id),
  work_cell_id TEXT REFERENCES work_cells_v1(work_cell_id),
  trigger_sha256 TEXT NOT NULL CHECK(length(trigger_sha256)=64),
  failure_signature_sha256 TEXT CHECK(failure_signature_sha256 IS NULL OR length(failure_signature_sha256)=64),
  occurrence INTEGER NOT NULL CHECK(occurrence>=0),
  level TEXT NOT NULL CHECK(level IN ('H0_CONTINUE','H1_RETRY','H2_REPAIR','H3_REFRAME','H4_ASK','H5_RECONCILE_OR_STOP')),
  reason_code TEXT NOT NULL CHECK(length(reason_code) BETWEEN 1 AND 160),
  selected_route_id TEXT REFERENCES route_skeleton_versions_v1(route_id),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1)
) STRICT;

CREATE TABLE task_invalidations_v1 (
  invalidation_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  target_kind TEXT NOT NULL CHECK(target_kind IN ('CONTRACT','ROUTE','WORK_CELL','OPERATION','EVIDENCE','ARTIFACT','ASSUMPTION','AUTHORIZATION')),
  target_id TEXT NOT NULL CHECK(length(target_id) BETWEEN 1 AND 160),
  reason_code TEXT NOT NULL CHECK(length(reason_code) BETWEEN 1 AND 160),
  evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256)=64),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1)
) STRICT;

CREATE TABLE task_flow_activities_v1 (
  activity_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  subject_kind TEXT NOT NULL CHECK(subject_kind IN ('GOAL','CONTRACT','ROUTE','WORK_CELL','OPERATION','EVIDENCE','DECISION','DELIVERABLE')),
  subject_id TEXT NOT NULL CHECK(length(subject_id) BETWEEN 1 AND 160),
  activity_type TEXT NOT NULL CHECK(length(activity_type) BETWEEN 1 AND 160),
  detail_sha256 TEXT NOT NULL CHECK(length(detail_sha256)=64),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1)
) STRICT;

CREATE TABLE deliverable_manifests_v1 (
  deliverable_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL UNIQUE REFERENCES goals(goal_id),
  contract_id TEXT NOT NULL REFERENCES goal_contract_versions_v1(contract_id),
  route_id TEXT NOT NULL REFERENCES route_skeleton_versions_v1(route_id),
  final_baseline_id TEXT NOT NULL REFERENCES workspace_baselines_v1(baseline_id),
  obligation_closure_sha256 TEXT NOT NULL CHECK(length(obligation_closure_sha256)=64),
  evidence_root_sha256 TEXT NOT NULL CHECK(length(evidence_root_sha256)=64),
  artifact_manifest_json TEXT NOT NULL CHECK(json_valid(artifact_manifest_json) AND json_type(artifact_manifest_json)='array' AND length(artifact_manifest_json)<=262144),
  result TEXT NOT NULL CHECK(result IN ('SUCCEEDED','FAILED','CANCELED')),
  record_sha256 TEXT NOT NULL UNIQUE CHECK(length(record_sha256)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  created_event_sequence INTEGER NOT NULL CHECK(created_event_sequence>=1)
) STRICT;

CREATE TRIGGER no_update_task_flow_modes_v1 BEFORE UPDATE ON task_flow_modes_v1 BEGIN SELECT RAISE(ABORT,'Task Flow mode records are immutable'); END;
CREATE TRIGGER no_delete_task_flow_modes_v1 BEFORE DELETE ON task_flow_modes_v1 BEGIN SELECT RAISE(ABORT,'Task Flow mode records are immutable'); END;
CREATE TRIGGER no_update_goal_contract_versions_v1 BEFORE UPDATE ON goal_contract_versions_v1 BEGIN SELECT RAISE(ABORT,'GoalContract versions are immutable'); END;
CREATE TRIGGER no_delete_goal_contract_versions_v1 BEFORE DELETE ON goal_contract_versions_v1 BEGIN SELECT RAISE(ABORT,'GoalContract versions are immutable'); END;
CREATE TRIGGER no_update_task_obligations_v1 BEFORE UPDATE ON task_obligations_v1 BEGIN SELECT RAISE(ABORT,'Task obligations are immutable'); END;
CREATE TRIGGER no_delete_task_obligations_v1 BEFORE DELETE ON task_obligations_v1 BEGIN SELECT RAISE(ABORT,'Task obligations are immutable'); END;
CREATE TRIGGER no_update_task_decision_entries_v1 BEFORE UPDATE ON task_decision_entries_v1 BEGIN SELECT RAISE(ABORT,'Task decisions are immutable'); END;
CREATE TRIGGER no_delete_task_decision_entries_v1 BEFORE DELETE ON task_decision_entries_v1 BEGIN SELECT RAISE(ABORT,'Task decisions are immutable'); END;
CREATE TRIGGER no_update_workspace_baselines_v1 BEFORE UPDATE ON workspace_baselines_v1 BEGIN SELECT RAISE(ABORT,'Workspace baselines are immutable'); END;
CREATE TRIGGER no_delete_workspace_baselines_v1 BEFORE DELETE ON workspace_baselines_v1 BEGIN SELECT RAISE(ABORT,'Workspace baselines are immutable'); END;
CREATE TRIGGER no_update_route_skeleton_versions_v1 BEFORE UPDATE ON route_skeleton_versions_v1 BEGIN SELECT RAISE(ABORT,'RouteSkeleton versions are immutable'); END;
CREATE TRIGGER no_delete_route_skeleton_versions_v1 BEFORE DELETE ON route_skeleton_versions_v1 BEGIN SELECT RAISE(ABORT,'RouteSkeleton versions are immutable'); END;
CREATE TRIGGER no_update_commitment_points_v1 BEFORE UPDATE ON commitment_points_v1 BEGIN SELECT RAISE(ABORT,'Commitment points are immutable'); END;
CREATE TRIGGER no_delete_commitment_points_v1 BEFORE DELETE ON commitment_points_v1 BEGIN SELECT RAISE(ABORT,'Commitment points are immutable'); END;
CREATE TRIGGER no_update_work_cells_v1 BEFORE UPDATE ON work_cells_v1 BEGIN SELECT RAISE(ABORT,'WorkCells are immutable'); END;
CREATE TRIGGER no_delete_work_cells_v1 BEFORE DELETE ON work_cells_v1 BEGIN SELECT RAISE(ABORT,'WorkCells are immutable'); END;
CREATE TRIGGER no_update_work_cell_dependencies_v1 BEFORE UPDATE ON work_cell_dependencies_v1 BEGIN SELECT RAISE(ABORT,'WorkCell dependencies are immutable'); END;
CREATE TRIGGER no_delete_work_cell_dependencies_v1 BEFORE DELETE ON work_cell_dependencies_v1 BEGIN SELECT RAISE(ABORT,'WorkCell dependencies are immutable'); END;
CREATE TRIGGER no_delete_execution_authorizations_v1 BEFORE DELETE ON execution_authorizations_v1 BEGIN SELECT RAISE(ABORT,'Execution authorizations cannot be deleted'); END;
CREATE TRIGGER limit_execution_authorization_update_v1 BEFORE UPDATE ON execution_authorizations_v1
  WHEN OLD.revoked_at_ms IS NOT NULL OR NEW.authorization_id<>OLD.authorization_id OR NEW.goal_id<>OLD.goal_id
    OR NEW.contract_id<>OLD.contract_id OR NEW.route_id<>OLD.route_id OR NEW.work_cell_id<>OLD.work_cell_id
    OR NEW.baseline_id<>OLD.baseline_id OR NEW.lease_generation<>OLD.lease_generation
    OR NEW.fencing_token<>OLD.fencing_token OR NEW.effect_ceiling<>OLD.effect_ceiling
    OR NEW.decision_closure_sha256<>OLD.decision_closure_sha256 OR NEW.allowed_scope_sha256<>OLD.allowed_scope_sha256
    OR NEW.expires_at_ms<>OLD.expires_at_ms OR NEW.record_sha256<>OLD.record_sha256
    OR NEW.created_at_ms<>OLD.created_at_ms OR NEW.created_event_sequence<>OLD.created_event_sequence
  BEGIN SELECT RAISE(ABORT,'Execution authorization may only be revoked once'); END;
CREATE TRIGGER no_update_operation_attempts_v1 BEFORE UPDATE ON operation_attempts_v1 BEGIN SELECT RAISE(ABORT,'Operation attempts are immutable'); END;
CREATE TRIGGER no_delete_operation_attempts_v1 BEFORE DELETE ON operation_attempts_v1 BEGIN SELECT RAISE(ABORT,'Operation attempts are immutable'); END;
CREATE TRIGGER no_update_operation_reconcile_locators_v1 BEFORE UPDATE ON operation_reconcile_locators_v1 BEGIN SELECT RAISE(ABORT,'Operation reconcile locators are immutable'); END;
CREATE TRIGGER no_delete_operation_reconcile_locators_v1 BEFORE DELETE ON operation_reconcile_locators_v1 BEGIN SELECT RAISE(ABORT,'Operation reconcile locators are immutable'); END;
CREATE TRIGGER no_update_operation_transitions_v1 BEFORE UPDATE ON operation_transitions_v1 BEGIN SELECT RAISE(ABORT,'Operation transitions are immutable'); END;
CREATE TRIGGER no_delete_operation_transitions_v1 BEFORE DELETE ON operation_transitions_v1 BEGIN SELECT RAISE(ABORT,'Operation transitions are immutable'); END;
CREATE TRIGGER no_update_evidence_attestations_v1 BEFORE UPDATE ON evidence_attestations_v1 BEGIN SELECT RAISE(ABORT,'Evidence attestations are immutable'); END;
CREATE TRIGGER no_delete_evidence_attestations_v1 BEFORE DELETE ON evidence_attestations_v1 BEGIN SELECT RAISE(ABORT,'Evidence attestations are immutable'); END;
CREATE TRIGGER no_update_route_health_records_v1 BEFORE UPDATE ON route_health_records_v1 BEGIN SELECT RAISE(ABORT,'Route health records are immutable'); END;
CREATE TRIGGER no_delete_route_health_records_v1 BEFORE DELETE ON route_health_records_v1 BEGIN SELECT RAISE(ABORT,'Route health records are immutable'); END;
CREATE TRIGGER no_update_task_invalidations_v1 BEFORE UPDATE ON task_invalidations_v1 BEGIN SELECT RAISE(ABORT,'Task invalidations are immutable'); END;
CREATE TRIGGER no_delete_task_invalidations_v1 BEFORE DELETE ON task_invalidations_v1 BEGIN SELECT RAISE(ABORT,'Task invalidations are immutable'); END;
CREATE TRIGGER no_update_task_flow_activities_v1 BEFORE UPDATE ON task_flow_activities_v1 BEGIN SELECT RAISE(ABORT,'Task Flow activities are immutable'); END;
CREATE TRIGGER no_delete_task_flow_activities_v1 BEFORE DELETE ON task_flow_activities_v1 BEGIN SELECT RAISE(ABORT,'Task Flow activities are immutable'); END;
CREATE TRIGGER no_update_deliverable_manifests_v1 BEFORE UPDATE ON deliverable_manifests_v1 BEGIN SELECT RAISE(ABORT,'Deliverable manifests are immutable'); END;
CREATE TRIGGER no_delete_deliverable_manifests_v1 BEFORE DELETE ON deliverable_manifests_v1 BEGIN SELECT RAISE(ABORT,'Deliverable manifests are immutable'); END;
